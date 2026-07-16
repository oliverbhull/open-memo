use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(120);
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub struct TranscriptionEngine(NemotronEngine);

impl TranscriptionEngine {
    pub fn from_env(input_sample_rate: u32) -> Result<Self> {
        Ok(Self(NemotronEngine::new(input_sample_rate)?))
    }

    pub fn name(&self) -> &'static str {
        "Nemotron"
    }

    pub fn is_nemotron(&self) -> bool {
        true
    }

    pub fn warmup(&self) -> Result<()> {
        Ok(())
    }

    pub fn set_prompt(&mut self, _prompt: Option<String>) {
        // Nemotron's streaming ONNX runtime has no prompt input. Memo still
        // applies its normal command detection and phrase replacements.
    }

    pub fn begin_live_stream(&mut self) -> Result<()> {
        self.0.begin_live_stream()
    }

    pub fn feed_live_audio(&mut self, samples: &[i16]) -> Result<()> {
        self.0.feed_live_audio(samples)
    }

    pub fn abort_live_stream(&mut self) {
        self.0.abort_live_stream();
    }

    pub fn transcribe(&mut self, samples: &[i16]) -> Result<String> {
        self.0.finish_transcription(samples)
    }
}

pub struct NemotronEngine {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<String>,
    resampler: StreamingResampler,
    session_active: bool,
    streamed_input_samples: usize,
}

impl NemotronEngine {
    fn new(input_sample_rate: u32) -> Result<Self> {
        let python = required_path("MEMO_ASR_PYTHON")?;
        let script = required_path("MEMO_ASR_SCRIPT")?;
        let model = required_path("MEMO_ASR_MODEL_PATH")?;

        if !python.is_file() {
            return Err(Error(format!(
                "Nemotron Python runtime not found: {}",
                python.display()
            )));
        }
        if !script.is_file() {
            return Err(Error(format!(
                "Nemotron worker script not found: {}",
                script.display()
            )));
        }
        if !model.is_dir() {
            return Err(Error(format!(
                "Nemotron model not found: {}",
                model.display()
            )));
        }

        let mut child = Command::new(&python)
            .arg(&script)
            .arg("--model-path")
            .arg(&model)
            .arg("--worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error(format!("Failed to launch bundled Nemotron worker: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error("Failed to open Nemotron worker stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error("Failed to open Nemotron worker stdout".to_string()))?;
        let (response_tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if line.starts_with("PARTIAL:") {
                    continue;
                }
                if response_tx.send(line).is_err() {
                    break;
                }
            }
        });

        let ready = responses
            .recv_timeout(WORKER_READY_TIMEOUT)
            .map_err(|e| Error(format!("Failed waiting for Nemotron worker: {e}")))?;
        if ready.trim() != "READY" {
            let status = child.try_wait().ok().flatten();
            return Err(Error(format!(
                "Nemotron worker did not become ready (line={:?}, status={status:?})",
                ready.trim()
            )));
        }

        eprintln!(
            "Nemotron worker ready (python={}, script={}, model={})",
            python.display(),
            script.display(),
            model.display()
        );

        Ok(Self {
            child,
            stdin,
            responses,
            resampler: StreamingResampler::new(input_sample_rate, TARGET_SAMPLE_RATE),
            session_active: false,
            streamed_input_samples: 0,
        })
    }

    fn begin_live_stream(&mut self) -> Result<()> {
        if self.session_active {
            let _ = self.send_message(json!({ "type": "abort" }));
        }
        self.resampler.reset();
        self.streamed_input_samples = 0;
        self.send_message(json!({ "type": "start" }))?;
        self.session_active = true;
        Ok(())
    }

    fn feed_live_audio(&mut self, samples: &[i16]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        if !self.session_active {
            self.begin_live_stream()?;
        }
        let pcm_16khz = self.resampler.push(samples, false);
        self.send_audio(&pcm_16khz)?;
        self.streamed_input_samples += samples.len();
        Ok(())
    }

    fn finish_transcription(&mut self, full_utterance: &[i16]) -> Result<String> {
        if !self.session_active {
            self.begin_live_stream()?;
        }

        let already_streamed = self.streamed_input_samples.min(full_utterance.len());
        let remaining = &full_utterance[already_streamed..];
        if !remaining.is_empty() {
            let pcm_16khz = self.resampler.push(remaining, false);
            self.send_audio(&pcm_16khz)?;
            self.streamed_input_samples += remaining.len();
        }
        let tail = self.resampler.push(&[], true);
        self.send_audio(&tail)?;
        self.send_message(json!({ "type": "end" }))?;
        self.session_active = false;
        self.streamed_input_samples = 0;

        loop {
            let line = match self.responses.recv_timeout(TRANSCRIPTION_TIMEOUT) {
                Ok(line) => line,
                Err(error) => {
                    let status = self.child.try_wait().ok().flatten();
                    return Err(Error(format!(
                        "Nemotron worker did not return a transcript ({error}; status={status:?})"
                    )));
                }
            };
            let line = line.trim();
            if let Some(message) = line.strip_prefix("ERROR:") {
                return Err(Error(format!("Nemotron transcription failed: {message}")));
            }
            if let Some(payload) = line.strip_prefix("FINAL:") {
                let parsed: Value = serde_json::from_str(payload)
                    .map_err(|e| Error(format!("Invalid Nemotron FINAL payload: {e}")))?;
                return Ok(parsed
                    .get("processedText")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string());
            }
        }
    }

    fn abort_live_stream(&mut self) {
        if self.session_active {
            let _ = self.send_message(json!({ "type": "abort" }));
        }
        self.session_active = false;
        self.streamed_input_samples = 0;
        self.resampler.reset();
    }

    fn send_audio(&mut self, samples: &[i16]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        self.send_message(json!({
            "type": "audio",
            "pcm16le": STANDARD.encode(pcm),
        }))
    }

    fn send_message(&mut self, message: Value) -> Result<()> {
        let line = message.to_string();
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| Error(format!("Failed sending audio to Nemotron worker: {e}")))
    }
}

impl Drop for NemotronEngine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct StreamingResampler {
    from_rate: u32,
    to_rate: u32,
    buffer: Vec<i16>,
    position: f64,
}

impl StreamingResampler {
    fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            from_rate,
            to_rate,
            buffer: Vec::new(),
            position: 0.0,
        }
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.position = 0.0;
    }

    fn push(&mut self, samples: &[i16], finish: bool) -> Vec<i16> {
        if self.from_rate == self.to_rate {
            return samples.to_vec();
        }
        self.buffer.extend_from_slice(samples);
        let ratio = self.from_rate as f64 / self.to_rate as f64;
        let mut output = Vec::new();

        while !self.buffer.is_empty()
            && if finish {
                self.position < self.buffer.len() as f64
            } else {
                self.position + 1.0 < self.buffer.len() as f64
            }
        {
            let i0 = self.position.floor() as usize;
            let i1 = (i0 + 1).min(self.buffer.len() - 1);
            let fraction = self.position - i0 as f64;
            let sample =
                self.buffer[i0] as f64 * (1.0 - fraction) + self.buffer[i1] as f64 * fraction;
            output.push(sample.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
            self.position += ratio;
        }

        if !self.buffer.is_empty() {
            let discard = (self.position.floor() as usize).min(self.buffer.len() - 1);
            if discard > 0 {
                self.buffer.drain(..discard);
                self.position -= discard as f64;
            }
        }
        if finish {
            self.reset();
        }
        output
    }
}

fn required_path(name: &str) -> Result<PathBuf> {
    let value = env::var(name).map_err(|_| {
        Error(format!(
            "{name} is required for the bundled Nemotron backend"
        ))
    })?;
    if value.trim().is_empty() {
        return Err(Error(format!("{name} cannot be empty")));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_resampler_preserves_length_across_uneven_chunks() {
        let input: Vec<i16> = (0..48_000).map(|i| (i % 30_000) as i16).collect();
        let mut resampler = StreamingResampler::new(48_000, 16_000);
        let mut output = Vec::new();
        for chunk in input.chunks(997) {
            output.extend(resampler.push(chunk, false));
        }
        output.extend(resampler.push(&[], true));

        assert_eq!(output.len(), 16_000);
    }

    #[test]
    fn native_rate_stream_is_unchanged() {
        let mut resampler = StreamingResampler::new(16_000, 16_000);
        assert_eq!(resampler.push(&[1, -2, 3], false), vec![1, -2, 3]);
    }
}

use base64::{engine::general_purpose::STANDARD, Engine as _};
use memo_dictation::{Error, Result};
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

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn validate_windows_cpu_features(features: [bool; 4]) -> Result<()> {
    let required = ["AVX2", "FMA", "F16C", "BMI2"];
    let missing: Vec<_> = required.into_iter().zip(features).filter_map(|(name, supported)| (!supported).then_some(name)).collect();
    if missing.is_empty() { return Ok(()); }
    Err(Error(format!(
        "This Windows build of Memo requires an x86-64-v3 CPU with AVX2, FMA, F16C and BMI2 support. Missing CPU features: {}. This computer cannot run the bundled speech models.",
        missing.join(", ")
    )))
}

pub enum TranscriptionEngine {
    Worker(WorkerEngine),
    Nemotron(crate::nemotron_engine::NemotronEngine),
    Whisper(crate::whisper_engine::WhisperEngine),
}

impl TranscriptionEngine {
    pub fn from_env(input_sample_rate: u32) -> Result<Self> {
        let backend = env::var("MEMO_ASR_BACKEND")
            .unwrap_or_else(|_| "conomo".to_string())
            .to_lowercase();
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        if matches!(backend.as_str(), "whisper" | "nemotron") {
            validate_windows_cpu_features([
                std::is_x86_feature_detected!("avx2"),
                std::is_x86_feature_detected!("fma"),
                std::is_x86_feature_detected!("f16c"),
                std::is_x86_feature_detected!("bmi2"),
            ])?;
        }
        match backend.as_str() {
            "nemotron" => Ok(Self::Nemotron(crate::nemotron_engine::NemotronEngine::new(
                input_sample_rate,
            )?)),
            "conomo" => Ok(Self::Worker(WorkerEngine::new(input_sample_rate)?)),
            "whisper" => Ok(Self::Whisper(crate::whisper_engine::WhisperEngine::new(
                input_sample_rate,
            )?)),
            backend => Err(Error(format!(
                "Unknown ASR backend {backend:?}; expected conomo, whisper, or nemotron"
            ))),
        }
    }

    pub fn name(&self) -> String {
        match self {
            Self::Worker(_) => "conomo".to_string(),
            Self::Nemotron(engine) => engine.name(),
            Self::Whisper(engine) => engine.model_name(),
        }
    }

    pub fn is_worker_backend(&self) -> bool {
        matches!(self, Self::Worker(_) | Self::Nemotron(_))
    }

    pub fn warmup(&mut self) -> Result<()> {
        match self {
            Self::Worker(_) => Ok(()),
            Self::Nemotron(engine) => engine.warmup(),
            Self::Whisper(engine) => engine.warmup(),
        }
    }

    pub fn set_vocabulary(&mut self, phrases: &[String]) {
        let Self::Worker(engine) = self else {
            return;
        };
        if let Err(error) = engine.send_message(json!({ "type": "context", "phrases": phrases })) {
            eprintln!("vocabulary update failed: {error}");
        }
    }

    pub fn set_prompt(&mut self, prompt: Option<String>) {
        let Self::Worker(engine) = self else {
            return;
        };
        if env::var("MEMO_CONTEXTUAL_VOCAB").as_deref() == Ok("1") {
            if let Err(error) = engine.set_context(prompt) {
                eprintln!("contextual vocabulary update failed: {error}");
            }
        }
    }

    pub fn begin_live_stream(&mut self) -> Result<()> {
        match self {
            Self::Worker(engine) => engine.begin_live_stream(),
            Self::Nemotron(engine) => engine.begin(),
            Self::Whisper(_) => Ok(()),
        }
    }

    pub fn feed_live_audio(&mut self, samples: &[i16]) -> Result<()> {
        match self {
            Self::Worker(engine) => engine.feed_live_audio(samples),
            Self::Nemotron(engine) => engine.feed(samples),
            Self::Whisper(_) => Ok(()),
        }
    }

    pub fn abort_live_stream(&mut self) {
        match self {
            Self::Worker(engine) => engine.abort_live_stream(),
            Self::Nemotron(engine) => engine.abort(),
            _ => {}
        }
    }

    pub fn transcribe(&mut self, samples: &[i16]) -> Result<String> {
        match self {
            Self::Worker(engine) => engine.finish_transcription(samples),
            Self::Nemotron(engine) => engine.transcribe(samples),
            Self::Whisper(engine) => engine.transcribe(samples),
        }
    }
}

pub struct WorkerEngine {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<String>,
    resampler: StreamingResampler,
    session_active: bool,
    unavailable: bool,
    streamed_input_samples: usize,
}

impl WorkerEngine {
    fn new(input_sample_rate: u32) -> Result<Self> {
        let worker = required_path("MEMO_ASR_WORKER")?;

        if !worker.is_file() {
            return Err(Error(format!(
                "conomo worker not found: {}",
                worker.display()
            )));
        }
        let mut child = Command::new(&worker)
            .arg("--worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error(format!("Failed to launch bundled conomo worker: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error("Failed to open conomo worker stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error("Failed to open conomo worker stdout".to_string()))?;
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

        let ready = match responses.recv_timeout(WORKER_READY_TIMEOUT) {
            Ok(line) => line,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error(format!("Failed waiting for conomo worker: {error}")));
            }
        };
        if ready.trim() != "READY" {
            let status = child.try_wait().ok().flatten();
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error(format!(
                "conomo worker did not become ready (line={:?}, status={status:?})",
                ready.trim()
            )));
        }

        eprintln!("conomo worker ready (worker={})", worker.display());

        Ok(Self {
            child,
            stdin,
            responses,
            resampler: StreamingResampler::new(input_sample_rate, TARGET_SAMPLE_RATE),
            session_active: false,
            unavailable: false,
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

    fn set_context(&mut self, prompt: Option<String>) -> Result<()> {
        self.send_message(json!({
            "type": "context",
            "prompt": prompt,
        }))
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
                    self.invalidate();
                    return Err(Error(format!(
                        "conomo worker did not return a transcript ({error}; status={status:?})"
                    )));
                }
            };
            let line = line.trim();
            if let Some(message) = line.strip_prefix("ERROR:") {
                return Err(Error(format!("conomo transcription failed: {message}")));
            }
            if let Some(payload) = line.strip_prefix("FINAL:") {
                let parsed: Value = serde_json::from_str(payload)
                    .map_err(|e| Error(format!("Invalid conomo FINAL payload: {e}")))?;
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

    fn invalidate(&mut self) {
        self.unavailable = true;
        self.session_active = false;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn send_message(&mut self, message: Value) -> Result<()> {
        if self.unavailable {
            return Err(Error(
                "conomo worker expired; restart dictation to recover".to_string(),
            ));
        }
        let line = message.to_string();
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| Error(format!("Failed sending audio to conomo worker: {e}")))
    }
}

impl Drop for WorkerEngine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) struct StreamingResampler {
    from_rate: u32,
    to_rate: u32,
    buffer: Vec<i16>,
    position: f64,
}

impl StreamingResampler {
    pub(crate) fn new(from_rate: u32, to_rate: u32) -> Self {
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

    pub(crate) fn push(&mut self, samples: &[i16], finish: bool) -> Vec<i16> {
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
    let value = env::var(name)
        .map_err(|_| Error(format!("{name} is required for the selected ASR backend")))?;
    if value.trim().is_empty() {
        return Err(Error(format!("{name} cannot be empty")));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[test]
    fn unsupported_windows_cpu_reports_missing_speech_requirements() {
        assert!(validate_windows_cpu_features([true; 4]).is_ok());
        for (index, name) in ["AVX2", "FMA", "F16C", "BMI2"].iter().enumerate() {
            let mut supported = [true; 4];
            supported[index] = false;
            let error = validate_windows_cpu_features(supported).err().expect("Unsupported CPU must fail before loading models");
            assert!(error.to_string().contains(&format!("Missing CPU features: {name}.")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn invalidated_worker_cannot_consume_a_delayed_final() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let (tx, responses) = mpsc::channel();
        tx.send("FINAL: {\"processedText\":\"old utterance\"}".to_string())
            .unwrap();
        let mut engine = WorkerEngine {
            child,
            stdin,
            responses,
            resampler: StreamingResampler::new(16_000, 16_000),
            session_active: true,
            unavailable: false,
            streamed_input_samples: 0,
        };
        engine.invalidate();
        assert!(engine.child.try_wait().unwrap().is_some());
        assert!(engine.finish_transcription(&[1, 2]).is_err());
        assert!(engine.begin_live_stream().is_err());
    }

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

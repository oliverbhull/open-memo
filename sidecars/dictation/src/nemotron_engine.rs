//! Resident streaming Nemotron with bounded asynchronous ingress and lazy Base fallback.
use crate::{transcription_engine::StreamingResampler, whisper_engine::WhisperEngine};
use memo_dictation::{Error, Result};
use std::{
    env,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Mutex,
    },
    time::Duration,
};

struct Worker {
    child: Child,
    tx: SyncSender<Vec<u8>>,
    rx: Receiver<std::result::Result<String, String>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub struct NemotronEngine {
    worker: Mutex<Option<Worker>>,
    fallback: WhisperEngine,
    resampler: StreamingResampler,
    sample_rate: u32,
    streamed: usize,
    active: bool,
    fallback_used: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pipe_reader_accepts_text_and_errors_but_rejects_truncation_and_oversize() {
        let mut frame = vec![0];
        frame.extend(5u32.to_le_bytes());
        frame.extend("café".as_bytes());
        assert_eq!(response(&mut &frame[..]).unwrap().unwrap(), "café");
        frame[0] = 1;
        assert_eq!(response(&mut &frame[..]).unwrap().unwrap_err(), "café");
        assert!(response(&mut &frame[..8]).is_err());
        let mut invalid = vec![0];
        invalid.extend((4u32 * 1024 * 1024 + 1).to_le_bytes());
        assert!(response(&mut &invalid[..]).is_err());
    }
}
fn response(reader: &mut impl Read) -> std::io::Result<std::result::Result<String, String>> {
    let mut header = [0; 5];
    reader.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
    if size > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Oversized Nemotron reply",
        ));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(if header[0] == 0 { Ok(text) } else { Err(text) })
}
impl NemotronEngine {
    pub fn new(sample_rate: u32) -> Result<Self> {
        Ok(Self {
            worker: Mutex::new(None),
            fallback: WhisperEngine::new(sample_rate)?,
            resampler: StreamingResampler::new(sample_rate, 16000),
            sample_rate,
            streamed: 0,
            active: false,
            fallback_used: false,
        })
    }
    pub fn name(&self) -> String {
        if self.fallback_used {
            self.fallback.model_name()
        } else {
            "nemotron-streaming".into()
        }
    }
    fn start(&self) -> Result<Worker> {
        let executable = env::var("MEMO_NEMOTRON_WORKER")
            .map_err(|_| Error("MEMO_NEMOTRON_WORKER required".into()))?;
        let model = env::var("MEMO_NEMOTRON_MODEL")
            .map_err(|_| Error("MEMO_NEMOTRON_MODEL required".into()))?;
        let mut command = Command::new(executable);
        command
            .arg(model)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| Error(format!("Start Nemotron: {e}")))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        // Up to ~40 seconds of 40ms microphone chunks. A slow runtime cannot grow memory forever.
        let (tx, requests) = mpsc::sync_channel::<Vec<u8>>(1024);
        let (replies, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(request) = requests.recv() {
                if stdin
                    .write_all(&request)
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        std::thread::spawn(move || loop {
            match response(&mut stdout) {
                Ok(value) => {
                    if replies.send(value).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = replies.send(Err(format!("Nemotron pipe closed: {error}")));
                    break;
                }
            }
        });
        let worker = Worker { child, tx, rx };
        worker
            .rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|e| Error(format!("Nemotron startup: {e}")))?
            .map_err(Error)?;
        Ok(worker)
    }
    fn ensure_worker(&self) -> Result<()> {
        let mut worker = self.worker.lock().unwrap();
        if worker.is_none() {
            *worker = Some(self.start()?);
        }
        Ok(())
    }
    pub fn warmup(&mut self) -> Result<()> {
        if let Err(error) = self.ensure_worker() {
            self.disable(error);
            self.fallback.warmup()?;
        }
        Ok(())
    }
    fn send(&self, opcode: u8, pcm: &[i16]) -> Result<()> {
        let mut frame = Vec::with_capacity(5 + pcm.len() * 2);
        frame.push(opcode);
        frame.extend((pcm.len() as u32 * 2).to_le_bytes());
        for sample in pcm {
            frame.extend(sample.to_le_bytes());
        }
        let slot = self.worker.lock().unwrap();
        let worker = slot
            .as_ref()
            .ok_or_else(|| Error("Nemotron worker unavailable".into()))?;
        worker.tx.try_send(frame).map_err(|e| {
            Error(format!(
                "Nemotron ingress unavailable or backlog limit reached: {e}"
            ))
        })
    }
    fn disable(&mut self, error: impl std::fmt::Display) {
        eprintln!("Nemotron unavailable; using Whisper Base fallback: {error}");
        *self.worker.lock().unwrap() = None;
        self.active = false;
        self.fallback_used = true;
    }
    pub fn begin(&mut self) -> Result<()> {
        self.streamed = 0;
        self.resampler = StreamingResampler::new(self.sample_rate, 16000);
        if self.fallback_used {
            return Ok(());
        }
        if let Err(error) = self.ensure_worker().and_then(|_| self.send(1, &[])) {
            self.disable(error);
            return Ok(());
        }
        self.active = true;
        Ok(())
    }
    pub fn feed(&mut self, samples: &[i16]) -> Result<()> {
        if self.fallback_used {
            return Ok(());
        }
        if !self.active {
            self.begin()?;
        }
        let pcm = self.resampler.push(samples, false);
        if let Err(error) = self.send(2, &pcm) {
            self.disable(error);
        } else {
            self.streamed += samples.len();
        }
        Ok(())
    }
    pub fn abort(&mut self) {
        if self.active {
            if let Err(error) = self.send(4, &[]) {
                self.disable(error);
            }
        }
        self.active = false;
        self.streamed = 0;
    }
    pub fn transcribe(&mut self, samples: &[i16]) -> Result<String> {
        if samples.is_empty() {
            self.abort();
            return Ok(String::new());
        }
        if !self.fallback_used {
            if !self.active {
                self.begin()?;
            }
            let remaining = &samples[self.streamed.min(samples.len())..];
            self.feed(remaining)?;
            if !self.fallback_used {
                let tail = self.resampler.push(&[], true);
                let result = self
                    .send(2, &tail)
                    .and_then(|_| self.send(3, &[]))
                    .and_then(|_| {
                        let slot = self.worker.lock().unwrap();
                        slot.as_ref()
                            .unwrap()
                            .rx
                            .recv_timeout(Duration::from_secs(120))
                            .map_err(|e| Error(format!("Nemotron finalization timed out: {e}")))?
                            .map_err(Error)
                    });
                self.active = false;
                self.streamed = 0;
                match result {
                    Ok(text) => return Ok(text.split_whitespace().collect::<Vec<_>>().join(" ")),
                    Err(error) => self.disable(error),
                }
            }
        }
        self.fallback.transcribe(samples)
    }
}

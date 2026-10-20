//! Persistent whisper.cpp context, communicating over private binary pipes.
use crate::transcription_engine::StreamingResampler;
use memo_dictation::{Error, Result};
use std::{
    env,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, Sender},
        Mutex,
    },
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
pub struct WhisperEngine {
    executable: PathBuf,
    model: PathBuf,
    sample_rate: u32,
    worker: Mutex<Option<Worker>>,
}
struct Worker {
    child: Child,
    requests: Sender<Vec<u8>>,
    responses: Receiver<std::result::Result<String, String>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn read_response(reader: &mut impl Read) -> std::io::Result<std::result::Result<String, String>> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
    if size > MAX_RESPONSE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Whisper response too large",
        ));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    let text = String::from_utf8(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    match header[0] {
        0 => Ok(Ok(text)),
        1 => Ok(Err(text)),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid Whisper status",
        )),
    }
}
impl WhisperEngine {
    pub fn model_name(&self) -> String {
        let stem = self
            .model
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("custom");
        format!("whisper-{}", stem.strip_prefix("ggml-").unwrap_or(stem))
    }
    pub fn new(sample_rate: u32) -> Result<Self> {
        let required = |name: &str| -> Result<PathBuf> {
            let path =
                PathBuf::from(env::var(name).map_err(|_| Error(format!("{name} is required")))?);
            if !path.is_file() {
                return Err(Error(format!("{name} not found at {}", path.display())));
            }
            Ok(path)
        };
        Ok(Self {
            executable: required("MEMO_WHISPER_WORKER")?,
            model: required("MEMO_WHISPER_MODEL")?,
            sample_rate,
            worker: Mutex::new(None),
        })
    }
    fn start(&self) -> Result<Worker> {
        let mut command = Command::new(&self.executable);
        command
            .arg(&self.model)
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
            .map_err(|e| Error(format!("Start Whisper worker: {e}")))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (request_sender, requests) = mpsc::channel::<Vec<u8>>();
        let (sender, responses) = mpsc::channel();
        // All pipe I/O runs off the caller thread, so the deadline also covers
        // a blocked stdin write. Killing the child unblocks a stuck pipe reader.
        std::thread::spawn(move || {
            let exchange = |stdout: &mut _, sender: &Sender<_>| -> bool {
                match read_response(stdout) {
                    Ok(response) => sender.send(response).is_ok(),
                    Err(error) => {
                        let _ = sender.send(Err(format!("Whisper worker pipe closed: {error}")));
                        false
                    }
                }
            };
            if !exchange(&mut stdout, &sender) {
                return;
            }
            while let Ok(request) = requests.recv() {
                if let Err(error) = stdin.write_all(&request).and_then(|_| stdin.flush()) {
                    let _ = sender.send(Err(format!("Write Whisper audio: {error}")));
                    break;
                }
                if !exchange(&mut stdout, &sender) {
                    break;
                }
            }
        });
        let worker = Worker {
            child,
            requests: request_sender,
            responses,
        };
        worker.response()?; // Ready only after the model and context are loaded.
        Ok(worker)
    }
    pub fn warmup(&self) -> Result<()> {
        let mut slot = self
            .worker
            .lock()
            .map_err(|_| Error("Whisper worker lock poisoned".into()))?;
        if slot.is_none() {
            *slot = Some(self.start()?);
        }
        Ok(())
    }
    pub fn transcribe(&self, samples: &[i16]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let mut resampler = StreamingResampler::new(self.sample_rate, 16_000);
        let pcm = resampler.push(samples, true);
        if pcm.len() > 16_000 * 60 * 10 {
            return Err(Error("Whisper recording exceeds ten minutes".into()));
        }
        let mut request = Vec::with_capacity(4 + pcm.len() * 2);
        request.extend((pcm.len() as u32).to_le_bytes());
        for sample in pcm {
            request.extend(sample.to_le_bytes());
        }
        let mut slot = self
            .worker
            .lock()
            .map_err(|_| Error("Whisper worker lock poisoned".into()))?;
        if slot.is_none() {
            *slot = Some(self.start()?);
        }
        let worker = slot.as_mut().unwrap();
        let result = worker
            .requests
            .send(request)
            .map_err(|e| Error(format!("Whisper worker disconnected: {e}")))
            .and_then(|_| worker.response());
        if result.is_err() {
            *slot = None;
        } // Reap; next request gets a fresh worker.
        result.map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}
impl Worker {
    fn response(&self) -> Result<String> {
        self.responses
            .recv_timeout(TIMEOUT)
            .map_err(|e| Error(format!("Whisper worker timed out or disconnected: {e}")))?
            .map_err(Error)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framed_unicode_errors_and_truncation() {
        let mut frame = vec![0];
        frame.extend(5u32.to_le_bytes());
        frame.extend("café".as_bytes());
        assert_eq!(read_response(&mut &frame[..]).unwrap().unwrap(), "café");
        frame[0] = 1;
        assert_eq!(read_response(&mut &frame[..]).unwrap().unwrap_err(), "café");
        assert!(read_response(&mut &frame[..8]).is_err());
        let mut invalid = vec![0];
        invalid.extend((MAX_RESPONSE as u32 + 1).to_le_bytes());
        assert!(read_response(&mut &invalid[..]).is_err());
    }
}

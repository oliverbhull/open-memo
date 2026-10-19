//! CPU-only whisper.cpp CLI adapter. Each utterance owns its files and child.
//! A fresh process is deliberately used until target-machine latency is measured.
use crate::transcription_engine::StreamingResampler;
use memo_dictation::{Error, Result};
use std::{
    env, fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT_JOB: AtomicU64 = AtomicU64::new(0);
pub struct WhisperEngine {
    executable: PathBuf,
    model: PathBuf,
    sample_rate: u32,
}
struct JobDirectory(PathBuf);
impl Drop for JobDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl WhisperEngine {
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
            executable: required("MEMO_WHISPER_CLI")?,
            model: required("MEMO_WHISPER_MODEL")?,
            sample_rate,
        })
    }
    pub fn warmup(&self) -> Result<()> {
        self.transcribe(&vec![0; self.sample_rate as usize])
            .map(|_| ())
    }
    pub fn transcribe(&self, samples: &[i16]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let mut resampler = StreamingResampler::new(self.sample_rate, 16_000);
        let pcm = resampler.push(samples, true);
        let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
        let directory = env::temp_dir().join(format!("memo-whisper-{}-{id}", std::process::id()));
        fs::create_dir(&directory).map_err(|e| Error(format!("Create Whisper job: {e}")))?;
        let job = JobDirectory(directory);
        let wav = job.0.join("audio.wav");
        let output = job.0.join("transcript");
        fs::write(&wav, wav_bytes(&pcm)?)
            .map_err(|e| Error(format!("Write Whisper audio: {e}")))?;
        let mut command = Command::new(&self.executable);
        command
            .args(["-m"])
            .arg(&self.model)
            .arg("-f")
            .arg(&wav)
            .args(["-l", "en", "-t", "4", "-ng", "-nt", "-otxt", "-of"])
            .arg(&output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| Error(format!("Start whisper.cpp: {e}")))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(Error(format!("whisper.cpp failed ({status})")));
                    }
                    break;
                }
                Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(Error(format!(
                        "whisper.cpp timed out or could not be reaped: {result:?}"
                    )));
                }
            }
        }
        fs::read_to_string(output.with_extension("txt"))
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .map_err(|e| Error(format!("Read whisper.cpp transcript: {e}")))
    }
}
fn wav_bytes(pcm: &[i16]) -> Result<Vec<u8>> {
    let bytes = u32::try_from(
        pcm.len()
            .checked_mul(2)
            .ok_or_else(|| Error("Audio too long".into()))?,
    )
    .map_err(|_| Error("Audio too long".into()))?;
    let size = bytes
        .checked_add(36)
        .ok_or_else(|| Error("Audio too long".into()))?;
    let mut out = Vec::with_capacity(bytes as usize + 44);
    out.write_all(b"RIFF").unwrap();
    out.extend(size.to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(16000u32.to_le_bytes());
    out.extend(32000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(bytes.to_le_bytes());
    for sample in pcm {
        out.extend(sample.to_le_bytes());
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wave_is_mono_16khz_signed_little_endian() {
        let wav = wav_bytes(&[-32768, 0, 32767]).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(wav.len(), 50);
        assert_eq!(&wav[24..28], &16000u32.to_le_bytes());
        assert_eq!(&wav[44..], &[0, 128, 0, 0, 255, 127]);
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn cli_adapter_handles_paths_with_spaces_and_rejects_failed_runs() {
        let root = env::temp_dir().join(format!("memo whisper test {}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let fixture = JobDirectory(root);
        let executable = fixture.0.join("fake cli");
        let model = fixture.0.join("model.bin");
        fs::write(&model, "fixture").unwrap();
        fs::write(
            &executable,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -of) shift; output="$1" ;;
    -f) shift; test -f "$1" || exit 2 ;;
    -m) shift; test -f "$1" || exit 3 ;;
  esac
  shift
done
printf ' Hello\nworld. ' > "$output.txt"
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let engine = WhisperEngine {
            executable: executable.clone(),
            model,
            sample_rate: 48_000,
        };
        assert_eq!(
            engine.transcribe(&[1, -2, 3, 4, 5, 6]).unwrap(),
            "Hello world."
        );
        fs::write(&executable, "#!/bin/sh\nexit 1\n").unwrap();
        assert!(engine
            .transcribe(&[1, 2, 3])
            .unwrap_err()
            .to_string()
            .contains("failed"));
        assert_eq!(engine.transcribe(&[]).unwrap(), "");
    }
}

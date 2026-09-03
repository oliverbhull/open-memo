use crate::opus_decoder::OpusDecoder;
use crate::transcription_engine::TranscriptionEngine;
use serde_json::json;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

const MREC_MAGIC: u32 = 0x4345_524d;
const MREC_V1_HEADER_SIZE: usize = 12;
const MREC_V2_HEADER_SIZE: usize = 76;
const SAMPLE_RATE: u32 = 16_000;

struct BatchRequest {
    id: String,
    input: PathBuf,
    wav: PathBuf,
}

fn le_u16(data: &[u8], offset: usize) -> Result<u16, String> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or("truncated MREC integer")?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn le_u32(data: &[u8], offset: usize) -> Result<u32, String> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or("truncated MREC integer")?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn audio_offset(data: &[u8]) -> Result<usize, String> {
    if data.len() < MREC_V1_HEADER_SIZE || le_u32(data, 0)? != MREC_MAGIC {
        return Err("invalid MREC header".to_string());
    }
    match le_u16(data, 4)? {
        1 => Ok(MREC_V1_HEADER_SIZE),
        2 => {
            let header_size = le_u16(data, 6)? as usize;
            if header_size < MREC_V2_HEADER_SIZE || header_size > data.len() {
                Err(format!("invalid MREC v2 header size: {header_size}"))
            } else {
                Ok(header_size)
            }
        }
        version => Err(format!("unsupported MREC version: {version}")),
    }
}

fn decode_mrec(path: &Path) -> Result<(Vec<i16>, usize), String> {
    let data = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut offset = audio_offset(&data)?;
    let mut decoder = OpusDecoder::new(SAMPLE_RATE, 20).map_err(|e| e.to_string())?;
    let mut pcm = Vec::new();
    let mut frame_count = 0usize;

    while offset + 2 <= data.len() {
        let packet_size = le_u16(&data, offset)? as usize;
        offset += 2;
        if packet_size == 0 {
            break;
        }
        let packet = data
            .get(offset..offset + packet_size)
            .ok_or_else(|| "truncated stored MREC packet".to_string())?;
        offset += packet_size;
        if packet.len() < 2 {
            return Err("invalid stored audio packet".to_string());
        }
        let frames = packet[1] as usize;
        let mut frame_offset = 2usize;
        for _ in 0..frames {
            let frame_size = *packet
                .get(frame_offset)
                .ok_or_else(|| "missing Opus frame length".to_string())?
                as usize;
            frame_offset += 1;
            let frame = packet
                .get(frame_offset..frame_offset + frame_size)
                .ok_or_else(|| "truncated Opus frame".to_string())?;
            pcm.extend(
                decoder
                    .decode_frame(frame)
                    .map_err(|e| format!("Opus frame {frame_count}: {e}"))?,
            );
            frame_count += 1;
            frame_offset += frame_size;
        }
        if frame_offset != packet.len() {
            return Err("unexpected bytes after bundled Opus frames".to_string());
        }
    }
    Ok((pcm, frame_count))
}

fn write_wav(path: &Path, samples: &[i16]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create WAV directory: {e}"))?;
    }
    let data_bytes = samples.len().checked_mul(2).ok_or("WAV is too large")? as u32;
    let mut output =
        fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    output.write_all(b"RIFF").map_err(|e| e.to_string())?;
    output
        .write_all(&(36u32 + data_bytes).to_le_bytes())
        .map_err(|e| e.to_string())?;
    output.write_all(b"WAVEfmt ").map_err(|e| e.to_string())?;
    output
        .write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&SAMPLE_RATE.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&(SAMPLE_RATE * 2).to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&2u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output
        .write_all(&16u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    output.write_all(b"data").map_err(|e| e.to_string())?;
    output
        .write_all(&data_bytes.to_le_bytes())
        .map_err(|e| e.to_string())?;
    for sample in samples {
        output
            .write_all(&sample.to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    output
        .sync_all()
        .map_err(|e| format!("sync {}: {e}", path.display()))
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut engine = TranscriptionEngine::from_env(SAMPLE_RATE)?;
    engine.warmup()?;
    println!("{}", json!({ "type": "ready", "model": engine.name() }));
    io::stdout().flush()?;

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: BatchRequest = match serde_json::from_str::<serde_json::Value>(&line)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("missing id")?;
                let input = value
                    .get("input")
                    .and_then(|v| v.as_str())
                    .ok_or("missing input")?;
                let wav = value
                    .get("wav")
                    .and_then(|v| v.as_str())
                    .ok_or("missing wav")?;
                Ok(BatchRequest {
                    id: id.to_string(),
                    input: input.into(),
                    wav: wav.into(),
                })
            }) {
            Ok(request) => request,
            Err(error) => {
                println!(
                    "{}",
                    json!({ "type": "error", "id": null, "error": format!("invalid request: {error}") })
                );
                io::stdout().flush()?;
                continue;
            }
        };
        let result = (|| -> Result<serde_json::Value, String> {
            let (samples, opus_frames) = decode_mrec(&request.input)?;
            write_wav(&request.wav, &samples)?;
            let text = if samples.is_empty() {
                String::new()
            } else {
                engine
                    .transcribe(&samples)
                    .map_err(|e| e.to_string())?
                    .trim()
                    .to_string()
            };
            Ok(json!({
                "type": "result",
                "id": request.id,
                "text": text,
                "opusFrames": opus_frames,
                "durationSeconds": samples.len() as f64 / SAMPLE_RATE as f64,
            }))
        })();
        match result {
            Ok(result) => println!("{}", result),
            Err(error) => println!(
                "{}",
                json!({ "type": "error", "id": request.id, "error": error })
            ),
        }
        io::stdout().flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_v1_and_v2_headers() {
        let mut v1 = vec![0u8; MREC_V1_HEADER_SIZE];
        v1[0..4].copy_from_slice(&MREC_MAGIC.to_le_bytes());
        v1[4..6].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(audio_offset(&v1).unwrap(), MREC_V1_HEADER_SIZE);

        let mut v2 = vec![0u8; MREC_V2_HEADER_SIZE];
        v2[0..4].copy_from_slice(&MREC_MAGIC.to_le_bytes());
        v2[4..6].copy_from_slice(&2u16.to_le_bytes());
        v2[6..8].copy_from_slice(&(MREC_V2_HEADER_SIZE as u16).to_le_bytes());
        assert_eq!(audio_offset(&v2).unwrap(), MREC_V2_HEADER_SIZE);
    }
}

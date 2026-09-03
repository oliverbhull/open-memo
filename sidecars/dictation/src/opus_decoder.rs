use anyhow::{Context, Result};
use audiopus::coder::Decoder;
use audiopus::{Channels, SampleRate};

/// Decoder for the Opus bundles stored in Memo recording containers.
pub struct OpusDecoder {
    decoder: Decoder,
    frame_size_samples: usize,
}

impl OpusDecoder {
    pub fn new(sample_rate: u32, frame_duration_ms: u32) -> Result<Self> {
        if sample_rate != 16_000 {
            anyhow::bail!("Opus decoder only supports 16kHz");
        }
        if frame_duration_ms != 20 {
            anyhow::bail!("Opus decoder only supports 20ms frames");
        }
        Ok(Self {
            decoder: Decoder::new(SampleRate::Hz16000, Channels::Mono)
                .context("Failed to create Opus decoder")?,
            frame_size_samples: (sample_rate * frame_duration_ms / 1000) as usize,
        })
    }

    pub fn decode_frame(&mut self, frame_data: &[u8]) -> Result<Vec<i16>> {
        if frame_data.is_empty() {
            return Ok(Vec::new());
        }
        let mut pcm = vec![0i16; self.frame_size_samples];
        let samples_decoded = self
            .decoder
            .decode(Some(frame_data), &mut pcm, false)
            .context("Failed to decode Opus frame")?;
        pcm.truncate(samples_decoded);
        Ok(pcm)
    }
}

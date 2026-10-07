use crate::transcription_engine::StreamingResampler;
use std::cell::RefCell;
use std::collections::VecDeque;
use webrtc_vad::{SampleRate, Vad, VadMode};

const DETECTOR_RATE: u32 = 16_000;
const FRAME_SAMPLES: usize = 160; // 10 ms at 16 kHz
const SPEECH_START_FRAMES: u8 = 3;

/// Owned by the microphone callback thread: WebRTC's state never crosses threads.
struct SpeechMeter {
    input_rate: u32,
    resampler: StreamingResampler,
    vad: Vad,
    pending: Vec<i16>,
    speech_frames: u8,
    noise_floor: f32,
    ambient_levels: VecDeque<f32>,
    levels: Vec<f32>,
}

impl SpeechMeter {
    fn new(input_rate: u32) -> Self {
        Self {
            input_rate,
            resampler: StreamingResampler::new(input_rate, DETECTOR_RATE),
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::Aggressive),
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
            speech_frames: 0,
            noise_floor: 150.0,
            ambient_levels: VecDeque::with_capacity(50),
            levels: vec![0.0; 7],
        }
    }

    fn push(&mut self, samples: &[i16]) -> Vec<f32> {
        self.pending.extend(self.resampler.push(samples, false));
        let consumed = self.pending.len() / FRAME_SAMPLES * FRAME_SAMPLES;
        for frame in self.pending[..consumed].chunks_exact(FRAME_SAMPLES) {
            // Ignore microphone DC bias; it is not audible speech energy.
            let mean =
                frame.iter().map(|sample| f64::from(*sample)).sum::<f64>() / FRAME_SAMPLES as f64;
            let mut centered = [0_i16; FRAME_SAMPLES];
            for (target, sample) in centered.iter_mut().zip(frame) {
                *target =
                    (f64::from(*sample) - mean).clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            }
            let rms = root_mean_square(&centered);
            // Keep the classifier sensitive to soft voices on low-gain inputs.
            // Only its temporary frame is boosted; measured levels stay original.
            let gain = (1000.0 / rms.max(1.0)).clamp(1.0, 4.0);
            let detector_frame = centered.map(|sample| {
                (f32::from(sample) * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16
            });
            let voice = self.vad.is_voice_segment(&detector_frame).unwrap_or(false);
            // Learn ambient input continuously, but do not train the floor upward
            // on actual speech. The extra margin rejects occasional VAD noise hits.
            if !voice || rms < self.noise_floor * 1.2 {
                self.ambient_levels.push_back(rms);
                if self.ambient_levels.len() > 50 {
                    self.ambient_levels.pop_front();
                }
                let mut levels: Vec<f32> = self.ambient_levels.iter().copied().collect();
                levels.sort_by(f32::total_cmp);
                // Low percentile avoids learning unvoiced consonants or clicks
                // as the noise floor and then suppressing the next quiet phrase.
                let ambient = levels[levels.len() / 5];
                self.noise_floor += (ambient - self.noise_floor) * 0.05;
            }
            let speech = voice && rms > (self.noise_floor * 1.3 + 20.0).max(150.0);
            if speech {
                self.speech_frames = self.speech_frames.saturating_add(1);
                self.levels = if self.speech_frames >= SPEECH_START_FRAMES {
                    levels_above_noise_floor(rms, self.noise_floor)
                } else {
                    vec![0.0; 7]
                };
            } else {
                self.speech_frames = 0;
                self.levels.fill(0.0);
            }
        }
        self.pending.drain(..consumed);
        self.levels.clone()
    }
}

thread_local! {
    static SPEECH_METER: RefCell<Option<SpeechMeter>> = const { RefCell::new(None) };
}

/// Feed continuously, including while idle, so the detector learns ambient noise.
/// All resampling and gating here apply only to visual levels, never dictation PCM.
pub fn calculate_speech_audio_levels(samples: &[i16], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || sample_rate == 0 {
        return vec![0.0; 7];
    }
    SPEECH_METER.with(|state| {
        let mut state = state.borrow_mut();
        if state.as_ref().map(|meter| meter.input_rate) != Some(sample_rate) {
            *state = Some(SpeechMeter::new(sample_rate));
        }
        state.as_mut().unwrap().push(samples)
    })
}

// Preserve the previous fixed-floor calculation for comparison in regressions.
#[cfg(test)]
fn calculate_audio_levels(samples: &[i16]) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; 7];
    }
    levels_above_noise_floor(root_mean_square(samples), 150.0)
}

fn levels_above_noise_floor(rms: f32, noise_floor: f32) -> Vec<f32> {
    // Scale detected speech relative to this microphone's ambient level, leaving
    // quiet speech visible while preserving room for normal speech and emphasis.
    const FULL_SCALE: f32 = 4500.0;
    let normalized = ((rms - noise_floor) / (FULL_SCALE - noise_floor).max(1.0)).clamp(0.0, 1.0);
    let scaled = normalized.powf(0.7);
    [0.6, 0.8, 0.95, 1.0, 0.95, 0.8, 0.6]
        .into_iter()
        .map(|weight| scaled * weight)
        .collect()
}

fn root_mean_square(samples: &[i16]) -> f32 {
    let sum_squares: f64 = samples
        .iter()
        .map(|&sample| f64::from(sample).powi(2))
        .sum();
    (sum_squares / samples.len() as f64).sqrt() as f32
}

#[cfg(test)]
mod tests {
    use super::{calculate_audio_levels, calculate_speech_audio_levels, SpeechMeter};

    fn background_noise(samples: usize) -> Vec<i16> {
        let mut seed = 12345_u32;
        (0..samples)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed % 1201) as i16 - 600 + 250
            })
            .collect()
    }

    fn voiced_speech(samples: usize) -> Vec<i16> {
        let mut phase = 0.0_f64;
        (0..samples)
            .map(|index| {
                let time = index as f64 / 16_000.0;
                phase += std::f64::consts::TAU * (170.0 + 25.0 * (time * 5.0).sin()) / 16_000.0;
                let vowel = phase.sin() + 0.5 * (phase * 2.0).sin() + 0.3 * (phase * 3.0).sin();
                (vowel * 1200.0 * (0.6 + 0.4 * (time * 12.0).sin().abs())) as i16
            })
            .collect()
    }

    #[test]
    fn louder_ambient_noise_is_rejected_after_warming_the_existing_stream() {
        let noise = background_noise(16_000 * 3);
        assert!(calculate_audio_levels(&noise)[3] > 0.07);
        let mut meter = SpeechMeter::new(16_000);
        for frame in noise[..16_000].chunks(160) {
            meter.push(frame);
        }
        for frame in noise[16_000..].chunks(160) {
            assert_eq!(meter.push(frame), vec![0.0; 7]);
        }
    }

    #[test]
    fn speech_still_animates_and_following_background_noise_returns_to_zero() {
        let mut meter = SpeechMeter::new(16_000);
        for frame in background_noise(16_000).chunks(160) {
            meter.push(frame);
        }
        let mut visible = 0;
        for frame in voiced_speech(32_000).chunks(160) {
            visible += usize::from(meter.push(frame)[3] > 0.07);
        }
        assert!(visible > 40, "voiced speech must survive the visual gate");
        let noise = background_noise(32_000);
        for frame in noise[..16_000].chunks(160) {
            meter.push(frame);
        }
        for frame in noise[16_000..].chunks(160) {
            assert_eq!(meter.push(frame), vec![0.0; 7]);
        }
    }

    #[test]
    fn native_microphone_rates_and_uneven_callbacks_keep_detector_frames_valid() {
        for rate in [8000, 16_000, 44_100, 48_000, 96_000] {
            let noise = background_noise(rate as usize * 3);
            let mut meter = SpeechMeter::new(rate);
            for chunk in noise[..rate as usize].chunks(257) {
                meter.push(chunk);
            }
            for chunk in noise[rate as usize..].chunks(257) {
                assert_eq!(meter.push(chunk), vec![0.0; 7], "rate={rate}");
            }
            assert!(meter.pending.len() < 160);
        }
    }

    #[test]
    fn invalid_or_empty_meter_input_is_silent() {
        assert_eq!(calculate_speech_audio_levels(&[], 96_000), vec![0.0; 7]);
        assert_eq!(calculate_speech_audio_levels(&[300; 160], 0), vec![0.0; 7]);
    }

    #[test]
    fn quiet_voice_still_animates_above_a_quiet_background() {
        let mut meter = SpeechMeter::new(16_000);
        for frame in vec![0; 16_000].chunks(160) {
            meter.push(frame);
        }
        let quiet: Vec<i16> = voiced_speech(32_000)
            .iter()
            .map(|sample| sample / 4)
            .collect();
        let visible = quiet
            .chunks(160)
            .filter(|frame| meter.push(frame)[3] > 0.07)
            .count();
        assert!(
            visible > 40,
            "quiet voice must survive the visual gate: visible={visible}, floor={}",
            meter.noise_floor
        );
    }

    #[test]
    fn microphone_dc_offset_is_not_speech() {
        let mut meter = SpeechMeter::new(96_000);
        for _ in 0..100 {
            assert_eq!(meter.push(&[800; 960]), vec![0.0; 7]);
        }
    }

    #[test]
    #[ignore = "local diagnostic: requires MEMO_METER_REPLAY_PCM and MEMO_METER_REPLAY_RATE"]
    fn replay_local_meter_recording() {
        let path = std::env::var("MEMO_METER_REPLAY_PCM").expect("PCM path required");
        let rate: u32 = std::env::var("MEMO_METER_REPLAY_RATE")
            .unwrap()
            .parse()
            .unwrap();
        let bytes = std::fs::read(path).unwrap();
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        let mut meter = SpeechMeter::new(rate);
        let mut before = 0;
        let mut after = 0;
        let mut total = 0;
        // Simulate an already-warm microphone without assuming saved speech is silence.
        for chunk in background_noise(rate as usize).chunks(rate as usize / 100) {
            meter.push(chunk);
        }
        for chunk in samples.chunks(rate as usize / 100) {
            before += usize::from(calculate_audio_levels(chunk)[3] > 0.07);
            let levels = meter.push(chunk);
            after += usize::from(levels[3] > 0.07);
            assert!(levels.iter().all(|level| level.is_finite()));
            total += 1;
            if total % 100 == 0 {
                eprintln!(
                    "second={} old_active={} new_active={}",
                    total / 100,
                    before,
                    after
                );
                before = 0;
                after = 0;
            }
        }
    }

    #[test]
    fn silence_and_low_microphone_noise_stay_still() {
        for level in [0, 25, 75, 150] {
            assert_eq!(calculate_audio_levels(&[level; 256]), vec![0.0; 7]);
        }
        assert_eq!(calculate_audio_levels(&[]), vec![0.0; 7]);
    }

    #[test]
    fn speech_has_headroom_for_emphasis() {
        let quiet = calculate_audio_levels(&[400; 256])[3];
        let normal = calculate_audio_levels(&[1500; 256])[3];
        let emphasis = calculate_audio_levels(&[4000; 256])[3];
        assert!(quiet > 0.1 && quiet < 0.2);
        assert!(normal > quiet + 0.2 && normal < 0.6);
        assert!(emphasis > normal + 0.3 && emphasis < 1.0);
    }

    #[test]
    fn full_scale_is_bounded_even_for_negative_samples() {
        let levels = calculate_audio_levels(&[i16::MIN; 256]);
        assert_eq!(levels.len(), 7);
        assert_eq!(levels[3], 1.0);
        assert!(levels
            .iter()
            .all(|level| level.is_finite() && *level >= 0.0 && *level <= 1.0));
    }
}

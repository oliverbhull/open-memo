/// Visual meter only: this does not gate or modify audio sent to transcription.
pub fn calculate_audio_levels(samples: &[i16]) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; 7];
    }
    let sum_squares: f64 = samples
        .iter()
        .map(|&sample| f64::from(sample).powi(2))
        .sum();
    let rms = (sum_squares / samples.len() as f64).sqrt() as f32;

    // Ignore low microphone noise before applying gain. The gentler curve leaves
    // room for quiet speech, normal speech, and emphasis to look different.
    const NOISE_FLOOR: f32 = 150.0;
    const FULL_SCALE: f32 = 4500.0;
    let normalized = ((rms - NOISE_FLOOR) / (FULL_SCALE - NOISE_FLOOR)).clamp(0.0, 1.0);
    let scaled = normalized.powf(0.7);
    [0.6, 0.8, 0.95, 1.0, 0.95, 0.8, 0.6]
        .into_iter()
        .map(|weight| scaled * weight)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::calculate_audio_levels;

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

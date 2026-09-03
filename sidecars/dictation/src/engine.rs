use crate::Result;
use num_cpus;
use std::path::Path;
use std::sync::{Arc, Mutex};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

/// Open Memo's optional local Whisper backend.
pub struct SttEngine {
    state: Arc<Mutex<WhisperState>>,
    initial_prompt: Option<String>, // Cache prompt, recreate params each time
    input_sample_rate: u32,
    f32_buffer: Vec<f32>, // Reusable buffer
}

impl SttEngine {
    /// Create an engine from an existing GGML model file.
    pub fn new(model_path: impl AsRef<Path>, input_sample_rate: u32) -> Result<Self> {
        let path = model_path.as_ref();
        if !path.is_file() {
            return Err(crate::Error(format!(
                "Whisper model not found: {}",
                path.display()
            )));
        }

        let path_str = path
            .to_str()
            .ok_or_else(|| crate::Error("Invalid model path".into()))?;

        // Enable GPU/ACCEL auto-detection. The local runtime will use Metal/CUDA/
        // Vulkan/OpenCL where available and fall back to CPU otherwise.
        let params = WhisperContextParameters {
            use_gpu: true,
            ..WhisperContextParameters::default()
        };

        let ctx = WhisperContext::new_with_params(path_str, params)
            .map_err(|e| crate::Error(format!("Failed to load model: {}", e)))?;

        let state = ctx
            .create_state()
            .map_err(|e| crate::Error(format!("Failed to create state: {}", e)))?;

        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            initial_prompt: None,
            input_sample_rate,
            f32_buffer: Vec::with_capacity(48000), // Pre-allocate for common sizes
        })
    }

    /// Transcribe audio samples to text.
    ///
    /// Takes PCM audio samples (16-bit signed integers) and returns transcribed text.
    ///
    /// # Arguments
    ///
    /// * `samples` - Audio samples as `i16` PCM data at the sample rate specified when creating the engine
    ///
    /// # Returns
    ///
    /// Transcribed text as a `String`. Returns empty string if no speech detected.
    ///
    /// # Audio Format Requirements
    ///
    /// - Format: 16-bit signed integer PCM (`i16`)
    /// - Channels: Mono
    /// - Sample rate: Must match the `input_sample_rate` provided to `new()`
    /// - Minimum length: 1 second (16000 samples at 16kHz)
    pub fn transcribe(&mut self, samples: &[i16]) -> Result<String> {
        if samples.is_empty() {
            return Ok(String::new());
        }

        // Normalize and resample inline
        self.f32_buffer.clear();
        if self.input_sample_rate == 16000 {
            // Direct normalization, no resampling
            self.f32_buffer.reserve(samples.len());
            for &s in samples {
                self.f32_buffer.push(s as f32 / 32768.0);
            }
        } else {
            // Resample directly without intermediate Vec
            let ratio = self.input_sample_rate as f32 / 16000.0;
            let out_len = (samples.len() as f32 / ratio).max(1.0) as usize;
            self.f32_buffer.reserve(out_len);
            for i in 0..out_len {
                let pos = i as f32 * ratio;
                let i0 = pos.floor() as usize;
                let i1 = (i0 + 1).min(samples.len().saturating_sub(1));
                let t = pos - i0 as f32;
                let s0 = samples[i0] as f32 / 32768.0;
                let s1 = samples[i1] as f32 / 32768.0;
                self.f32_buffer.push(s0 * (1.0 - t) + s1 * t);
            }
        }

        if self.f32_buffer.len() < 16000 {
            return Err(crate::Error(format!(
                "Audio too short: {} samples",
                self.f32_buffer.len()
            )));
        }

        // Create params (reuse configuration pattern)
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // Use all available CPU cores for transcription (thread count is set per-transcription)
        // For Raspberry Pi, 4-6 threads is optimal
        params.set_n_threads(num_cpus::get().min(8) as i32);
        params.set_translate(false);
        params.set_language(Some("en"));
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_non_speech_tokens(true);
        params.set_max_len(0);
        params.set_token_timestamps(false);
        params.set_speed_up(false);
        params.set_audio_ctx(0);
        params.set_temperature(0.0);
        params.set_max_initial_ts(1.0);
        params.set_length_penalty(-1.0);
        params.set_temperature_inc(0.2);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        params.set_no_speech_thold(0.6);
        if let Some(ref prompt) = self.initial_prompt {
            if !prompt.trim().is_empty() {
                params.set_initial_prompt(prompt);
            }
        }

        // Lock state and run inference
        let mut state = self
            .state
            .lock()
            .map_err(|e| crate::Error(format!("State lock failed: {}", e)))?;
        state
            .full(params, &self.f32_buffer)
            .map_err(|e| crate::Error(format!("Inference failed: {}", e)))?;

        // Extract text
        let n = state
            .full_n_segments()
            .map_err(|e| crate::Error(format!("Failed to get segments: {}", e)))?;

        let mut text = String::new();
        for i in 0..n {
            if let Ok(seg) = state.full_get_segment_text(i) {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(seg.trim());
            }
        }

        Ok(text)
    }

    /// Set initial prompt for custom vocabulary or context.
    ///
    /// Useful for improving accuracy with domain-specific terms, names, or technical vocabulary.
    ///
    pub fn set_prompt(&mut self, prompt: Option<String>) {
        self.initial_prompt = prompt;
    }

    /// Warm up the GPU to reduce first-transcription latency.
    ///
    /// Call this after creating the engine to pre-initialize GPU resources.
    /// The first transcription after warmup will be faster.
    ///
    pub fn warmup(&self) -> Result<()> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(2);
        params.set_language(Some("en"));
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        let mut state = self
            .state
            .lock()
            .map_err(|e| crate::Error(format!("State lock failed: {}", e)))?;
        let _ = state.full(params, &vec![0.0f32; 1600]);
        Ok(())
    }
}

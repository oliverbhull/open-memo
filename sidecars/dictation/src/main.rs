//! Memo-owned native dictation sidecar.
//!
//! It owns microphone capture, trigger handling, and transcription.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rdev::{listen, Event, EventType, Key};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
mod app_detection;
mod mrec_batch;
mod opus_decoder;
mod transcription_engine;
use transcription_engine::TranscriptionEngine;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

/// When stdout is a pipe (Electron), Rust uses a block buffer — lines can sit until the buffer fills.
/// Flush so the UI overlay sees recording / stopped state immediately.
macro_rules! println_ui_flush {
    ($($arg:tt)*) => {{
        println!($($arg)*);
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }};
}

#[cfg(target_os = "macos")]
fn require_input_monitoring() -> Result<(), Box<dyn std::error::Error>> {
    let authorized =
        unsafe { CGPreflightListenEventAccess() } || unsafe { CGRequestListenEventAccess() };
    if authorized {
        println_ui_flush!("HOTKEY_READY");
        Ok(())
    } else {
        println_ui_flush!("HOTKEY_PERMISSION_REQUIRED");
        Err("Input Monitoring permission is required for the dictation hotkey".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn require_input_monitoring() -> Result<(), Box<dyn std::error::Error>> {
    println_ui_flush!("HOTKEY_READY");
    Ok(())
}

/// Minimum interval between `AUDIO_LEVELS:` lines (ms). `0` = no throttle (emit every callback / decoded frame).
/// Set `MEMO_AUDIO_LEVELS_INTERVAL_MS` (e.g. `33` for ~30 fps) if stdout/IPC cannot keep up.
static MEMO_AUDIO_LEVELS_INTERVAL_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn memo_audio_levels_interval_ms() -> u64 {
    *MEMO_AUDIO_LEVELS_INTERVAL_MS.get_or_init(|| {
        std::env::var("MEMO_AUDIO_LEVELS_INTERVAL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    })
}

fn should_emit_audio_levels_throttled(last_sent: &mut Option<Instant>, interval_ms: u64) -> bool {
    if interval_ms == 0 {
        return true;
    }
    let now = Instant::now();
    match last_sent {
        None => {
            *last_sent = Some(now);
            true
        }
        Some(prev) if now.duration_since(*prev).as_millis() >= u128::from(interval_ms) => {
            *last_sent = Some(now);
            true
        }
        Some(_) => false,
    }
}

/// Strip common hallucinated sign-offs from the end of a transcript.
const SIGN_OFF_PHRASES: &[&str] = &[
    "thank you",
    "thanks",
    "thanks for watching",
    "bye",
    "goodbye",
];

/// Strip trailing sign-off phrases (e.g. "Thank you.", "Bye", "Thanks for watching") from transcript.
fn strip_trailing_signoffs(text: &str) -> String {
    let mut out = text.trim().to_string();
    if out.is_empty() {
        return out;
    }
    loop {
        let prev_len = out.len();
        let out_trimmed =
            out.trim_end_matches(|c: char| c == '.' || c == ',' || c == ' ' || c == '!');
        let out_lower = out_trimmed.to_lowercase();
        for phrase in SIGN_OFF_PHRASES {
            if out_lower.ends_with(phrase) {
                let n = out_trimmed.chars().count();
                let p_len = phrase.chars().count();
                if n >= p_len {
                    let cut = n - p_len;
                    out = out_trimmed.chars().take(cut).collect::<String>();
                    out = out
                        .trim_end_matches(|c: char| c == ' ' || c == '.' || c == ',')
                        .to_string();
                    break;
                }
            }
        }
        if out.len() == prev_len {
            break;
        }
    }
    out.trim_end_matches(|c: char| c == ' ' || c == ',')
        .to_string()
}

/// Strip trailing period from short final phrase (<4 words).
/// Internal sentence-ending punctuation is always preserved to maintain readability.
fn strip_periods_from_short_phrases(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let last_char = trimmed.chars().last().unwrap();
    if last_char != '.' && last_char != '!' && last_char != '?' {
        return trimmed.to_string();
    }

    let without_final = &trimmed[..trimmed.len() - last_char.len_utf8()];
    let last_delim = without_final.rfind(|c: char| c == '.' || c == '!' || c == '?');
    let last_sentence = match last_delim {
        Some(pos) => &without_final[pos + 1..],
        None => without_final,
    };
    let word_count = last_sentence.trim().split_whitespace().count();
    if word_count < 4 {
        return without_final.to_string();
    }

    trimmed.to_string()
}

/// Strip leading dash and following space(s) from transcript (e.g. bullet-style "- Can you...").
fn strip_leading_dash_space(text: &str) -> String {
    let s = text.trim();
    if s.starts_with('-') {
        s[1..].trim_start().to_string()
    } else {
        s.to_string()
    }
}

/// Punctuation-only Whisper output is a no-speech artifact, not a transcript.
fn has_meaningful_transcript(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// Join streaming transcription segments with proper sentence boundaries.
/// Ensures each non-final segment ends with punctuation so sentences don't run together.
fn join_segments(parts: &[String]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    if parts.len() == 1 {
        return parts[0].clone();
    }

    let mut result = String::new();
    for (i, part) in parts.iter().enumerate() {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(trimmed);
        if i < parts.len() - 1 {
            let last = trimmed.chars().last().unwrap_or(' ');
            if last != '.' && last != '!' && last != '?' && last != ',' {
                result.push('.');
            }
        }
    }
    result
}

// Calculate audio levels for waveform visualization
// Returns 7 normalized levels (0.0-1.0) for the 7 bars
fn calculate_audio_levels(samples: &[i16]) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; 7];
    }

    // Calculate RMS (Root Mean Square) for audio level
    let sum_squares: i64 = samples.iter().map(|&s| (s as i64).pow(2)).sum();
    let rms = (sum_squares as f32 / samples.len() as f32).sqrt();

    // Normalize to 0-1 range (i16 max is 32767)
    // Use lower threshold and gain boost for better reactivity (similar to memo-desktop system mic)
    const NORMALIZATION_THRESHOLD: f32 = 15000.0;
    const GAIN_BOOST: f32 = 2.0;
    let normalized = ((rms / NORMALIZATION_THRESHOLD) * GAIN_BOOST).min(1.0);

    // Apply exponential scaling for better visual response
    let scaled = normalized.powf(0.4);

    // Create 7 bands with symmetric weighting (center bars higher, edges taper down)
    let weights = vec![0.6, 0.8, 0.95, 1.0, 0.95, 0.8, 0.6];
    weights.into_iter().map(|w| (scaled * w).min(1.0)).collect()
}

// Default trigger key (can be overridden via --hotkey argument)
const DEFAULT_TRIGGER_KEY: Key = Key::Function;

/// Resolve input device: "default", numeric index, or substring name match (e.g. "AirPods", "External Microphone").
fn find_input_device_by_spec(host: &cpal::Host, spec: &str) -> Option<cpal::Device> {
    let spec = spec.trim();
    if spec.is_empty() || spec.eq_ignore_ascii_case("default") {
        return host.default_input_device();
    }
    let devices: Vec<cpal::Device> = match host.input_devices() {
        Ok(iter) => iter.collect(),
        Err(_) => return None,
    };
    if let Ok(idx) = spec.parse::<usize>() {
        if idx < devices.len() {
            return Some(devices[idx].clone());
        }
        return None;
    }
    let spec_lower = spec.to_lowercase();
    for dev in &devices {
        if let Ok(name) = dev.name() {
            if name.to_lowercase().contains(&spec_lower) {
                return Some(dev.clone());
            }
        }
    }
    None
}

/// Prefer mono input and the highest sample rate up to 48 kHz (better quality when the device allows it).
fn best_input_config(
    device: &cpal::Device,
) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
    use cpal::SampleRate;
    let default = device.default_input_config()?;
    let Ok(configs) = device.supported_input_configs() else {
        return Ok(default);
    };
    let candidates: Vec<cpal::SupportedStreamConfigRange> = configs.collect();
    if candidates.is_empty() {
        return Ok(default);
    }
    let pick_mono = candidates
        .iter()
        .filter(|c| c.channels() == 1)
        .max_by_key(|c| c.max_sample_rate().0);
    let pick_any = candidates.iter().max_by_key(|c| c.max_sample_rate().0);
    let range = pick_mono.or(pick_any).unwrap_or(&candidates[0]);
    let max_sr = range.max_sample_rate().0;
    let min_sr = range.min_sample_rate().0;
    let target = max_sr.min(48_000).max(min_sr);
    Ok(range.with_sample_rate(SampleRate(target)))
}

fn extend_buffer_mono_i16(buf: &mut Vec<i16>, data: &[i16], channels: usize) {
    match channels {
        1 => buf.extend_from_slice(data),
        n if n > 1 => {
            for frame in data.chunks_exact(n) {
                let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                buf.push((sum / n as i32) as i16);
            }
        }
        _ => {}
    }
}

fn extend_buffer_mono_f32(buf: &mut Vec<i16>, data: &[f32], channels: usize) {
    match channels {
        1 => {
            for &s in data {
                buf.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
            }
        }
        n if n > 1 => {
            for frame in data.chunks_exact(n) {
                let mut acc = 0.0f32;
                for &s in frame {
                    acc += s.clamp(-1.0, 1.0);
                }
                buf.push(((acc / n as f32) * 32767.0) as i16);
            }
        }
        _ => {}
    }
}

fn extend_buffer_mono_u16(buf: &mut Vec<i16>, data: &[u16], channels: usize) {
    match channels {
        1 => {
            for &s in data {
                buf.push(((s as i32) - 32768) as i16);
            }
        }
        n if n > 1 => {
            for frame in data.chunks_exact(n) {
                let sum: i32 = frame.iter().map(|&s| (s as i32) - 32768).sum();
                buf.push((sum / n as i32) as i16);
            }
        }
        _ => {}
    }
}

fn audio_levels_interleaved_i16(data: &[i16], ch: usize) -> Vec<f32> {
    if ch <= 1 {
        return calculate_audio_levels(data);
    }
    let mono: Vec<i16> = data
        .chunks_exact(ch)
        .map(|frame| {
            let s: i32 = frame.iter().map(|&x| x as i32).sum();
            (s / ch as i32) as i16
        })
        .collect();
    calculate_audio_levels(&mono)
}

fn audio_levels_interleaved_f32(data: &[f32], ch: usize) -> Vec<f32> {
    if ch <= 1 {
        let mono: Vec<i16> = data
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        return calculate_audio_levels(&mono);
    }
    let mono: Vec<i16> = data
        .chunks_exact(ch)
        .map(|frame| {
            let acc: f32 = frame.iter().map(|&s| s.clamp(-1.0, 1.0)).sum::<f32>() / ch as f32;
            (acc * 32767.0) as i16
        })
        .collect();
    calculate_audio_levels(&mono)
}

fn audio_levels_interleaved_u16(data: &[u16], ch: usize) -> Vec<f32> {
    if ch <= 1 {
        let mono: Vec<i16> = data.iter().map(|&s| ((s as i32) - 32768) as i16).collect();
        return calculate_audio_levels(&mono);
    }
    let mono: Vec<i16> = data
        .chunks_exact(ch)
        .map(|frame| {
            let s: i32 = frame.iter().map(|&x| (x as i32) - 32768).sum();
            (s / ch as i32) as i16
        })
        .collect();
    calculate_audio_levels(&mono)
}

// Parse hotkey from string to Key enum
fn parse_hotkey(key_str: &str) -> Option<Key> {
    match key_str.to_lowercase().as_str() {
        "function" | "fn" => Some(Key::Function),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        "space" => Some(Key::Space),
        "controlleft" | "ctrl" => Some(Key::ControlLeft),
        "controlright" => Some(Key::ControlRight),
        "altleft" | "altright" | "alt" => Some(Key::Alt),
        "metaleft" | "cmd" | "command" => Some(Key::MetaLeft),
        "metaright" => Some(Key::MetaRight),
        "shiftleft" | "shift" => Some(Key::ShiftLeft),
        "shiftright" => Some(Key::ShiftRight),
        _ => None,
    }
}

// Message types for the channel
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerSource {
    Manual,
    Vad,
    Lock,
}

#[derive(Debug, Clone, Copy)]
enum KeyEvent {
    StartRecording(TriggerSource),
    StopRecording(TriggerSource),
    ToggleLock,
}

fn start_worker_live_feeder(
    engine: Arc<Mutex<TranscriptionEngine>>,
    audio_buffer: Arc<Mutex<Vec<i16>>>,
    active: Arc<AtomicBool>,
    handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
) {
    if !engine.lock().unwrap().is_worker_backend() {
        return;
    }

    active.store(false, Ordering::Release);
    if let Some(previous) = handle.lock().unwrap().take() {
        let _ = previous.join();
    }

    if let Err(error) = engine.lock().unwrap().begin_live_stream() {
        eprintln!("worker stream start failed: {error}");
        return;
    }

    active.store(true, Ordering::Release);
    let active_for_thread = active.clone();
    let join_handle = std::thread::spawn(move || {
        let mut cursor = 0usize;
        while active_for_thread.load(Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let chunk = {
                let buffer = audio_buffer.lock().unwrap();
                let end = buffer.len();
                let chunk = if end > cursor {
                    buffer[cursor..end].to_vec()
                } else {
                    Vec::new()
                };
                cursor = end;
                chunk
            };
            if !chunk.is_empty() {
                if let Err(error) = engine.lock().unwrap().feed_live_audio(&chunk) {
                    eprintln!("worker live audio failed: {error}");
                    active_for_thread.store(false, Ordering::Release);
                    break;
                }
            }
        }
    });
    *handle.lock().unwrap() = Some(join_handle);
}

fn stop_worker_live_feeder(
    active: &Arc<AtomicBool>,
    handle: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
) {
    active.store(false, Ordering::Release);
    if let Some(join_handle) = handle.lock().unwrap().take() {
        let _ = join_handle.join();
    }
}

fn emit_saved_audio(samples: &[i16], sample_rate: u32) {
    let enabled = std::env::var("MEMO_EMIT_AUDIO")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !enabled || samples.is_empty() {
        return;
    }

    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let channels = 1u16;
    let bits_per_sample = 16u16;
    let pcm_data_len = samples.len() * 2;
    let mut wav_data = Vec::with_capacity(44 + pcm_data_len);
    wav_data.extend_from_slice(b"RIFF");
    wav_data.extend_from_slice(&(36u32 + pcm_data_len as u32).to_le_bytes());
    wav_data.extend_from_slice(b"WAVEfmt ");
    wav_data.extend_from_slice(&16u32.to_le_bytes());
    wav_data.extend_from_slice(&1u16.to_le_bytes());
    wav_data.extend_from_slice(&channels.to_le_bytes());
    wav_data.extend_from_slice(&sample_rate.to_le_bytes());
    wav_data.extend_from_slice(
        &(sample_rate * channels as u32 * (bits_per_sample as u32 / 8)).to_le_bytes(),
    );
    wav_data.extend_from_slice(&(channels * (bits_per_sample / 8)).to_le_bytes());
    wav_data.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav_data.extend_from_slice(b"data");
    wav_data.extend_from_slice(&(pcm_data_len as u32).to_le_bytes());
    for sample in samples {
        wav_data.extend_from_slice(&sample.to_le_bytes());
    }

    println!(
        "AUDIO_DURATION:{:.2}",
        pcm_data_len as f32 / 2.0 / sample_rate as f32
    );
    println!("AUDIO_WAV:{}", STANDARD.encode(wav_data));
}

/// Compute RMS (root mean square) of i16 samples for VAD.
fn compute_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: i64 = samples.iter().map(|&s| (s as i64).pow(2)).sum();
    (sum_squares as f32 / samples.len() as f32).sqrt()
}

// Calculate the rate of increase in realtime factor per second of audio
fn calculate_rate_of_increase(history: &[(f32, f32)]) -> Option<f32> {
    if history.len() < 2 {
        return None;
    }

    // Simple linear regression: calculate slope (rate of increase)
    let n = history.len() as f32;
    let sum_x: f32 = history.iter().map(|(x, _)| x).sum();
    let sum_y: f32 = history.iter().map(|(_, y)| y).sum();
    let sum_xy: f32 = history.iter().map(|(x, y)| x * y).sum();
    let sum_x2: f32 = history.iter().map(|(x, _)| x * x).sum();

    let denominator = n * sum_x2 - sum_x * sum_x;
    if denominator.abs() < 1e-6 {
        return None;
    }

    let slope = (n * sum_xy - sum_x * sum_y) / denominator;
    Some(slope)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|argument| argument == "--batch-transcribe") {
        return mrec_batch::run();
    }

    // Parse the configured hotkey.
    let args: Vec<String> = std::env::args().collect();
    let mut trigger_key = DEFAULT_TRIGGER_KEY;

    for i in 0..args.len() {
        if args[i] == "--hotkey" && i + 1 < args.len() {
            if let Some(key) = parse_hotkey(&args[i + 1]) {
                trigger_key = key;
                println!("Using hotkey: {:?}", trigger_key);
            } else {
                eprintln!(
                    "Warning: Unknown hotkey '{}', using default (Function)",
                    args[i + 1]
                );
            }
        }
    }

    require_input_monitoring()?;

    // Resolve input device and stream config BEFORE creating the STT engine so input_sample_rate matches
    // the actual hardware (critical for Bluetooth / AirPods HFP at 8–16 kHz vs built-in at 48 kHz).
    let host = cpal::default_host();
    let spec = std::env::var("MEMO_SYSTEM_INPUT_DEVICE").unwrap_or_default();
    let device = if !spec.trim().is_empty() {
        find_input_device_by_spec(&host, spec.trim())
            .ok_or_else(|| format!("Selected input device not found: {:?}", spec.trim()))?
    } else {
        host.default_input_device().ok_or("No input device found")?
    };

    let config = best_input_config(&device)?;
    let sample_rate = config.sample_rate().0;
    let stream_channels = config.channels() as usize;
    let dev_name = device.name().unwrap_or_else(|_| "?".to_string());
    println!("MIC_INFO:{}\t{}", dev_name.replace('\t', " "), sample_rate);
    println!("Using: {}", dev_name);
    println!(
        "Sample rate: {} Hz, channels: {}, format: {:?}",
        sample_rate,
        stream_channels,
        config.sample_format()
    );

    let engine = TranscriptionEngine::from_env(sample_rate)?;
    println!(
        "Loading {} model ({} Hz input)...",
        engine.name(),
        sample_rate
    );

    println!("Warming up ASR backend...");
    engine.warmup()?;
    println!("Ready!");

    let engine = Arc::new(Mutex::new(engine));
    let audio_buffer = Arc::new(Mutex::new(Vec::<i16>::new()));
    let is_recording = Arc::new(AtomicBool::new(false));
    let is_locked = Arc::new(AtomicBool::new(false));
    let active_trigger: Arc<Mutex<Option<TriggerSource>>> = Arc::new(Mutex::new(None));
    let vad_preroll_buffer: Arc<Mutex<Option<Arc<Mutex<VecDeque<i16>>>>>> =
        Arc::new(Mutex::new(None));
    let recording_stream: Arc<Mutex<Option<cpal::Stream>>> = Arc::new(Mutex::new(None));
    let performance_history: Arc<Mutex<VecDeque<(f32, f32)>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(10)));

    // worker keeps one cache-aware model session for the complete transmission,
    // so the legacy segment pre-transcription path stays disabled.
    let streaming_enabled = !engine.lock().unwrap().is_worker_backend()
        && std::env::var("STREAMING_TRANSCRIBE")
            .map(|v| v != "0" && v.to_lowercase() != "false")
            .unwrap_or(true);
    let seg_silence_threshold: f32 = std::env::var("SEGMENT_SILENCE_THRESHOLD")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600.0);
    let seg_silence_ms: u64 = std::env::var("SEGMENT_SILENCE_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1200);
    let seg_min_duration_ms: u64 = std::env::var("SEGMENT_MIN_DURATION_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15000);
    let seg_max_duration_ms: u64 = 28000;
    let segment_results: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let segment_boundary: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
    let segmenter_active = Arc::new(AtomicBool::new(false));
    let last_segment_text: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let worker_feeder_active = Arc::new(AtomicBool::new(false));
    let worker_feeder_handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> =
        Arc::new(Mutex::new(None));

    let audio_buffer_clone = audio_buffer.clone();
    let is_recording_clone = is_recording.clone();
    let is_locked_clone = is_locked.clone();
    let active_trigger_clone = active_trigger.clone();
    let vad_preroll_buffer_clone = vad_preroll_buffer.clone();
    let recording_stream_clone = recording_stream.clone();
    let device_clone = device.clone();
    let config_clone = config.clone();
    let stream_ch = stream_channels;
    let engine_clone = engine.clone();
    let segment_results_clone = segment_results.clone();
    let segment_boundary_clone = segment_boundary.clone();
    let segmenter_active_clone = segmenter_active.clone();
    let last_segment_text_clone = last_segment_text.clone();
    let performance_history_clone = performance_history.clone();

    let (tx, rx) = mpsc::channel::<KeyEvent>();

    let hands_free_mode = std::env::var("MEMO_HANDS_FREE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let use_vad_trigger = hands_free_mode;
    let use_continuous_input = true;
    let vad_preroll_ms: u64 = std::env::var("VAD_PREROLL_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(700);
    let vad_preroll_samples = (sample_rate as u64 * vad_preroll_ms / 1000) as usize;

    if use_continuous_input {
        let vad_ch = stream_ch;
        // Keep the selected input warm so Bluetooth microphones do not lose the
        // beginning of short push-to-talk recordings while their audio link starts.
        let vad_buffer: Arc<Mutex<VecDeque<i16>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(48000)));
        *vad_preroll_buffer.lock().unwrap() = Some(vad_buffer.clone());
        const VAD_BUFFER_MAX_SAMPLES: usize = 48000; // 1 second at 48 kHz
        let vad_speech_threshold: f32 = std::env::var("VAD_SPEECH_THRESHOLD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(800.0);
        let vad_silence_threshold: f32 = std::env::var("VAD_SILENCE_THRESHOLD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600.0);
        let vad_speech_start_ms: u64 = std::env::var("VAD_SPEECH_START_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(200);
        let vad_silence_ms: u64 = std::env::var("VAD_SILENCE_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1200);
        let vad_poll_interval_ms: u64 = 50;
        let samples_per_poll = (sample_rate as u64 * vad_poll_interval_ms / 1000) as usize;

        let vad_buffer_for_stream = vad_buffer.clone();
        let vad_buffer_for_poll = vad_buffer.clone();
        let audio_buffer_vad = audio_buffer_clone.clone();
        let is_recording_vad = is_recording_clone.clone();
        let device_vad = device_clone.clone();
        let config_vad = config_clone.clone();
        let tx_vad = tx.clone();
        let last_audio_level_sent_vad = Arc::new(Mutex::new(None::<Instant>));
        let (stream_ready_tx, stream_ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        // Thread 1: continuous stream — push to vad_buffer and to audio_buffer when recording; send AUDIO_LEVELS for waveform
        std::thread::spawn(move || {
            let stream_config = config_vad.clone().into();
            let last_audio_level_sent_clone = last_audio_level_sent_vad.clone();
            let stream_result = match config_vad.sample_format() {
                cpal::SampleFormat::I16 => device_vad.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let mut mono_frame = Vec::with_capacity(data.len() / vad_ch.max(1));
                        extend_buffer_mono_i16(&mut mono_frame, data, vad_ch);
                        {
                            let mut buf = vad_buffer_for_stream.lock().unwrap();
                            buf.extend(mono_frame.iter().copied());
                            while buf.len() > VAD_BUFFER_MAX_SAMPLES {
                                buf.pop_front();
                            }
                        }
                        if is_recording_vad.load(Ordering::Acquire) {
                            audio_buffer_vad
                                .lock()
                                .unwrap()
                                .extend_from_slice(&mono_frame);
                            let levels = calculate_audio_levels(&mono_frame);
                            let mut last_sent = last_audio_level_sent_clone.lock().unwrap();
                            if should_emit_audio_levels_throttled(
                                &mut *last_sent,
                                memo_audio_levels_interval_ms(),
                            ) {
                                let json = json!(levels).to_string();
                                println_ui_flush!("AUDIO_LEVELS:{}", json);
                            }
                        }
                    },
                    |err| eprintln!("Audio device error: {}", err),
                    None,
                ),
                cpal::SampleFormat::F32 => device_vad.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut mono_frame = Vec::with_capacity(data.len() / vad_ch.max(1));
                        extend_buffer_mono_f32(&mut mono_frame, data, vad_ch);
                        {
                            let mut buf = vad_buffer_for_stream.lock().unwrap();
                            buf.extend(mono_frame.iter().copied());
                            while buf.len() > VAD_BUFFER_MAX_SAMPLES {
                                buf.pop_front();
                            }
                        }
                        if is_recording_vad.load(Ordering::Acquire) {
                            audio_buffer_vad
                                .lock()
                                .unwrap()
                                .extend_from_slice(&mono_frame);
                            let levels = calculate_audio_levels(&mono_frame);
                            let mut last_sent = last_audio_level_sent_clone.lock().unwrap();
                            if should_emit_audio_levels_throttled(
                                &mut *last_sent,
                                memo_audio_levels_interval_ms(),
                            ) {
                                let json = json!(levels).to_string();
                                println_ui_flush!("AUDIO_LEVELS:{}", json);
                            }
                        }
                    },
                    |err| eprintln!("Audio device error: {}", err),
                    None,
                ),
                cpal::SampleFormat::U16 => device_vad.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let mut mono_frame = Vec::with_capacity(data.len() / vad_ch.max(1));
                        extend_buffer_mono_u16(&mut mono_frame, data, vad_ch);
                        {
                            let mut buf = vad_buffer_for_stream.lock().unwrap();
                            buf.extend(mono_frame.iter().copied());
                            while buf.len() > VAD_BUFFER_MAX_SAMPLES {
                                buf.pop_front();
                            }
                        }
                        if is_recording_vad.load(Ordering::Acquire) {
                            audio_buffer_vad
                                .lock()
                                .unwrap()
                                .extend_from_slice(&mono_frame);
                            let levels = calculate_audio_levels(&mono_frame);
                            let mut last_sent = last_audio_level_sent_clone.lock().unwrap();
                            if should_emit_audio_levels_throttled(
                                &mut *last_sent,
                                memo_audio_levels_interval_ms(),
                            ) {
                                let json = json!(levels).to_string();
                                println_ui_flush!("AUDIO_LEVELS:{}", json);
                            }
                        }
                    },
                    |err| eprintln!("Audio device error: {}", err),
                    None,
                ),
                _ => {
                    eprintln!("VAD: unsupported sample format");
                    return;
                }
            };
            match stream_result {
                Ok(stream) => {
                    if let Err(error) = stream.play() {
                        let message = format!(
                            "Audio device error: failed to start selected input: {}",
                            error
                        );
                        let _ = stream_ready_tx.send(Err(message.clone()));
                        eprintln!("{}", message);
                        return;
                    }
                    let _ = stream_ready_tx.send(Ok(()));
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
                Err(error) => {
                    let message = format!(
                        "Audio device error: failed to open selected input: {}",
                        error
                    );
                    let _ = stream_ready_tx.send(Err(message.clone()));
                    eprintln!("{}", message);
                }
            }
        });

        match stream_ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => println_ui_flush!("MIC_READY"),
            Ok(Err(error)) => return Err(error.into()),
            Err(error) => {
                return Err(format!("Selected input did not become ready: {}", error).into())
            }
        }

        // Thread 2: optional VAD polling — RMS, state machine, send StartRecording/StopRecording
        if use_vad_trigger {
            std::thread::spawn(move || {
                let mut state = "idle"; // "idle" | "speech"
                let mut speech_above_ms: u64 = 0;
                let mut silence_below_ms: u64 = 0;
                let poll_duration = std::time::Duration::from_millis(vad_poll_interval_ms);

                loop {
                    std::thread::sleep(poll_duration);
                    let rms = {
                        let buf = vad_buffer_for_poll.lock().unwrap();
                        let len = buf.len();
                        if len >= samples_per_poll {
                            let start = len - samples_per_poll;
                            let slice: Vec<i16> = buf.range(start..).copied().collect();
                            compute_rms(&slice)
                        } else {
                            0.0
                        }
                    };

                    match state {
                        "idle" => {
                            if rms > vad_speech_threshold {
                                speech_above_ms += vad_poll_interval_ms;
                                if speech_above_ms >= vad_speech_start_ms {
                                    state = "speech";
                                    speech_above_ms = 0;
                                    let _ =
                                        tx_vad.send(KeyEvent::StartRecording(TriggerSource::Vad));
                                }
                            } else {
                                speech_above_ms = 0;
                            }
                        }
                        "speech" => {
                            if rms < vad_silence_threshold {
                                silence_below_ms += vad_poll_interval_ms;
                                if silence_below_ms >= vad_silence_ms {
                                    state = "idle";
                                    silence_below_ms = 0;
                                    let _ =
                                        tx_vad.send(KeyEvent::StopRecording(TriggerSource::Vad));
                                }
                            } else {
                                silence_below_ms = 0;
                            }
                        }
                        _ => {}
                    }
                }
            });
        }
    }

    {
        // System mode: keyboard hotkey trigger
        let trigger_pressed = Arc::new(AtomicBool::new(false));
        let control_pressed = Arc::new(AtomicBool::new(false));
        let lock_toggle_processed = Arc::new(AtomicBool::new(false));

        let trigger_pressed_clone = trigger_pressed.clone();
        let control_pressed_clone = control_pressed.clone();
        let lock_toggle_processed_clone = lock_toggle_processed.clone();
        let is_locked_listener = is_locked.clone();

        let trigger_key_for_listener = trigger_key;
        let tx_keyboard = tx.clone();
        std::thread::spawn(move || {
            let listener_result = listen(move |event: Event| match event.event_type {
                EventType::KeyPress(key) if key == trigger_key_for_listener => {
                    trigger_pressed_clone.store(true, Ordering::Release);

                    if control_pressed_clone.load(Ordering::Acquire) {
                        if !lock_toggle_processed_clone.swap(true, Ordering::Acquire) {
                            let _ = tx_keyboard.send(KeyEvent::ToggleLock);
                        }
                    } else {
                        let _ = tx_keyboard.send(KeyEvent::StartRecording(TriggerSource::Manual));
                    }
                }
                EventType::KeyRelease(key) if key == trigger_key_for_listener => {
                    trigger_pressed_clone.store(false, Ordering::Release);
                    lock_toggle_processed_clone.store(false, Ordering::Release);

                    if !is_locked_listener.load(Ordering::Acquire) {
                        let _ = tx_keyboard.send(KeyEvent::StopRecording(TriggerSource::Manual));
                    }
                }
                EventType::KeyPress(Key::ControlLeft) | EventType::KeyPress(Key::ControlRight) => {
                    control_pressed_clone.store(true, Ordering::Release);

                    if trigger_pressed_clone.load(Ordering::Acquire) {
                        if !lock_toggle_processed_clone.swap(true, Ordering::Acquire) {
                            let _ = tx_keyboard.send(KeyEvent::ToggleLock);
                        }
                    }
                }
                EventType::KeyRelease(Key::ControlLeft)
                | EventType::KeyRelease(Key::ControlRight) => {
                    control_pressed_clone.store(false, Ordering::Release);
                    lock_toggle_processed_clone.store(false, Ordering::Release);
                }
                _ => {}
            });
            if let Err(error) = listener_result {
                println_ui_flush!("HOTKEY_ERROR:{:?}", error);
            }
        });

        if hands_free_mode {
            println!("\nTrigger: VAD hands-free plus Function key");
            println!("Speak to start recording, silence to transcribe.");
            println!("Manual: press and hold to record, release to transcribe.");
            println!("Lock: Function+Control to toggle lock (keeps recording on)\n");
        } else {
            println!("\nTrigger: Function key");
            println!("Press and hold to record, release to transcribe.");
            println!("Lock: Function+Control to toggle lock (keeps recording on)\n");
        }
    }

    // Vocabulary storage for voice commands
    #[derive(Clone)]
    struct Vocabulary {
        app_names: Vec<String>,
        app_commands: HashMap<String, Vec<String>>,
        global_commands: Vec<String>,
        boost_words: Vec<String>,
    }

    let vocabulary = Arc::new(Mutex::new(Vocabulary {
        app_names: Vec::new(),
        app_commands: HashMap::new(),
        global_commands: Vec::new(),
        boost_words: Vec::new(),
    }));

    // Build prompt with only the active app's commands (+ global) to avoid hallucination
    let build_prompt =
        |app_name: String, window_title: String, vocab: &Vocabulary| -> Option<String> {
            let mut parts = Vec::new();

            if !app_name.is_empty() && app_name != "Unknown" {
                if !window_title.is_empty() {
                    parts.push(format!(
                        "You are transcribing for {}. The current window is: {}.",
                        app_name, window_title
                    ));
                } else {
                    parts.push(format!("You are transcribing for {}.", app_name));
                }
            }

            if !vocab.app_names.is_empty() {
                parts.push(format!(
                    "Voice commands: open {}.",
                    vocab.app_names.join(", ")
                ));
            }

            let mut active_cmds: Vec<&str> =
                vocab.global_commands.iter().map(|s| s.as_str()).collect();
            if !app_name.is_empty() {
                let key = app_name.to_lowercase();
                if let Some(cmds) = vocab.app_commands.get(&key) {
                    active_cmds.extend(cmds.iter().map(|s| s.as_str()));
                }
            }
            if !active_cmds.is_empty() {
                parts.push(format!("Commands: {}.", active_cmds.join(", ")));
            }

            if !vocab.boost_words.is_empty() {
                parts.push(format!("Vocabulary: {}.", vocab.boost_words.join(", ")));
            }

            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        };

    // Spawn thread to read commands from stdin
    let vocabulary_clone = vocabulary.clone();
    let engine_for_vocab = engine.clone();
    std::thread::spawn(move || {
        use std::io::{self, BufRead};
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            if let Ok(cmd) = line {
                if let Some(value) = cmd.strip_prefix("VOCAB:") {
                    if let Ok(vocab_json) = serde_json::from_str::<serde_json::Value>(value.trim())
                    {
                        let mut vocab = vocabulary_clone.lock().unwrap();
                        vocab.boost_words = vocab_json
                            .get("boostWords")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        vocab.app_names = vocab_json
                            .get("appNames")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        vocab.global_commands = vocab_json
                            .get("globalCommands")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        vocab.app_commands.clear();
                        if let Some(obj) = vocab_json.get("appCommands").and_then(|v| v.as_object())
                        {
                            for (key, val) in obj {
                                if let Some(arr) = val.as_array() {
                                    let cmds: Vec<String> = arr
                                        .iter()
                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                        .collect();
                                    vocab.app_commands.insert(key.clone(), cmds);
                                }
                            }
                        }
                        let contextual_prompt = if vocab.boost_words.is_empty() {
                            None
                        } else {
                            Some(format!("Vocabulary: {}.", vocab.boost_words.join(", ")))
                        };
                        drop(vocab);
                        if std::env::var("MEMO_CONTEXTUAL_VOCAB").as_deref() == Ok("1") {
                            engine_for_vocab
                                .lock()
                                .unwrap()
                                .set_prompt(contextual_prompt);
                        }
                        let vocab = vocabulary_clone.lock().unwrap();
                        eprintln!(
                            "MIC: Vocabulary updated: {} boost words, {} app names, {} apps with commands, {} global commands",
                            vocab.boost_words.len(),
                            vocab.app_names.len(),
                            vocab.app_commands.len(),
                            vocab.global_commands.len()
                        );
                    } else {
                        eprintln!("MIC: Failed to parse VOCAB command");
                    }
                }
            }
        }
    });

    loop {
        match rx.recv() {
            Ok(KeyEvent::StartRecording(source)) => {
                if is_recording_clone
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    *active_trigger_clone.lock().unwrap() = Some(source);
                    println_ui_flush!("🎤 Recording...");
                    audio_buffer_clone.lock().unwrap().clear();
                    if hands_free_mode && source == TriggerSource::Vad {
                        if let Some(preroll) = vad_preroll_buffer_clone.lock().unwrap().clone() {
                            let preroll_samples: Vec<i16> = {
                                let buf = preroll.lock().unwrap();
                                let start = buf.len().saturating_sub(vad_preroll_samples);
                                buf.range(start..).copied().collect()
                            };
                            audio_buffer_clone
                                .lock()
                                .unwrap()
                                .extend_from_slice(&preroll_samples);
                        }
                    }

                    start_worker_live_feeder(
                        engine_clone.clone(),
                        audio_buffer_clone.clone(),
                        worker_feeder_active.clone(),
                        worker_feeder_handle.clone(),
                    );

                    if streaming_enabled {
                        segment_results_clone.lock().unwrap().clear();
                        *segment_boundary_clone.lock().unwrap() = 0;
                        *last_segment_text_clone.lock().unwrap() = None;
                        segmenter_active_clone.store(true, Ordering::Release);

                        let buf_seg = audio_buffer_clone.clone();
                        let boundary_seg = segment_boundary_clone.clone();
                        let active_seg = segmenter_active_clone.clone();
                        let results_seg = segment_results_clone.clone();
                        let engine_seg = engine_clone.clone();
                        let vocab_seg = vocabulary.clone();
                        let prev_text_seg = last_segment_text_clone.clone();
                        let sr = sample_rate;
                        std::thread::spawn(move || {
                            let poll_ms: u64 = 50;
                            let samples_per_poll = (sr as u64 * poll_ms / 1000) as usize;
                            let mut silence_count_ms: u64 = 0;

                            loop {
                                std::thread::sleep(std::time::Duration::from_millis(poll_ms));
                                if !active_seg.load(Ordering::Acquire) {
                                    break;
                                }

                                let buf = buf_seg.lock().unwrap();
                                let current_len = buf.len();
                                let last_boundary = *boundary_seg.lock().unwrap();
                                let segment_samples = current_len.saturating_sub(last_boundary);
                                let segment_dur_ms = (segment_samples as u64 * 1000) / sr as u64;

                                if segment_dur_ms < seg_min_duration_ms {
                                    silence_count_ms = 0;
                                    drop(buf);
                                    continue;
                                }

                                let rms_window = samples_per_poll.min(segment_samples);
                                if rms_window == 0 {
                                    drop(buf);
                                    continue;
                                }
                                let rms = compute_rms(&buf[current_len - rms_window..current_len]);

                                if rms < seg_silence_threshold {
                                    silence_count_ms += poll_ms;
                                } else {
                                    silence_count_ms = 0;
                                }

                                let should_segment = silence_count_ms >= seg_silence_ms
                                    || segment_dur_ms >= seg_max_duration_ms;

                                if should_segment {
                                    let segment_audio: Vec<i16> =
                                        buf[last_boundary..current_len].to_vec();
                                    *boundary_seg.lock().unwrap() = current_len;
                                    drop(buf);
                                    silence_count_ms = 0;

                                    let eng = engine_seg.clone();
                                    let res = results_seg.clone();
                                    let voc = vocab_seg.clone();
                                    let prev_text = prev_text_seg.clone();
                                    std::thread::spawn(move || {
                                        let mut eng = eng.lock().unwrap();
                                        let (app_name, window_title) =
                                            app_detection::get_application_context();
                                        let vocab = voc.lock().unwrap();
                                        let mut prompt =
                                            build_prompt(app_name, window_title, &vocab);
                                        if let Some(ref prev) = *prev_text.lock().unwrap() {
                                            let context = if prev.len() > 200 {
                                                &prev[prev.len() - 200..]
                                            } else {
                                                prev.as_str()
                                            };
                                            prompt = Some(match prompt {
                                                Some(p) => format!("{} {}", p, context),
                                                None => context.to_string(),
                                            });
                                        }
                                        eng.set_prompt(prompt);
                                        match eng.transcribe(&segment_audio) {
                                            Ok(text) if has_meaningful_transcript(&text) => {
                                                let trimmed = text.trim().to_string();
                                                *prev_text.lock().unwrap() = Some(trimmed.clone());
                                                res.lock().unwrap().push(trimmed);
                                                eprintln!(
                                                    "[Streaming] Segment transcribed ({} chars)",
                                                    text.len()
                                                );
                                            }
                                            Ok(_) => eprintln!("[Streaming] Segment had no speech"),
                                            Err(e) => eprintln!("[Streaming] Segment error: {}", e),
                                        }
                                    });
                                } else {
                                    drop(buf);
                                }
                            }
                        });
                    }

                    if !use_continuous_input {
                        let buffer = audio_buffer_clone.clone();
                        let is_recording_for_audio = is_recording_clone.clone();
                        let last_audio_level_sent = Arc::new(Mutex::new(None::<Instant>));
                        let last_audio_level_sent_clone = last_audio_level_sent.clone();
                        let stream_config = config_clone.clone().into();
                        let stream_result = match config_clone.sample_format() {
                            cpal::SampleFormat::I16 => device_clone.build_input_stream(
                                &stream_config,
                                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                    let mut b = buffer.lock().unwrap();
                                    extend_buffer_mono_i16(&mut *b, data, stream_ch);

                                    if is_recording_for_audio.load(Ordering::Acquire) {
                                        let levels = audio_levels_interleaved_i16(data, stream_ch);
                                        let mut last_sent =
                                            last_audio_level_sent_clone.lock().unwrap();
                                        if should_emit_audio_levels_throttled(
                                            &mut *last_sent,
                                            memo_audio_levels_interval_ms(),
                                        ) {
                                            let json = json!(levels).to_string();
                                            println_ui_flush!("AUDIO_LEVELS:{}", json);
                                        }
                                    }
                                },
                                |err| eprintln!("Audio device error: {}", err),
                                None,
                            ),
                            cpal::SampleFormat::F32 => device_clone.build_input_stream(
                                &stream_config,
                                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                    let mut buf = buffer.lock().unwrap();
                                    extend_buffer_mono_f32(&mut *buf, data, stream_ch);

                                    if is_recording_for_audio.load(Ordering::Acquire) {
                                        let levels = audio_levels_interleaved_f32(data, stream_ch);
                                        let mut last_sent =
                                            last_audio_level_sent_clone.lock().unwrap();
                                        if should_emit_audio_levels_throttled(
                                            &mut *last_sent,
                                            memo_audio_levels_interval_ms(),
                                        ) {
                                            let json = json!(levels).to_string();
                                            println_ui_flush!("AUDIO_LEVELS:{}", json);
                                        }
                                    }
                                },
                                |err| eprintln!("Audio device error: {}", err),
                                None,
                            ),
                            cpal::SampleFormat::U16 => device_clone.build_input_stream(
                                &stream_config,
                                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                                    let mut buf = buffer.lock().unwrap();
                                    extend_buffer_mono_u16(&mut *buf, data, stream_ch);

                                    if is_recording_for_audio.load(Ordering::Acquire) {
                                        let levels = audio_levels_interleaved_u16(data, stream_ch);
                                        let mut last_sent =
                                            last_audio_level_sent_clone.lock().unwrap();
                                        if should_emit_audio_levels_throttled(
                                            &mut *last_sent,
                                            memo_audio_levels_interval_ms(),
                                        ) {
                                            let json = json!(levels).to_string();
                                            println_ui_flush!("AUDIO_LEVELS:{}", json);
                                        }
                                    }
                                },
                                |err| eprintln!("Audio device error: {}", err),
                                None,
                            ),
                            _ => {
                                eprintln!("Unsupported format");
                                continue;
                            }
                        };

                        match stream_result {
                            Ok(stream) => {
                                match stream.play() {
                                    Ok(()) => {
                                        *recording_stream_clone.lock().unwrap() = Some(stream);
                                    }
                                    Err(error) => {
                                        eprintln!("Audio device error: failed to start selected input: {}", error);
                                        is_recording_clone.store(false, Ordering::SeqCst);
                                        *active_trigger_clone.lock().unwrap() = None;
                                    }
                                }
                            }
                            Err(error) => {
                                eprintln!(
                                    "Audio device error: failed to open selected input: {}",
                                    error
                                );
                                is_recording_clone.store(false, Ordering::SeqCst);
                                *active_trigger_clone.lock().unwrap() = None;
                            }
                        }
                    }
                }
            }
            Ok(KeyEvent::StopRecording(source)) => {
                let should_stop = {
                    let active = *active_trigger_clone.lock().unwrap();
                    !is_locked_clone.load(Ordering::Acquire) && active == Some(source)
                };
                if !should_stop {
                    continue;
                }

                if is_recording_clone
                    .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    *active_trigger_clone.lock().unwrap() = None;
                    segmenter_active_clone.store(false, Ordering::Release);

                    if !use_continuous_input {
                        recording_stream_clone.lock().unwrap().take();
                    }

                    stop_worker_live_feeder(&worker_feeder_active, &worker_feeder_handle);

                    let samples = {
                        let mut buf = audio_buffer_clone.lock().unwrap();
                        std::mem::take(&mut *buf)
                    };

                    if samples.is_empty() {
                        engine_clone.lock().unwrap().abort_live_stream();
                    }

                    let streaming_boundary = if streaming_enabled {
                        *segment_boundary_clone.lock().unwrap()
                    } else {
                        0
                    };

                    if !samples.is_empty() {
                        emit_saved_audio(&samples, sample_rate);

                        // Spawn transcription thread immediately for fastest response
                        let engine_for_thread = engine_clone.clone();
                        let perf_history = performance_history_clone.clone();
                        let vocabulary_for_thread = vocabulary.clone();
                        let segment_results_for_thread = segment_results_clone.clone();
                        let last_seg_text_for_thread = last_segment_text_clone.clone();
                        let sample_count = samples.len();
                        let audio_duration = sample_count as f32 / sample_rate as f32;
                        let start_time = Instant::now();
                        std::thread::spawn(move || {
                            println_ui_flush!(
                                "⏹️  Stopped ({} samples, {:.2}s)",
                                sample_count,
                                audio_duration
                            );
                            println!("🔄 Transcribing...");
                            let mut eng = engine_for_thread.lock().unwrap();

                            // Capture application context and vocabulary before transcribing
                            let (app_name, window_title) = app_detection::get_application_context();
                            let vocab = vocabulary_for_thread.lock().unwrap();
                            let mut prompt =
                                build_prompt(app_name.clone(), window_title.clone(), &vocab);
                            if streaming_boundary > 0 {
                                if let Some(ref prev) = *last_seg_text_for_thread.lock().unwrap() {
                                    let context = if prev.len() > 200 {
                                        &prev[prev.len() - 200..]
                                    } else {
                                        prev.as_str()
                                    };
                                    prompt = Some(match prompt {
                                        Some(p) => format!("{} {}", p, context),
                                        None => context.to_string(),
                                    });
                                }
                            }
                            eng.set_prompt(prompt);

                            let accumulated_segments = if streaming_boundary > 0 {
                                std::mem::take(&mut *segment_results_for_thread.lock().unwrap())
                            } else {
                                Vec::new()
                            };
                            let pre_processed_count = accumulated_segments.len();

                            let transcribe_start = Instant::now();
                            let transcribe_result = if streaming_boundary > 0 {
                                let final_text = if streaming_boundary < samples.len()
                                    && samples.len() - streaming_boundary >= sample_rate as usize
                                {
                                    eng.transcribe(&samples[streaming_boundary..])
                                        .unwrap_or_default()
                                } else if streaming_boundary < samples.len() {
                                    String::new()
                                } else {
                                    String::new()
                                };
                                let mut parts = accumulated_segments;
                                if !final_text.trim().is_empty() {
                                    parts.push(final_text.trim().to_string());
                                }
                                let combined = join_segments(&parts);
                                if !has_meaningful_transcript(&combined) {
                                    eng.transcribe(&samples)
                                } else {
                                    if pre_processed_count > 0 {
                                        eprintln!("[Streaming] {} segments pre-processed, final segment transcribed", pre_processed_count);
                                    }
                                    Ok(combined)
                                }
                            } else {
                                eng.transcribe(&samples)
                            };
                            match transcribe_result {
                                Ok(text) => {
                                    let transcribe_time = transcribe_start.elapsed();
                                    let realtime_factor =
                                        audio_duration / transcribe_time.as_secs_f32();

                                    // Update performance history
                                    {
                                        let mut history = perf_history.lock().unwrap();
                                        history.push_back((audio_duration, realtime_factor));
                                        if history.len() > 10 {
                                            history.pop_front();
                                        }
                                    }

                                    // Calculate rate of increase
                                    let rate_info = {
                                        let history = perf_history.lock().unwrap();
                                        let history_vec: Vec<(f32, f32)> =
                                            history.iter().copied().collect();
                                        if history_vec.len() >= 2 {
                                            if let Some(rate) =
                                                calculate_rate_of_increase(&history_vec)
                                            {
                                                let predicted_30s = history_vec.last().unwrap().1
                                                    + rate * (30.0 - history_vec.last().unwrap().0);
                                                let predicted_60s = history_vec.last().unwrap().1
                                                    + rate * (60.0 - history_vec.last().unwrap().0);
                                                Some((rate, predicted_30s, predicted_60s))
                                            } else {
                                                None
                                            }
                                        } else {
                                            None
                                        }
                                    };

                                    if text.trim().is_empty() {
                                        println!("📝 (no speech detected)");
                                        println!(
                                            "⏱️  Transcription: {:.2}ms ({:.2}x realtime)",
                                            transcribe_time.as_secs_f32() * 1000.0,
                                            realtime_factor
                                        );
                                        if let Some((rate, pred_30, pred_60)) = rate_info {
                                            println!("📈 Rate: +{:.2}x per second | Predicted: {:.1}x @ 30s, {:.1}x @ 60s\n", rate, pred_30, pred_60);
                                        } else {
                                            println!();
                                        }
                                    } else {
                                        // Process text to strip periods from short phrases
                                        let processed_text =
                                            strip_leading_dash_space(&strip_trailing_signoffs(
                                                &strip_periods_from_short_phrases(&text),
                                            ));

                                        // Output FINAL: JSON for Electron app integration
                                        let json_output = json!({
                                            "rawTranscript": text,
                                            "processedText": processed_text,
                                            "wasProcessedByLLM": false,
                                            "appContext": {
                                                "appName": app_name,
                                                "windowTitle": window_title
                                            }
                                        });
                                        println!("FINAL: {}", json_output);

                                        let total_time = start_time.elapsed();
                                        println!("📝 {}", text);
                                        println!("⏱️  Transcription: {:.2}ms ({:.2}x realtime) | Total: {:.2}ms",
                                                transcribe_time.as_secs_f32() * 1000.0,
                                                realtime_factor,
                                                total_time.as_secs_f32() * 1000.0);
                                        if let Some((rate, pred_30, pred_60)) = rate_info {
                                            println!("📈 Rate: +{:.2}x per second | Predicted: {:.1}x @ 30s, {:.1}x @ 60s\n", rate, pred_30, pred_60);
                                        } else {
                                            println!();
                                        }
                                    }
                                }
                                Err(e) => {
                                    let total_time = start_time.elapsed();
                                    eprintln!("❌ Error: {}", e);
                                    println!(
                                        "⏱️  Total time: {:.2}ms\n",
                                        total_time.as_secs_f32() * 1000.0
                                    );
                                }
                            }
                        });
                    }
                }
            }
            Ok(KeyEvent::ToggleLock) => {
                let was_locked = is_locked_clone.load(Ordering::Acquire);
                let now_locked = !was_locked;
                is_locked_clone.store(now_locked, Ordering::Release);

                if now_locked {
                    // Locking: ensure recording is on
                    println!("🔒 Locked - recording will continue until unlocked");
                    *active_trigger_clone.lock().unwrap() = Some(TriggerSource::Lock);
                    if !is_recording_clone.load(Ordering::Acquire) {
                        // Start recording if not already recording
                        // Manually trigger start recording logic
                        if is_recording_clone
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            println_ui_flush!("🎤 Recording...");
                            audio_buffer_clone.lock().unwrap().clear();
                            start_worker_live_feeder(
                                engine_clone.clone(),
                                audio_buffer_clone.clone(),
                                worker_feeder_active.clone(),
                                worker_feeder_handle.clone(),
                            );

                            if streaming_enabled {
                                segment_results_clone.lock().unwrap().clear();
                                *segment_boundary_clone.lock().unwrap() = 0;
                                *last_segment_text_clone.lock().unwrap() = None;
                                segmenter_active_clone.store(true, Ordering::Release);

                                let buf_seg = audio_buffer_clone.clone();
                                let boundary_seg = segment_boundary_clone.clone();
                                let active_seg = segmenter_active_clone.clone();
                                let results_seg = segment_results_clone.clone();
                                let engine_seg = engine_clone.clone();
                                let vocab_seg = vocabulary.clone();
                                let prev_text_seg = last_segment_text_clone.clone();
                                let sr = sample_rate;
                                std::thread::spawn(move || {
                                    let poll_ms: u64 = 50;
                                    let samples_per_poll = (sr as u64 * poll_ms / 1000) as usize;
                                    let mut silence_count_ms: u64 = 0;
                                    loop {
                                        std::thread::sleep(std::time::Duration::from_millis(
                                            poll_ms,
                                        ));
                                        if !active_seg.load(Ordering::Acquire) {
                                            break;
                                        }
                                        let buf = buf_seg.lock().unwrap();
                                        let current_len = buf.len();
                                        let last_boundary = *boundary_seg.lock().unwrap();
                                        let segment_samples =
                                            current_len.saturating_sub(last_boundary);
                                        let segment_dur_ms =
                                            (segment_samples as u64 * 1000) / sr as u64;
                                        if segment_dur_ms < seg_min_duration_ms {
                                            silence_count_ms = 0;
                                            drop(buf);
                                            continue;
                                        }
                                        let rms_window = samples_per_poll.min(segment_samples);
                                        if rms_window == 0 {
                                            drop(buf);
                                            continue;
                                        }
                                        let rms = compute_rms(
                                            &buf[current_len - rms_window..current_len],
                                        );
                                        if rms < seg_silence_threshold {
                                            silence_count_ms += poll_ms;
                                        } else {
                                            silence_count_ms = 0;
                                        }
                                        let should_segment = silence_count_ms >= seg_silence_ms
                                            || segment_dur_ms >= seg_max_duration_ms;
                                        if should_segment {
                                            let segment_audio: Vec<i16> =
                                                buf[last_boundary..current_len].to_vec();
                                            *boundary_seg.lock().unwrap() = current_len;
                                            drop(buf);
                                            silence_count_ms = 0;
                                            let eng = engine_seg.clone();
                                            let res = results_seg.clone();
                                            let voc = vocab_seg.clone();
                                            let prev_text = prev_text_seg.clone();
                                            std::thread::spawn(move || {
                                                let mut eng = eng.lock().unwrap();
                                                let (app_name, window_title) =
                                                    app_detection::get_application_context();
                                                let vocab = voc.lock().unwrap();
                                                let mut prompt =
                                                    build_prompt(app_name, window_title, &vocab);
                                                if let Some(ref prev) = *prev_text.lock().unwrap() {
                                                    let context = if prev.len() > 200 {
                                                        &prev[prev.len() - 200..]
                                                    } else {
                                                        prev.as_str()
                                                    };
                                                    prompt = Some(match prompt {
                                                        Some(p) => format!("{} {}", p, context),
                                                        None => context.to_string(),
                                                    });
                                                }
                                                eng.set_prompt(prompt);
                                                match eng.transcribe(&segment_audio) {
                                                    Ok(text)
                                                        if has_meaningful_transcript(&text) =>
                                                    {
                                                        let trimmed = text.trim().to_string();
                                                        *prev_text.lock().unwrap() =
                                                            Some(trimmed.clone());
                                                        res.lock().unwrap().push(trimmed);
                                                        eprintln!("[Streaming] Segment transcribed ({} chars)", text.len());
                                                    }
                                                    Ok(_) => eprintln!(
                                                        "[Streaming] Segment had no speech"
                                                    ),
                                                    Err(e) => eprintln!(
                                                        "[Streaming] Segment error: {}",
                                                        e
                                                    ),
                                                }
                                            });
                                        } else {
                                            drop(buf);
                                        }
                                    }
                                });
                            }

                            if !use_continuous_input {
                                let buffer = audio_buffer_clone.clone();
                                let is_recording_for_audio_lock = is_recording_clone.clone();
                                let last_audio_level_sent_lock =
                                    Arc::new(Mutex::new(None::<Instant>));
                                let last_audio_level_sent_lock_clone =
                                    last_audio_level_sent_lock.clone();
                                let stream_config = config_clone.clone().into();
                                let stream_result = match config_clone.sample_format() {
                                    cpal::SampleFormat::I16 => device_clone.build_input_stream(
                                        &stream_config,
                                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                            let mut b = buffer.lock().unwrap();
                                            extend_buffer_mono_i16(&mut *b, data, stream_ch);

                                            if is_recording_for_audio_lock.load(Ordering::Acquire) {
                                                let levels =
                                                    audio_levels_interleaved_i16(data, stream_ch);
                                                let mut last_sent =
                                                    last_audio_level_sent_lock_clone
                                                        .lock()
                                                        .unwrap();
                                                if should_emit_audio_levels_throttled(
                                                    &mut *last_sent,
                                                    memo_audio_levels_interval_ms(),
                                                ) {
                                                    let json = json!(levels).to_string();
                                                    println_ui_flush!("AUDIO_LEVELS:{}", json);
                                                }
                                            }
                                        },
                                        |err| eprintln!("Audio device error: {}", err),
                                        None,
                                    ),
                                    cpal::SampleFormat::F32 => device_clone.build_input_stream(
                                        &stream_config,
                                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                            let mut buf = buffer.lock().unwrap();
                                            extend_buffer_mono_f32(&mut *buf, data, stream_ch);

                                            if is_recording_for_audio_lock.load(Ordering::Acquire) {
                                                let levels =
                                                    audio_levels_interleaved_f32(data, stream_ch);
                                                let mut last_sent =
                                                    last_audio_level_sent_lock_clone
                                                        .lock()
                                                        .unwrap();
                                                if should_emit_audio_levels_throttled(
                                                    &mut *last_sent,
                                                    memo_audio_levels_interval_ms(),
                                                ) {
                                                    let json = json!(levels).to_string();
                                                    println_ui_flush!("AUDIO_LEVELS:{}", json);
                                                }
                                            }
                                        },
                                        |err| eprintln!("Audio device error: {}", err),
                                        None,
                                    ),
                                    cpal::SampleFormat::U16 => device_clone.build_input_stream(
                                        &stream_config,
                                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                                            let mut buf = buffer.lock().unwrap();
                                            extend_buffer_mono_u16(&mut *buf, data, stream_ch);

                                            if is_recording_for_audio_lock.load(Ordering::Acquire) {
                                                let levels =
                                                    audio_levels_interleaved_u16(data, stream_ch);
                                                let mut last_sent =
                                                    last_audio_level_sent_lock_clone
                                                        .lock()
                                                        .unwrap();
                                                if should_emit_audio_levels_throttled(
                                                    &mut *last_sent,
                                                    memo_audio_levels_interval_ms(),
                                                ) {
                                                    let json = json!(levels).to_string();
                                                    println_ui_flush!("AUDIO_LEVELS:{}", json);
                                                }
                                            }
                                        },
                                        |err| eprintln!("Audio device error: {}", err),
                                        None,
                                    ),
                                    _ => {
                                        eprintln!("Unsupported format");
                                        continue;
                                    }
                                };

                                match stream_result {
                                    Ok(stream) => match stream.play() {
                                        Ok(()) => {
                                            *recording_stream_clone.lock().unwrap() = Some(stream);
                                        }
                                        Err(error) => {
                                            eprintln!("Audio device error: failed to start selected input: {}", error);
                                            is_recording_clone.store(false, Ordering::SeqCst);
                                            *active_trigger_clone.lock().unwrap() = None;
                                        }
                                    },
                                    Err(error) => {
                                        eprintln!(
                                            "Audio device error: failed to open selected input: {}",
                                            error
                                        );
                                        is_recording_clone.store(false, Ordering::SeqCst);
                                        *active_trigger_clone.lock().unwrap() = None;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // Unlocking: stop recording
                    println!("🔓 Unlocked");
                    if is_recording_clone.load(Ordering::Acquire) {
                        // Manually trigger stop recording logic
                        if is_recording_clone
                            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            segmenter_active_clone.store(false, Ordering::Release);
                            *active_trigger_clone.lock().unwrap() = None;
                            if !use_continuous_input {
                                recording_stream_clone.lock().unwrap().take();
                            }

                            stop_worker_live_feeder(&worker_feeder_active, &worker_feeder_handle);

                            let samples = {
                                let mut buf = audio_buffer_clone.lock().unwrap();
                                std::mem::take(&mut *buf)
                            };

                            if samples.is_empty() {
                                engine_clone.lock().unwrap().abort_live_stream();
                            }

                            let streaming_boundary = if streaming_enabled {
                                *segment_boundary_clone.lock().unwrap()
                            } else {
                                0
                            };

                            if !samples.is_empty() {
                                emit_saved_audio(&samples, sample_rate);

                                // Spawn transcription thread immediately for fastest response
                                let engine_for_thread = engine_clone.clone();
                                let perf_history = performance_history_clone.clone();
                                let vocabulary_for_thread = vocabulary.clone();
                                let segment_results_for_thread = segment_results_clone.clone();
                                let last_seg_text_for_thread = last_segment_text_clone.clone();
                                let sample_count = samples.len();
                                let audio_duration = sample_count as f32 / sample_rate as f32;
                                let start_time = Instant::now();
                                std::thread::spawn(move || {
                                    println_ui_flush!(
                                        "⏹️  Stopped ({} samples, {:.2}s)",
                                        sample_count,
                                        audio_duration
                                    );
                                    println!("🔄 Transcribing...");
                                    let mut eng = engine_for_thread.lock().unwrap();

                                    // Capture application context and vocabulary before transcribing
                                    let (app_name, window_title) =
                                        app_detection::get_application_context();
                                    let vocab = vocabulary_for_thread.lock().unwrap();
                                    let mut prompt = build_prompt(
                                        app_name.clone(),
                                        window_title.clone(),
                                        &vocab,
                                    );
                                    if streaming_boundary > 0 {
                                        if let Some(ref prev) =
                                            *last_seg_text_for_thread.lock().unwrap()
                                        {
                                            let context = if prev.len() > 200 {
                                                &prev[prev.len() - 200..]
                                            } else {
                                                prev.as_str()
                                            };
                                            prompt = Some(match prompt {
                                                Some(p) => format!("{} {}", p, context),
                                                None => context.to_string(),
                                            });
                                        }
                                    }
                                    eng.set_prompt(prompt);

                                    let accumulated_segments = if streaming_boundary > 0 {
                                        std::mem::take(
                                            &mut *segment_results_for_thread.lock().unwrap(),
                                        )
                                    } else {
                                        Vec::new()
                                    };
                                    let pre_processed_count = accumulated_segments.len();

                                    let transcribe_start = Instant::now();
                                    let transcribe_result = if streaming_boundary > 0 {
                                        let final_text = if streaming_boundary < samples.len()
                                            && samples.len() - streaming_boundary
                                                >= sample_rate as usize
                                        {
                                            eng.transcribe(&samples[streaming_boundary..])
                                                .unwrap_or_default()
                                        } else if streaming_boundary < samples.len() {
                                            String::new()
                                        } else {
                                            String::new()
                                        };
                                        let mut parts = accumulated_segments;
                                        if !final_text.trim().is_empty() {
                                            parts.push(final_text.trim().to_string());
                                        }
                                        let combined = join_segments(&parts);
                                        if !has_meaningful_transcript(&combined) {
                                            eng.transcribe(&samples)
                                        } else {
                                            if pre_processed_count > 0 {
                                                eprintln!("[Streaming] {} segments pre-processed, final segment transcribed", pre_processed_count);
                                            }
                                            Ok(combined)
                                        }
                                    } else {
                                        eng.transcribe(&samples)
                                    };
                                    match transcribe_result {
                                        Ok(text) => {
                                            let transcribe_time = transcribe_start.elapsed();
                                            let realtime_factor =
                                                audio_duration / transcribe_time.as_secs_f32();

                                            // Update performance history
                                            {
                                                let mut history = perf_history.lock().unwrap();
                                                history
                                                    .push_back((audio_duration, realtime_factor));
                                                if history.len() > 10 {
                                                    history.pop_front();
                                                }
                                            }

                                            // Calculate rate of increase
                                            let rate_info = {
                                                let history = perf_history.lock().unwrap();
                                                let history_vec: Vec<(f32, f32)> =
                                                    history.iter().copied().collect();
                                                if history_vec.len() >= 2 {
                                                    if let Some(rate) =
                                                        calculate_rate_of_increase(&history_vec)
                                                    {
                                                        let predicted_30s =
                                                            history_vec.last().unwrap().1
                                                                + rate
                                                                    * (30.0
                                                                        - history_vec
                                                                            .last()
                                                                            .unwrap()
                                                                            .0);
                                                        let predicted_60s =
                                                            history_vec.last().unwrap().1
                                                                + rate
                                                                    * (60.0
                                                                        - history_vec
                                                                            .last()
                                                                            .unwrap()
                                                                            .0);
                                                        Some((rate, predicted_30s, predicted_60s))
                                                    } else {
                                                        None
                                                    }
                                                } else {
                                                    None
                                                }
                                            };

                                            if text.trim().is_empty() {
                                                println!("📝 (no speech detected)");
                                                println!(
                                                    "⏱️  Transcription: {:.2}ms ({:.2}x realtime)",
                                                    transcribe_time.as_secs_f32() * 1000.0,
                                                    realtime_factor
                                                );
                                                if let Some((rate, pred_30, pred_60)) = rate_info {
                                                    println!("📈 Rate: +{:.2}x per second | Predicted: {:.1}x @ 30s, {:.1}x @ 60s\n", rate, pred_30, pred_60);
                                                } else {
                                                    println!();
                                                }
                                            } else {
                                                // Process text to strip periods from short phrases
                                                let processed_text = strip_leading_dash_space(
                                                    &strip_trailing_signoffs(
                                                        &strip_periods_from_short_phrases(&text),
                                                    ),
                                                );

                                                // Output FINAL: JSON for Electron app integration
                                                let json_output = json!({
                                                    "rawTranscript": text,
                                                    "processedText": processed_text,
                                                    "wasProcessedByLLM": false,
                                                    "appContext": {
                                                        "appName": app_name,
                                                        "windowTitle": window_title
                                                    }
                                                });
                                                println!("FINAL: {}", json_output);

                                                let total_time = start_time.elapsed();
                                                println!("📝 {}", text);
                                                println!("⏱️  Transcription: {:.2}ms ({:.2}x realtime) | Total: {:.2}ms",
                                                        transcribe_time.as_secs_f32() * 1000.0,
                                                        realtime_factor,
                                                        total_time.as_secs_f32() * 1000.0);
                                                if let Some((rate, pred_30, pred_60)) = rate_info {
                                                    println!("📈 Rate: +{:.2}x per second | Predicted: {:.1}x @ 30s, {:.1}x @ 60s\n", rate, pred_30, pred_60);
                                                } else {
                                                    println!();
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            let total_time = start_time.elapsed();
                                            eprintln!("❌ Error: {}", e);
                                            println!(
                                                "⏱️  Total time: {:.2}ms\n",
                                                total_time.as_secs_f32() * 1000.0
                                            );
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Error: {:?}", e);
                return Err(e.into());
            }
        }
    }
}

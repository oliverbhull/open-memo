//! Short-lived native helpers also used by Electron before dictation starts.
use cpal::traits::{DeviceTrait, HostTrait};

pub fn run() -> Result<bool, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--list-inputs") {
        let host = cpal::default_host();
        let default = host.default_input_device().and_then(|d| d.name().ok());
        let devices: Vec<_> = host.input_devices()?.filter_map(|d| d.name().ok())
            .map(|name| serde_json::json!({"isDefault": default.as_ref() == Some(&name), "name": name})).collect();
        println!("{}", serde_json::to_string(&devices)?);
        return Ok(true);
    }
    #[cfg(windows)]
    if args.iter().any(|arg| arg == "--paste") {
        use rdev::{simulate, EventType, Key};
        // Send to the current foreground control; never interpolate dictated text.
        for event in [
            EventType::KeyPress(Key::ControlLeft),
            EventType::KeyPress(Key::KeyV),
            EventType::KeyRelease(Key::KeyV),
            EventType::KeyRelease(Key::ControlLeft),
        ] {
            if let Err(error) = simulate(&event) {
                let _ = simulate(&EventType::KeyRelease(Key::KeyV));
                let _ = simulate(&EventType::KeyRelease(Key::ControlLeft));
                return Err(format!("Windows paste failed: {error:?}").into());
            }
        }
        if args.iter().any(|arg| arg == "--enter") {
            std::thread::sleep(std::time::Duration::from_millis(50));
            simulate(&EventType::KeyPress(Key::Return))
                .map_err(|e| format!("Enter failed: {e:?}"))?;
            simulate(&EventType::KeyRelease(Key::Return))
                .map_err(|e| format!("Enter release failed: {e:?}"))?;
        }
        println!("pasted");
        return Ok(true);
    }
    Ok(false)
}

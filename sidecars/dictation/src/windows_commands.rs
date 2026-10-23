//! Short-lived native helpers also used by Electron before dictation starts.
use cpal::traits::{DeviceTrait, HostTrait};

#[cfg(windows)]
fn window_context(window: isize) -> serde_json::Value {
    let (app_name, window_title, app_path) = crate::app_detection::windows::context_with_path_for_window(window);
    let mut context = serde_json::json!({"appName": app_name, "windowTitle": window_title});
    if let Some(app_path) = app_path { context["appPath"] = app_path.into(); }
    context
}

pub fn run() -> Result<bool, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    #[cfg(windows)]
    if let Some(index) = args.iter().position(|arg| arg == "--resolve-app") {
        let path = args.get(index + 1).and_then(|name| crate::app_detection::windows::resolve_visible_application(name));
        let result = match path {
            Some(path) => serde_json::json!({"appPath": path}),
            None => serde_json::json!({}),
        };
        println!("{result}");
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--app-context") {
        #[cfg(windows)]
        println!("{}", window_context(crate::app_detection::windows::foreground_window()));
        #[cfg(not(windows))]
        {
        let (app_name, window_title) = crate::app_detection::get_application_context();
        println!("{}", serde_json::json!({"appName": app_name, "windowTitle": window_title}));
        }
        return Ok(true);
    }
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
        use crate::app_detection::windows::foreground_window;
        let target = foreground_window();
        let app_context = window_context(target);
        // Resolve metadata from this exact HWND; abort if focus changes while
        // reading it, so history never attributes a paste to a different app.
        if target == 0 || foreground_window() != target {
            println!("{}", serde_json::json!({"status": "foreground_changed", "appContext": app_context}));
            return Ok(true);
        }
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
            if foreground_window() == target {
                simulate(&EventType::KeyPress(Key::Return))
                    .map_err(|e| format!("Enter failed: {e:?}"))?;
                simulate(&EventType::KeyRelease(Key::Return))
                    .map_err(|e| format!("Enter release failed: {e:?}"))?;
            }
        }
        println!("{}", serde_json::json!({"status": "pasted", "appContext": app_context}));
        return Ok(true);
    }
    Ok(false)
}

//! Fast, best-effort foreground application metadata.
//!
//! The transcription path never launches AppleScript. AppKit gives us a fresh
//! foreground application identity without requiring Accessibility permission.
//! Window titles intentionally remain empty here. The main process records the
//! actual focused window in the same operation that delivers the paste.

#[cfg(target_os = "macos")]
mod macos {
    use objc::rc::autoreleasepool;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    fn frontmost_application_name() -> Option<String> {
        autoreleasepool(|| unsafe {
            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }

            let app: *mut Object = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }

            let name: *mut Object = msg_send![app, localizedName];
            if name.is_null() {
                return None;
            }

            let utf8: *const std::ffi::c_char = msg_send![name, UTF8String];
            if utf8.is_null() {
                return None;
            }

            Some(
                std::ffi::CStr::from_ptr(utf8)
                    .to_string_lossy()
                    .into_owned(),
            )
        })
    }

    pub fn application_context() -> (String, String) {
        (
            frontmost_application_name().unwrap_or_else(|| "Unknown".to_string()),
            String::new(),
        )
    }

    #[cfg(test)]
    mod tests {
        use std::process::Command;
        use std::time::{Duration, Instant};

        use super::application_context;

        #[test]
        #[ignore = "requires a live macOS foreground app"]
        fn application_context_lookup_is_bounded_and_matches_system_events() {
            let started = Instant::now();
            let (app_name, window_title) = application_context();
            let elapsed = started.elapsed();
            assert_ne!(app_name, "Unknown");
            assert!(window_title.is_empty());
            assert!(elapsed < Duration::from_millis(20));
            eprintln!(
                "native application context lookup ms: {:.3}",
                elapsed.as_secs_f64() * 1_000.0
            );

            let output = Command::new("osascript")
                .arg("-e")
                .arg("tell application \"System Events\" to get name of first application process whose frontmost is true")
                .env("MEMO_NATIVE_APP_NAME", &app_name)
                .output()
                .expect("System Events app-name comparison should run");
            assert!(output.status.success());
            let system_events_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            eprintln!(
                "native app matches System Events: {}",
                app_name == system_events_name
            );
            assert_eq!(app_name, system_events_name);
        }
    }
}

pub fn get_application_context() -> (String, String) {
    #[cfg(target_os = "macos")]
    {
        return macos::application_context();
    }

    #[cfg(not(target_os = "macos"))]
    {
        ("Unknown".to_string(), String::new())
    }
}

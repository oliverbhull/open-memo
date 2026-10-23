//! Fast, best-effort foreground application metadata.
//!
//! The transcription path never launches AppleScript. AppKit gives us a fresh
//! foreground application identity without requiring Accessibility permission.
//! macOS titles remain empty here; the delivery operation resolves its window.
//! Windows resolves title and executable metadata from one foreground HWND,
//! including during the native paste operation.

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

#[cfg(windows)]
pub mod windows {
    use std::{ffi::c_void, os::windows::ffi::{OsStrExt, OsStringExt}, path::Path};

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowTextLengthW(window: isize) -> i32;
        fn GetWindowTextW(window: isize, text: *mut u16, length: i32) -> i32;
        fn GetWindowThreadProcessId(window: isize, process_id: *mut u32) -> u32;
        fn IsWindowVisible(window: isize) -> i32;
        fn EnumWindows(callback: unsafe extern "system" fn(isize, isize) -> i32, parameter: isize) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> isize;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "version")]
    unsafe extern "system" {
        fn GetFileVersionInfoSizeW(file: *const u16, handle: *mut u32) -> u32;
        fn GetFileVersionInfoW(file: *const u16, handle: u32, size: u32, data: *mut c_void) -> i32;
        fn VerQueryValueW(data: *const c_void, query: *const u16, value: *mut *mut c_void, size: *mut u32) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub fn foreground_window() -> isize {
        unsafe { GetForegroundWindow() }
    }

    fn file_description(file: &Path) -> Option<String> {
        let file_wide: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let size = GetFileVersionInfoSizeW(file_wide.as_ptr(), std::ptr::null_mut());
            if size == 0 { return None; }
            let mut data = vec![0u8; size as usize];
            if GetFileVersionInfoW(file_wide.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 { return None; }
            let mut value = std::ptr::null_mut();
            let mut length = 0;
            let mut translations = Vec::new();
            if VerQueryValueW(data.as_ptr().cast(), wide("\\VarFileInfo\\Translation").as_ptr(), &mut value, &mut length) != 0 && !value.is_null() {
                for pair in std::slice::from_raw_parts(value.cast::<u16>(), length as usize / 2).chunks_exact(2) {
                    translations.push((pair[0], pair[1]));
                }
            }
            translations.extend([(0x0409, 0x04b0), (0x0409, 0x04e4)]);
            for (language, codepage) in translations {
                let query = wide(&format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription"));
                if VerQueryValueW(data.as_ptr().cast(), query.as_ptr(), &mut value, &mut length) != 0 && !value.is_null() && length > 0 {
                    let text = String::from_utf16_lossy(std::slice::from_raw_parts(value.cast::<u16>(), length as usize));
                    let text = text.trim_matches('\0').trim();
                    if !text.is_empty() { return Some(text.to_owned()); }
                }
            }
            None
        }
    }

    fn executable_for_window(window: isize) -> Option<std::path::PathBuf> {
        if window == 0 { return None; }
        unsafe {
            let mut process_id = 0;
            GetWindowThreadProcessId(window, &mut process_id);
            let process = OpenProcess(0x1000, 0, process_id); // PROCESS_QUERY_LIMITED_INFORMATION
            if process == 0 { return None; }
            let mut image = vec![0u16; 32768];
            let mut length = image.len() as u32;
            let found = QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) != 0;
            CloseHandle(process);
            if !found { return None; }
            Some(std::ffi::OsString::from_wide(&image[..length as usize]).into())
        }
    }

    pub fn context_with_path_for_window(window: isize) -> (String, String, Option<String>) {
        if window == 0 { return ("Unknown".to_owned(), String::new(), None); }
        let title = unsafe {
            let mut title = vec![0u16; (GetWindowTextLengthW(window).max(0) as usize + 1).min(32768)];
            let count = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
            String::from_utf16_lossy(&title[..count])
        };
        let Some(image) = executable_for_window(window) else {
            return ("Unknown".to_owned(), title, None);
        };
        let name = file_description(&image).or_else(|| image.file_stem().map(|stem| stem.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Unknown".to_owned());
        (name, title, Some(image.to_string_lossy().into_owned()))
    }

    pub fn context_for_window(window: isize) -> (String, String) {
        let (name, title, _) = context_with_path_for_window(window);
        (name, title)
    }

    fn unique_matching_executable<'a>(requested: &str, contexts: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<String> {
        let requested = requested.to_lowercase();
        if requested.is_empty() || requested == "unknown" { return None; }
        let mut result: Option<String> = None;
        for (name, image) in contexts {
            let basename = Path::new(image).file_name().map(|value| value.to_string_lossy().to_lowercase());
            if name.to_lowercase() != requested && basename.as_deref() != Some(requested.as_str()) { continue; }
            if let Some(previous) = &result {
                if previous.to_lowercase() != image.to_lowercase() { return None; }
            } else {
                result = Some(image.to_owned());
            }
        }
        result
    }

    /// Resolve old name-only history against currently visible, titled windows.
    /// Return nothing on ambiguous names or incomplete enumeration.
    pub fn resolve_visible_application(requested: &str) -> Option<String> {
        struct Windows { handles: Vec<isize>, complete: bool }
        unsafe extern "system" fn collect(window: isize, parameter: isize) -> i32 {
            let state = &mut *(parameter as *mut Windows);
            if IsWindowVisible(window) != 0 && GetWindowTextLengthW(window) > 0 {
                if state.handles.len() >= 512 { state.complete = false; return 0; }
                state.handles.push(window);
            }
            1
        }
        if requested.is_empty() || requested.eq_ignore_ascii_case("unknown") { return None; }
        let mut windows = Windows { handles: Vec::new(), complete: true };
        let enumerated = unsafe { EnumWindows(collect, &mut windows as *mut Windows as isize) };
        if enumerated == 0 || !windows.complete { return None; }
        let started = std::time::Instant::now();
        let mut contexts = Vec::new();
        for window in windows.handles {
            if started.elapsed() > std::time::Duration::from_millis(1000) { return None; }
            let (name, _, path) = context_with_path_for_window(window);
            if let Some(path) = path { contexts.push((name, path)); }
        }
        unique_matching_executable(requested, contexts.iter().map(|(name, path)| (name.as_str(), path.as_str())))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn absent_foreground_window_is_safe() {
            assert_eq!(context_for_window(0), ("Unknown".to_owned(), String::new()));
            assert_eq!(context_with_path_for_window(0), ("Unknown".to_owned(), String::new(), None));
        }

        #[test]
        fn reads_localized_windows_file_description() {
            let system_root = std::env::var_os("SystemRoot").expect("Windows system root");
            let file = Path::new(&system_root).join("System32").join("kernel32.dll");
            let description = file_description(&file).expect("Windows library version description");
            assert!(!description.trim().is_empty());
            assert!(!description.contains('\0'));
        }

        #[test]
        fn history_name_resolution_requires_exact_unambiguous_executable() {
            let contexts = [("ChatGPT", "C:\\Apps\\ChatGPT.exe"), ("ChatGPT", "c:\\apps\\chatgpt.exe")];
            assert_eq!(unique_matching_executable("chatgpt", contexts), Some("C:\\Apps\\ChatGPT.exe".to_owned()));
            assert_eq!(unique_matching_executable("CHATGPT.EXE", contexts), Some("C:\\Apps\\ChatGPT.exe".to_owned()));
            assert_eq!(unique_matching_executable("chat", contexts), None);
            assert_eq!(unique_matching_executable("ChatGPT", [("ChatGPT", "C:\\Apps\\ChatGPT.exe"), ("ChatGPT", "D:\\Other\\ChatGPT.exe")]), None);
        }
    }
}

pub fn get_application_context() -> (String, String) {
    #[cfg(target_os = "macos")]
    {
        return macos::application_context();
    }

    #[cfg(windows)]
    {
        return windows::context_for_window(windows::foreground_window());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        ("Unknown".to_string(), String::new())
    }
}

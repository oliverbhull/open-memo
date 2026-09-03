use std::process::Command;

#[cfg(target_os = "macos")]
pub fn get_active_application() -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get name of first application process whose frontmost is true")
        .output()?;

    if output.status.success() {
        let app_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(app_name)
    } else {
        Err("Failed to get active application".into())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get_active_application() -> Result<String, Box<dyn std::error::Error>> {
    // TODO: Implement for other platforms
    Ok("Unknown".to_string())
}

#[cfg(target_os = "macos")]
pub fn get_active_window_title() -> Result<String, Box<dyn std::error::Error>> {
    // Try the more reliable method first - get window title from the frontmost app
    let script = r#"
        tell application "System Events"
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            try
                tell process appName
                    if (count of windows) > 0 then
                        set windowTitle to name of window 1
                        return windowTitle
                    end if
                end tell
            end try
            return ""
        end tell
    "#;

    let output = Command::new("osascript").arg("-e").arg(script).output()?;

    if output.status.success() {
        let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(title)
    } else {
        // Fallback to empty string if it fails
        Ok("".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get_active_window_title() -> Result<String, Box<dyn std::error::Error>> {
    // TODO: Implement for other platforms
    Ok("".to_string())
}

pub fn get_application_context() -> (String, String) {
    let app_name = get_active_application().unwrap_or_else(|_| "Unknown".to_string());
    let window_title = get_active_window_title().unwrap_or_else(|_| "".to_string());
    (app_name, window_title)
}

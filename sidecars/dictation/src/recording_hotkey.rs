use rdev::Key;
use std::collections::HashSet;

// Keep these physical key names aligned with electron/shared/recordingHotkey.ts.
const KEYS: &[(&str, Key)] = &[
    ("function", Key::Function),
    ("controlleft", Key::ControlLeft),
    ("controlright", Key::ControlRight),
    ("altleft", Key::Alt),
    ("altright", Key::AltGr),
    ("shiftleft", Key::ShiftLeft),
    ("shiftright", Key::ShiftRight),
    ("metaleft", Key::MetaLeft),
    ("metaright", Key::MetaRight),
    ("f1", Key::F1),
    ("f2", Key::F2),
    ("f3", Key::F3),
    ("f4", Key::F4),
    ("f5", Key::F5),
    ("f6", Key::F6),
    ("f7", Key::F7),
    ("f8", Key::F8),
    ("f9", Key::F9),
    ("f10", Key::F10),
    ("f11", Key::F11),
    ("f12", Key::F12),
    ("a", Key::KeyA),
    ("b", Key::KeyB),
    ("c", Key::KeyC),
    ("d", Key::KeyD),
    ("e", Key::KeyE),
    ("f", Key::KeyF),
    ("g", Key::KeyG),
    ("h", Key::KeyH),
    ("i", Key::KeyI),
    ("j", Key::KeyJ),
    ("k", Key::KeyK),
    ("l", Key::KeyL),
    ("m", Key::KeyM),
    ("n", Key::KeyN),
    ("o", Key::KeyO),
    ("p", Key::KeyP),
    ("q", Key::KeyQ),
    ("r", Key::KeyR),
    ("s", Key::KeyS),
    ("t", Key::KeyT),
    ("u", Key::KeyU),
    ("v", Key::KeyV),
    ("w", Key::KeyW),
    ("x", Key::KeyX),
    ("y", Key::KeyY),
    ("z", Key::KeyZ),
    ("0", Key::Num0),
    ("1", Key::Num1),
    ("2", Key::Num2),
    ("3", Key::Num3),
    ("4", Key::Num4),
    ("5", Key::Num5),
    ("6", Key::Num6),
    ("7", Key::Num7),
    ("8", Key::Num8),
    ("9", Key::Num9),
    ("space", Key::Space),
    ("return", Key::Return),
    ("tab", Key::Tab),
    ("backspace", Key::Backspace),
    ("delete", Key::Delete),
    ("capslock", Key::CapsLock),
    ("left", Key::LeftArrow),
    ("right", Key::RightArrow),
    ("up", Key::UpArrow),
    ("down", Key::DownArrow),
    ("home", Key::Home),
    ("end", Key::End),
    ("pageup", Key::PageUp),
    ("pagedown", Key::PageDown),
    ("backquote", Key::BackQuote),
    ("minus", Key::Minus),
    ("equal", Key::Equal),
    ("leftbracket", Key::LeftBracket),
    ("rightbracket", Key::RightBracket),
    ("backslash", Key::BackSlash),
    ("semicolon", Key::SemiColon),
    ("quote", Key::Quote),
    ("comma", Key::Comma),
    ("dot", Key::Dot),
    ("slash", Key::Slash),
];

fn is_modifier(key: Key) -> bool {
    matches!(key, Key::Function | Key::ControlLeft | Key::ControlRight | Key::Alt | Key::AltGr | Key::ShiftLeft | Key::ShiftRight | Key::MetaLeft | Key::MetaRight)
}

fn parse_key(raw: &str) -> Option<Key> {
    let raw = raw.trim().to_lowercase();
    let value = match raw.as_str() {
        "fn" => "function", "ctrl" => "controlleft", "cmd" | "command" => "metaleft",
        "shift" => "shiftleft", "alt" => "altleft", "enter" => "return", other => other,
    };
    KEYS.iter().find(|(name, _)| *name == value).map(|(_, key)| *key)
}

pub fn parse_shortcut(raw: &str) -> Option<Vec<Key>> {
    if raw.len() > 150 { return None; }
    let keys: Vec<Key> = raw.split('+').map(parse_key).collect::<Option<_>>()?;
    if keys.is_empty() || keys.len() > 5 || keys.iter().copied().collect::<HashSet<_>>().len() != keys.len()
        || keys.iter().filter(|key| !is_modifier(**key)).count() > 1 { return None; }
    Some(keys)
}

pub fn shortcut_names(keys: &[Key]) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for (name, key) in KEYS {
        if keys.contains(key) { names.push((*name).to_string()); }
    }
    if names.len() != keys.len() { return None; }
    Some(names)
}

#[derive(Debug, PartialEq)]
pub enum ShortcutAction {
    Start, Stop, ToggleLock,
    Capture { keys: Vec<String>, complete: bool },
    CancelCapture, UnsupportedCapture,
}

pub struct ShortcutListener {
    shortcut: Vec<Key>,
    lock_shortcut: Vec<Key>,
    pressed: HashSet<Key>,
    active: bool,
    lock_toggled: bool,
    pub capturing: bool,
    capture_complete: bool,
    captured: Vec<Key>,
}

impl ShortcutListener {
    pub fn new(shortcut: Vec<Key>) -> Self {
        Self { shortcut, lock_shortcut: vec![Key::Function, Key::ControlLeft], pressed: HashSet::new(), active: false, lock_toggled: false,
            capturing: false, capture_complete: false, captured: Vec::new() }
    }

    pub fn set_shortcuts(&mut self, shortcut: Vec<Key>, lock_shortcut: Vec<Key>) {
        self.shortcut = shortcut;
        self.lock_shortcut = lock_shortcut;
        self.reset();
    }

    pub fn set_capture(&mut self, enabled: bool) {
        self.capturing = enabled;
        self.reset();
    }

    fn reset(&mut self) {
        self.pressed.clear(); self.active = false; self.lock_toggled = false;
        self.captured.clear(); self.capture_complete = false;
    }

    pub fn event(&mut self, key: Key, down: bool, locked: bool) -> Option<ShortcutAction> {
        if self.capturing && key == Key::Escape && down {
            self.set_capture(false);
            return Some(ShortcutAction::CancelCapture);
        }
        if down {
            if !self.pressed.insert(key) { return None; } // Ignore key repeats.
        } else { self.pressed.remove(&key); }

        if self.capturing {
            if self.capture_complete { return None; }
            if !down && self.captured.is_empty() { return None; }
            if down && !self.captured.contains(&key) { self.captured.push(key); }
            let complete = !down && self.pressed.is_empty();
            // Only include simultaneously held keys, rather than sequential typing.
            if down { self.captured = self.pressed.iter().copied().collect(); }
            let names = shortcut_names(&self.captured);
            if complete {
                if let Some(keys) = names {
                    if parse_shortcut(&keys.join("+")).is_some() {
                        self.capture_complete = true;
                        return Some(ShortcutAction::Capture { keys, complete: true });
                    }
                }
                self.captured.clear();
                return Some(ShortcutAction::UnsupportedCapture);
            }
            return names.map(|keys| ShortcutAction::Capture { keys, complete: false });
        }

        let matches = |shortcut: &[Key]| shortcut.iter().all(|key| self.pressed.contains(key)) &&
            self.pressed.iter().all(|key| !is_modifier(*key) || shortcut.contains(key));
        let lock_active = matches(&self.lock_shortcut) ||
            (self.lock_shortcut.len() == 2 && self.lock_shortcut.contains(&Key::Function) && self.lock_shortcut.contains(&Key::ControlLeft) && matches(&[Key::Function, Key::ControlRight]));
        let active = matches(&self.shortcut);
        let was_active = self.active;
        self.active = active;
        if lock_active && !self.lock_toggled {
            self.lock_toggled = true;
            return Some(ShortcutAction::ToggleLock);
        }
        let had_lock_toggle = self.lock_toggled;
        if !lock_active && self.pressed.is_empty() { self.lock_toggled = false; }
        if active && !was_active && !had_lock_toggle { return Some(ShortcutAction::Start); }
        if !active && was_active && !locked && !had_lock_toggle { return Some(ShortcutAction::Stop); }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listener(raw: &str) -> ShortcutListener { ShortcutListener::new(parse_shortcut(raw).unwrap()) }
    #[test]
    fn validates_shortcuts() {
        assert!(parse_shortcut("metaleft+shiftleft+space").is_some());
        assert!(parse_shortcut("fn").is_some());
        for invalid in ["", "unknown", "a+b", "fn+fn", "controlleft+"] { assert!(parse_shortcut(invalid).is_none()); }
    }
    #[test]
    fn captures_fn_and_combinations_without_recording() {
        let mut l = listener("function"); l.set_capture(true);
        assert_eq!(l.event(Key::Function, true, false), Some(ShortcutAction::Capture { keys: vec!["function".into()], complete: false }));
        assert_eq!(l.event(Key::Function, false, false), Some(ShortcutAction::Capture { keys: vec!["function".into()], complete: true }));
        l.set_capture(true);
        l.event(Key::MetaLeft, true, false); l.event(Key::ShiftLeft, true, false); l.event(Key::Space, true, false);
        l.event(Key::MetaLeft, false, false); l.event(Key::Space, false, false);
        assert_eq!(l.event(Key::ShiftLeft, false, false), Some(ShortcutAction::Capture { keys: vec!["shiftleft".into(), "metaleft".into(), "space".into()], complete: true }));
    }
    #[test]
    fn chord_starts_once_and_stops_when_any_required_key_is_released() {
        let mut l = listener("metaleft+shiftleft+space");
        assert_eq!(l.event(Key::Space, true, false), None);
        assert_eq!(l.event(Key::MetaLeft, true, false), None);
        assert_eq!(l.event(Key::ShiftLeft, true, false), Some(ShortcutAction::Start));
        assert_eq!(l.event(Key::Space, true, false), None);
        assert_eq!(l.event(Key::MetaLeft, false, false), Some(ShortcutAction::Stop));
        assert_eq!(l.event(Key::Space, false, false), None);
    }
    #[test]
    fn lock_works_in_either_order_and_does_not_stop_on_release() {
        for control_first in [false, true] {
            let mut l = listener("function");
            let (first, second) = if control_first { (Key::ControlLeft, Key::Function) } else { (Key::Function, Key::ControlLeft) };
            l.event(first, true, false);
            assert_eq!(l.event(second, true, false), Some(ShortcutAction::ToggleLock));
            assert_eq!(l.event(Key::Function, false, true), None);
        }
        let mut l = listener("controlleft+space");
        l.set_shortcuts(parse_shortcut("controlleft+space").unwrap(), parse_shortcut("controlleft+controlright+space").unwrap());
        l.event(Key::ControlLeft, true, false);
        assert_eq!(l.event(Key::Space, true, false), Some(ShortcutAction::Start));
        assert_eq!(l.event(Key::ControlRight, true, false), Some(ShortcutAction::ToggleLock));
        let mut l = listener("function");
        l.event(Key::ControlRight, true, false);
        assert_eq!(l.event(Key::Function, true, false), Some(ShortcutAction::ToggleLock));
    }
    #[test]
    fn escape_cancels_and_unsupported_keys_cannot_replace_the_shortcut() {
        let mut l = listener("function"); l.set_capture(true);
        assert_eq!(l.event(Key::Unknown(999), true, false), None);
        assert_eq!(l.event(Key::Unknown(999), false, false), Some(ShortcutAction::UnsupportedCapture));
        assert_eq!(l.event(Key::Escape, true, false), Some(ShortcutAction::CancelCapture));
        assert_eq!(l.event(Key::Function, true, false), Some(ShortcutAction::Start));
    }
    #[test]
    fn recording_lock_can_use_an_independent_binding() {
        let mut l = listener("metaleft+space");
        l.set_shortcuts(parse_shortcut("metaleft+space").unwrap(), parse_shortcut("f8").unwrap());
        assert_eq!(l.event(Key::F8, true, false), Some(ShortcutAction::ToggleLock));
        assert_eq!(l.event(Key::F8, false, true), None);
        assert_eq!(l.event(Key::F8, true, true), Some(ShortcutAction::ToggleLock));
        l.event(Key::F8, false, false);
        l.event(Key::MetaLeft, true, false);
        assert_eq!(l.event(Key::Space, true, false), Some(ShortcutAction::Start));
        assert_eq!(l.event(Key::Space, false, false), Some(ShortcutAction::Stop));
    }
}

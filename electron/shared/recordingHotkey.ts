export const DEFAULT_RECORDING_HOTKEY = 'function';

// Physical key names shared with the native shortcut listener.
export const RECORDING_KEYS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "function", label: "Fn" },
  { value: "controlleft", label: "Left Control" },
  { value: "controlright", label: "Right Control" },
  { value: "altleft", label: "Left Option" },
  { value: "altright", label: "Right Option" },
  { value: "shiftleft", label: "Left Shift" },
  { value: "shiftright", label: "Right Shift" },
  { value: "metaleft", label: "Left Command" },
  { value: "metaright", label: "Right Command" },
  { value: "f1", label: "F1" },
  { value: "f2", label: "F2" },
  { value: "f3", label: "F3" },
  { value: "f4", label: "F4" },
  { value: "f5", label: "F5" },
  { value: "f6", label: "F6" },
  { value: "f7", label: "F7" },
  { value: "f8", label: "F8" },
  { value: "f9", label: "F9" },
  { value: "f10", label: "F10" },
  { value: "f11", label: "F11" },
  { value: "f12", label: "F12" },
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
  { value: "d", label: "D" },
  { value: "e", label: "E" },
  { value: "f", label: "F" },
  { value: "g", label: "G" },
  { value: "h", label: "H" },
  { value: "i", label: "I" },
  { value: "j", label: "J" },
  { value: "k", label: "K" },
  { value: "l", label: "L" },
  { value: "m", label: "M" },
  { value: "n", label: "N" },
  { value: "o", label: "O" },
  { value: "p", label: "P" },
  { value: "q", label: "Q" },
  { value: "r", label: "R" },
  { value: "s", label: "S" },
  { value: "t", label: "T" },
  { value: "u", label: "U" },
  { value: "v", label: "V" },
  { value: "w", label: "W" },
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
  { value: "0", label: "0" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5" },
  { value: "6", label: "6" },
  { value: "7", label: "7" },
  { value: "8", label: "8" },
  { value: "9", label: "9" },
  { value: "space", label: "Space" },
  { value: "return", label: "Return" },
  { value: "tab", label: "Tab" },
  { value: "backspace", label: "Delete" },
  { value: "delete", label: "Forward Delete" },
  { value: "capslock", label: "Caps Lock" },
  { value: "left", label: "\u2190" },
  { value: "right", label: "\u2192" },
  { value: "up", label: "\u2191" },
  { value: "down", label: "\u2193" },
  { value: "home", label: "Home" },
  { value: "end", label: "End" },
  { value: "pageup", label: "Page Up" },
  { value: "pagedown", label: "Page Down" },
  { value: "backquote", label: "`" },
  { value: "minus", label: "\u2212" },
  { value: "equal", label: "=" },
  { value: "leftbracket", label: "[" },
  { value: "rightbracket", label: "]" },
  { value: "backslash", label: "\\" },
  { value: "semicolon", label: ";" },
  { value: "quote", label: "'" },
  { value: "comma", label: "," },
  { value: "dot", label: "." },
  { value: "slash", label: "/" },
];

export const RECORDING_MODIFIERS = ['function', 'controlleft', 'controlright', 'altleft', 'altright', 'shiftleft', 'shiftright', 'metaleft', 'metaright'];

export function normalizeRecordingHotkey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 150) return null;
  const aliases: Record<string, string> = {
    fn: 'function', ctrl: 'controlleft', cmd: 'metaleft', command: 'metaleft',
    shift: 'shiftleft', alt: 'altleft', enter: 'return',
  };
  const keys = raw.trim().toLowerCase().split('+').map(key => {
    const value = key.trim();
    return Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value]! : value;
  });
  if (!keys.length || keys.length > 5 || new Set(keys).size !== keys.length ||
      keys.some(key => !RECORDING_KEYS.some(option => option.value === key)) ||
      keys.filter(key => !RECORDING_MODIFIERS.includes(key)).length > 1) return null;
  return keys.sort((a, b) => RECORDING_KEYS.findIndex(key => key.value === a) - RECORDING_KEYS.findIndex(key => key.value === b)).join('+');
}

export function recordingHotkeyParts(raw: unknown): string[] {
  const value = normalizeRecordingHotkey(raw) ?? DEFAULT_RECORDING_HOTKEY;
  return value.split('+').map(key => RECORDING_KEYS.find(option => option.value === key)!.label);
}

export function recordingHotkeyLabel(raw: unknown): string {
  return recordingHotkeyParts(raw).join(' + ');
}

export function recordingLockModifier(raw: unknown): string {
  const keys = (normalizeRecordingHotkey(raw) ?? DEFAULT_RECORDING_HOTKEY).split('+');
  return keys.includes('controlleft') && keys.includes('controlright') ? 'Left Option'
    : keys.includes('controlleft') ? 'Right Control'
    : keys.includes('controlright') ? 'Left Control' : 'Control';
}

export interface RecordingHotkeyCapture {
  keys: string[];
  complete: boolean;
  cancelled?: boolean;
  error?: string;
}

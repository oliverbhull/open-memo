export interface AudioInputDevice {
  name: string;
  isDefault: boolean;
}

interface SystemProfilerItem {
  _name?: unknown;
  coreaudio_default_audio_input_device?: unknown;
  coreaudio_device_input?: unknown;
}

function collectProfilerItems(value: unknown, items: SystemProfilerItem[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectProfilerItems(entry, items));
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if ('coreaudio_device_input' in record && '_name' in record) {
    items.push(record as SystemProfilerItem);
  }
  Object.values(record).forEach((entry) => collectProfilerItems(entry, items));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, 200);
  return normalized || null;
}

export function parseAudioInputDevices(stdout: string): AudioInputDevice[] {
  const parsed: unknown = JSON.parse(stdout);
  const items: SystemProfilerItem[] = [];
  collectProfilerItems(parsed, items);

  const byName = new Map<string, AudioInputDevice>();
  for (const item of items) {
    const name = optionalString(item._name);
    if (!name) continue;
    const inputChannels = Number(item.coreaudio_device_input);
    if (!Number.isFinite(inputChannels) || inputChannels <= 0) continue;

    const device: AudioInputDevice = {
      name,
      isDefault: item.coreaudio_default_audio_input_device === 'spaudio_yes',
    };
    const existing = byName.get(name);
    if (!existing || device.isDefault) byName.set(name, device);
  }

  return [...byName.values()].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

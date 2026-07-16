import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAudioInputDevices } from '../electron/main/services/audioInputParser';

const fixture = JSON.stringify({
  SPAudioDataType: [{
    _items: [
      {
        _name: 'Display',
        coreaudio_device_output: 2,
        coreaudio_device_srate: 48_000,
      },
      {
        _name: 'AirPods Pro',
        coreaudio_default_audio_input_device: 'spaudio_yes',
        coreaudio_device_input: 1,
        coreaudio_device_srate: 24_000,
        coreaudio_device_transport: 'coreaudio_device_type_bluetooth',
      },
      {
        _name: 'MacBook Pro Microphone',
        coreaudio_device_input: 1,
        coreaudio_device_srate: 96_000,
        coreaudio_device_transport: 'coreaudio_device_type_builtin',
      },
      {
        _name: 'Microsoft Teams Audio Capture',
        coreaudio_device_input: 2,
      },
    ],
  }],
});

test('parses available macOS inputs with the system default first', () => {
  const devices = parseAudioInputDevices(fixture);
  assert.deepEqual(devices.map(({ name, isDefault }) => ({ name, isDefault })), [
    { name: 'AirPods Pro', isDefault: true },
    { name: 'MacBook Pro Microphone', isDefault: false },
  ]);
});

test('rejects malformed system profiler output', () => {
  assert.throws(() => parseAudioInputDevices('not json'), SyntaxError);
});

test('omits Microsoft Teams virtual inputs', () => {
  const devices = parseAudioInputDevices(fixture);
  assert.equal(devices.some(({ name }) => /teams/i.test(name)), false);
});

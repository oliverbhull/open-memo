const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const BAR_COUNT = (fs.readFileSync('electron/renderer/overlay.html', 'utf8').match(/class="bar"/g) || []).length;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 25;

function overlay() {
  const html = fs.readFileSync('electron/renderer/overlay.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const classes = new Set(['idle']);
  const properties = new Map();
  const waveform = { classList: {
    add: value => classes.add(value),
    toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
  } };
  const bars = Array.from({ length: BAR_COUNT }, () => ({ style: { height: `${MIN_BAR_HEIGHT}px` } }));
  let now = 0;
  let nextId = 0;
  const frames = new Map();
  let audio;
  let status;
  vm.runInNewContext(script, {
    document: { getElementById: () => waveform, querySelectorAll: () => bars,
      documentElement: { style: { setProperty: (name, value) => properties.set(name, value) } } },
    window: { memoOverlay: { onAudioLevels: callback => { audio = callback; },
      onStatus: callback => { status = callback; } } },
    Date: { now: () => now }, performance: { now: () => now },
    requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  return { audio, status, classes, properties,
    heights: () => bars.map(bar => parseFloat(bar.style.height)),
    frameCount: () => frames.size,
    advance: (duration, levels) => {
      for (let elapsed = 0; elapsed < duration; elapsed += 16) {
        now += 16;
        if (levels !== undefined) audio(levels);
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(now));
      }
    },
  };
}

test('recording status applies the chosen accent and reveals native glass when available', () => {
  const view = overlay();
  view.status({ isRecording: true, primaryColor: '#73d2df', nativeGlass: true });
  assert.equal(view.properties.get('--primary-color'), '#73d2df');
  assert(view.classes.has('native-glass'));

  const fallback = overlay();
  fallback.status({ isRecording: true, primaryColor: '#c093e2', nativeGlass: false });
  assert.equal(fallback.properties.get('--primary-color'), '#c093e2');
  assert(!fallback.classes.has('native-glass'));
});

test('listening stays still under small microphone fluctuations', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.advance(1000, [0.02, 0.03, 0.04, 0.06, 0.04, 0.03, 0.02]);
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  assert(view.classes.has('idle'));
});

test('speech rises smoothly, emphasis has range, and pauses settle', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.audio(Array(7).fill(0.45));
  assert.equal(view.heights()[0], MIN_BAR_HEIGHT); // Updates wait for a display frame.
  view.advance(16, Array(7).fill(0.45));
  const first = view.heights()[0];
  view.advance(160, Array(7).fill(0.45));
  const normal = Math.max(...view.heights());
  assert(first > MIN_BAR_HEIGHT && first < normal);
  view.advance(160, Array(7).fill(0.9));
  assert(Math.max(...view.heights()) > normal + 3);
  assert(view.heights().every(height => height <= MAX_BAR_HEIGHT));
  view.advance(640, Array(7).fill(0));
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  assert(view.classes.has('idle'));
});

test('missing audio updates settle and late callbacks cannot animate after stop', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.advance(320, Array(7).fill(0.8));
  assert(Math.max(...view.heights()) > 10);
  view.advance(1000);
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  view.status({ isRecording: false });
  view.audio(Array(7).fill(1));
  view.advance(160);
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  assert.equal(view.frameCount(), 0);
});

test('invalid levels and repeated recording status cannot corrupt bars or create extra loops', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.status({ isRecording: true });
  assert.equal(view.frameCount(), 1);
  view.advance(160, [NaN, Infinity, -1, 5, 'loud', null]);
  assert(view.heights().every(height => Number.isFinite(height) && height >= MIN_BAR_HEIGHT && height <= MAX_BAR_HEIGHT));
  view.advance(800, null);
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  view.status({ isRecording: false });
  view.status({ isRecording: true });
  assert.equal(view.frameCount(), 1);
  assert(view.classes.has('idle'));
});

test('a syllable travels from the left bar to the right bar and drains during silence', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.advance(48, Array(7).fill(0.8));
  assert(view.heights()[0] > MIN_BAR_HEIGHT);
  assert.equal(view.heights()[BAR_COUNT - 1], MIN_BAR_HEIGHT);
  view.advance(96, Array(7).fill(0));
  assert(view.heights()[Math.floor(BAR_COUNT / 2)] > MIN_BAR_HEIGHT);
  assert.equal(view.heights()[BAR_COUNT - 1], MIN_BAR_HEIGHT);
  view.advance(176, Array(7).fill(0));
  assert(view.heights()[BAR_COUNT - 1] > MIN_BAR_HEIGHT);
  view.advance(640, Array(7).fill(0));
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
  assert(view.classes.has('idle'));
});

test('stopping clears the traveling trail before the next recording', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.advance(48, Array(7).fill(0.8));
  view.status({ isRecording: false });
  view.status({ isRecording: true });
  view.advance(320, Array(7).fill(0));
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
});


test('sustained speech keeps a varied profile across compact bars', () => {
  const view = overlay();
  view.status({ isRecording: true });
  view.advance(480, Array(7).fill(0.75));
  const first = view.heights();
  assert(Math.max(...first) - Math.min(...first) > 5);
  assert(first.slice(1).some((height, index) => Math.abs(height - first[index]) > 2.5));
  view.advance(96, Array(7).fill(0.75));
  assert(view.heights().some((height, index) => Math.abs(height - first[index]) > 1.25));
  view.advance(800, Array(7).fill(0));
  assert.deepEqual(view.heights(), Array(BAR_COUNT).fill(MIN_BAR_HEIGHT));
});

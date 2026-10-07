const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const compiled = buildSync({ entryPoints: ['electron/renderer/src/utils/colorUtils.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports });
const { hexToHsl, hslToHex, accentColorAtHue, brightenAccentColor } = loaded.exports;

test('the full hue circle ends at red instead of falling through to gray', () => {
  for (const [saturation, lightness] of [[100, 50], [48, 54], [25, 30]]) {
    assert.equal(hslToHex(360, saturation, lightness), hslToHex(0, saturation, lightness));
  }
  assert.equal(hslToHex(360, 100, 50), '#ff0000');
  assert.equal(hslToHex(720, 100, 50), '#ff0000');
  assert.equal(hslToHex(-120, 100, 50), '#0000ff');
});

test('moving the hue picker recovers an already-saved gray, black, or white accent', () => {
  for (const color of ['#515151', '#808080', '#000000', '#ffffff']) {
    const recovered = accentColorAtHue(220, color);
    const [hue, saturation, lightness] = hexToHsl(recovered);
    assert.ok(Math.abs(hue - 220) <= 1, `${color}: ${recovered}`);
    assert.ok(saturation > 0, `${color} should regain saturation`);
    assert.ok(lightness > 0 && lightness < 100);
  }
});

test('sweeping across both slider endpoints remains colorful after each saved update', () => {
  let color = '#C26D50';
  for (const hue of [0, 60, 120, 180, 240, 300, 360, 220, 0]) {
    color = accentColorAtHue(hue, color);
    assert.ok(hexToHsl(color)[1] > 0, `Hue ${hue} turned ${color}`);
  }
});

test('the hue picker brightens muted accents while retaining their selected hue', () => {
  const before = hexToHsl('#C26D50');
  const after = hexToHsl(accentColorAtHue(220, '#C26D50'));
  assert.equal(after[0], 220);
  assert.ok(after[1] > before[1]);
  assert.ok(after[2] > before[2]);
});

test('saved accents keep their hue and do not brighten further on each reload', () => {
  for (const color of ['#C26D50', '#515151', '#000000', '#ffffff', '#5277c2', '#ff6600', '#b8a0ed']) {
    const brightened = brightenAccentColor(color);
    assert.equal(brightenAccentColor(brightened), brightened);
    if (hexToHsl(color)[1] > 0) {
      assert.ok(Math.abs(hexToHsl(brightened)[0] - hexToHsl(color)[0]) <= 1);
    }
  }
});

test('all accent hues have readable contrast as text on the dark app surface', () => {
  const luminance = hex => {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const background = luminance('#080808');
  for (let hue = 0; hue <= 360; hue += 5) {
    const color = accentColorAtHue(hue, '#C26D50');
    const contrast = (luminance(color) + 0.05) / (background + 0.05);
    assert.ok(contrast >= 4.5, `${hue}° (${color}) has contrast ${contrast}`);
  }
});

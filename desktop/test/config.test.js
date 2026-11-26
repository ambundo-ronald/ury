const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, posStartUrl, normaliseSiteUrl } = require('../src/config');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ury-config-'));
  return { config: create({ dir, safeStorage: null }), dir };
}

test('the POS opens on the station screen, full screen, by default', () => {
  const { config, dir } = tempConfig();
  const settings = config.get();
  assert.strictEqual(settings.startPage, 'station');
  assert.strictEqual(settings.fullScreen, true);
  fs.rmSync(dir, { recursive: true });
});

test('screen settings are saved and kept with the pairing', () => {
  const { config, dir } = tempConfig();
  config.setPairing({ siteUrl: 'https://pos.example.com', agentName: 'PC', branch: 'B', token: 't' });
  config.setScreen({ startPage: 'login', fullScreen: false });
  let settings = config.get();
  assert.deepStrictEqual([settings.startPage, settings.fullScreen, settings.token], ['login', false, 't']);

  config.setScreen({ fullScreen: true });
  settings = config.get();
  assert.deepStrictEqual([settings.startPage, settings.fullScreen], ['login', true]);

  config.setScreen({ startPage: 'anything else' });
  assert.strictEqual(config.get().startPage, 'station');
  fs.rmSync(dir, { recursive: true });
});

test('the keyboard button is on by default and remembers where it was left', () => {
  const { config, dir } = tempConfig();
  assert.strictEqual(config.get().keyboardButton, true);
  assert.strictEqual(config.get().keyboardButtonPosition, null);

  config.setScreen({ keyboardButton: false, keyboardButtonPosition: { x: 40.4, y: 600.6 } });
  assert.strictEqual(config.get().keyboardButton, false);
  assert.deepStrictEqual(config.get().keyboardButtonPosition, { x: 40, y: 601 });

  config.setScreen({ keyboardButtonPosition: { x: 'left', y: 5 } });
  assert.strictEqual(config.get().keyboardButtonPosition, null);
  fs.rmSync(dir, { recursive: true });
});

test('the update button is on by default, can be switched off and keeps its own place', () => {
  const { config, dir } = tempConfig();
  assert.strictEqual(config.get().updateButton, true);
  assert.strictEqual(config.get().updateButtonPosition, null);

  config.setScreen({ updateButton: false, updateButtonPosition: { x: 12.2, y: 500 } });
  assert.strictEqual(config.get().updateButton, false);
  assert.deepStrictEqual(config.get().updateButtonPosition, { x: 12, y: 500 });
  // Moving one button leaves the other where it was.
  assert.strictEqual(config.get().keyboardButtonPosition, null);
  assert.strictEqual(config.get().keyboardButton, true);
  fs.rmSync(dir, { recursive: true });
});

test('text size defaults to ERPNext size and only takes the listed sizes', () => {
  const { config, dir } = tempConfig();
  assert.strictEqual(config.get().textSize, 0.875);
  config.setScreen({ textSize: 0.8 });
  assert.strictEqual(config.get().textSize, 0.8);
  config.setScreen({ textSize: '1' });
  assert.strictEqual(config.get().textSize, 1);
  config.setScreen({ textSize: 3 });
  assert.strictEqual(config.get().textSize, 0.875);
  fs.rmSync(dir, { recursive: true });
});

test('start URL is the station page or the POS on the site', () => {
  assert.strictEqual(posStartUrl('https://pos.example.com', 'station'), 'https://pos.example.com/station');
  assert.strictEqual(posStartUrl('https://pos.example.com/', 'login'), 'https://pos.example.com/pos');
});

test('site address needs https except on this computer', () => {
  assert.strictEqual(normaliseSiteUrl('pos.example.com/pos'), 'https://pos.example.com');
  assert.throws(() => normaliseSiteUrl('http://pos.example.com'), /https/);
  assert.strictEqual(normaliseSiteUrl('http://localhost:8000'), 'http://localhost:8000');
});

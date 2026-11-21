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

test('start URL is the station page or the POS on the site', () => {
  assert.strictEqual(posStartUrl('https://pos.example.com', 'station'), 'https://pos.example.com/station');
  assert.strictEqual(posStartUrl('https://pos.example.com/', 'login'), 'https://pos.example.com/pos');
});

test('site address needs https except on this computer', () => {
  assert.strictEqual(normaliseSiteUrl('pos.example.com/pos'), 'https://pos.example.com');
  assert.throws(() => normaliseSiteUrl('http://pos.example.com'), /https/);
  assert.strictEqual(normaliseSiteUrl('http://localhost:8000'), 'http://localhost:8000');
});

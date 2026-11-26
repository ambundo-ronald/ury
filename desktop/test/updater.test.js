const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const { Updater, inQuietHours, shouldInstallNow } = require('../src/updater');

const at = (hour, minute = 0) => new Date(2026, 10, 21, hour, minute);

function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installs = [];
  u.checkForUpdates = async () => {
    u.checks += 1;
  };
  u.quitAndInstall = (...args) => u.installs.push(args);
  return u;
}

function makeUpdater(options = {}) {
  const autoUpdater = fakeAutoUpdater();
  const timers = [];
  const updater = new Updater({
    autoUpdater,
    enabled: true,
    log: { info() {}, warn() {}, error() {} },
    setIntervalImpl: (fn, ms) => timers.push({ fn, ms }),
    setTimeoutImpl: (fn, ms) => timers.push({ fn, ms, once: true }),
    ...options,
  });
  return { updater, autoUpdater, timers };
}

test('quiet hours are 3 to 5 a.m. local time', () => {
  assert.strictEqual(inQuietHours(at(2, 59)), false);
  assert.strictEqual(inQuietHours(at(3, 0)), true);
  assert.strictEqual(inQuietHours(at(4, 59)), true);
  assert.strictEqual(inQuietHours(at(5, 0)), false);
  assert.strictEqual(inQuietHours(at(13)), false);
});

test('never installs during service or mid-print', () => {
  assert.strictEqual(shouldInstallNow({ downloaded: true, now: at(20) }), false);
  assert.strictEqual(shouldInstallNow({ downloaded: true, now: at(3, 30), printing: true }), false);
  assert.strictEqual(shouldInstallNow({ downloaded: false, now: at(3, 30) }), false);
  assert.strictEqual(shouldInstallNow({ downloaded: true, now: at(3, 30) }), true);
});

test('downloads in the background and installs silently in quiet hours', () => {
  const { updater, autoUpdater } = makeUpdater();
  updater.start();
  assert.strictEqual(autoUpdater.autoDownload, true);
  assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true);

  autoUpdater.emit('update-available', { version: '1.1.0' });
  assert.strictEqual(updater.status.state, 'downloading');
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  assert.strictEqual(updater.status.state, 'ready');

  assert.strictEqual(updater.installIfQuiet(at(19)), false);
  assert.deepStrictEqual(autoUpdater.installs, []);
  assert.strictEqual(updater.installIfQuiet(at(3, 10)), true);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
});

test('waits while a ticket is printing', () => {
  let printing = true;
  const { updater, autoUpdater } = makeUpdater({ isPrinting: () => printing });
  updater.start();
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  assert.strictEqual(updater.installIfQuiet(at(3, 10)), false);
  printing = false;
  assert.strictEqual(updater.installIfQuiet(at(3, 15)), true);
});

test('schedules checks and does not re-check once downloading', async () => {
  const { updater, autoUpdater, timers } = makeUpdater();
  updater.start();
  assert.deepStrictEqual(timers.map((t) => t.ms), [60000, 4 * 3600000, 300000]);
  await updater.check();
  assert.strictEqual(autoUpdater.checks, 1);
  autoUpdater.emit('update-available', { version: '1.1.0' });
  await updater.check();
  assert.strictEqual(autoUpdater.checks, 1);
});

test('an offline check is shown and retried later', async () => {
  const { updater, autoUpdater } = makeUpdater();
  autoUpdater.checkForUpdates = async () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED\nstack');
  };
  updater.start();
  await updater.check();
  assert.strictEqual(updater.status.state, 'error');
  assert.strictEqual(updater.status.message, 'net::ERR_INTERNET_DISCONNECTED');
});

test('disabled builds never check', async () => {
  const { updater, autoUpdater, timers } = makeUpdater({ enabled: false });
  updater.start();
  await updater.check();
  assert.strictEqual(autoUpdater.checks, 0);
  assert.strictEqual(timers.length, 0);
  assert.strictEqual(updater.status.state, 'disabled');
});

function results(updater) {
  const seen = [];
  updater.on('manual-result', (r) => seen.push(r.outcome));
  return seen;
}

test('update now: checks, downloads and installs straight away, outside quiet hours', async () => {
  const { updater, autoUpdater } = makeUpdater();
  const seen = results(updater);
  updater.start();
  await updater.updateNow();
  assert.strictEqual(autoUpdater.checks, 1);
  assert.strictEqual(updater.installWhenReady, true);
  autoUpdater.emit('update-available', { version: '1.3.0' });
  assert.deepStrictEqual(autoUpdater.installs, []);
  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
  assert.strictEqual(updater.status.state, 'installing');
  assert.deepStrictEqual(seen, ['installing']);
});

test('update now: an update already downloaded installs at once', async () => {
  const { updater, autoUpdater } = makeUpdater();
  updater.start();
  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  assert.deepStrictEqual(autoUpdater.installs, []);
  await updater.updateNow();
  assert.strictEqual(autoUpdater.checks, 0);
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
});

test('update now: waits for the ticket being printed', async () => {
  let printing = true;
  const { updater, autoUpdater, timers } = makeUpdater({ isPrinting: () => printing });
  updater.start();
  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  timers.length = 0;
  await updater.updateNow();
  assert.deepStrictEqual(autoUpdater.installs, []);
  assert.strictEqual(timers.length, 1);
  printing = false;
  timers[0].fn();
  assert.deepStrictEqual(autoUpdater.installs, [[true, true]]);
});

test('update now: says when already up to date, or when it fails', async () => {
  const { updater, autoUpdater } = makeUpdater();
  const seen = results(updater);
  updater.start();
  await updater.updateNow();
  autoUpdater.emit('update-not-available', {});
  assert.strictEqual(updater.installWhenReady, false);

  autoUpdater.checkForUpdates = async () => {
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    throw new Error('net::ERR_INTERNET_DISCONNECTED');
  };
  await updater.updateNow();
  assert.deepStrictEqual(seen, ['up_to_date', 'error']);
  assert.strictEqual(updater.installWhenReady, false);

  // A later background download does not install by itself during service.
  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  assert.deepStrictEqual(autoUpdater.installs, []);
});

test('update now: a background check finding nothing is not reported', async () => {
  const { updater, autoUpdater } = makeUpdater();
  const seen = results(updater);
  updater.start();
  await updater.check();
  autoUpdater.emit('update-not-available', {});
  assert.deepStrictEqual(seen, []);
});

test('update now in a build without updates says so', async () => {
  const { updater, autoUpdater } = makeUpdater({ enabled: false });
  const seen = results(updater);
  await updater.updateNow();
  assert.strictEqual(autoUpdater.checks, 0);
  assert.deepStrictEqual(seen, ['disabled']);
});

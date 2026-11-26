// Automatic updates from the `desktop-latest` GitHub release (see
// .github/workflows/desktop-release.yml). New versions download in the
// background. Installing restarts the app, so during service it never
// happens by itself: it waits for the quiet hours, a quit, or a click on
// "Restart to update". "Update now" (the sync button over the POS, the tray
// or the Printing window) checks, downloads and installs in one go.

const EventEmitter = require('events');

const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const QUIET_CHECK_EVERY_MS = 5 * 60 * 1000;
// Local time when the restaurant is closed. Printing pauses for ~10 seconds.
const QUIET_FROM_HOUR = 3;
const QUIET_TO_HOUR = 5;
// "Update now" waits for the ticket being printed before restarting.
const PRINT_WAIT_MS = 2000;

function inQuietHours(date = new Date()) {
  const hour = date.getHours();
  return hour >= QUIET_FROM_HOUR && hour < QUIET_TO_HOUR;
}

/**
 * Decides when a downloaded update may be installed.
 * @returns {boolean}
 */
function shouldInstallNow({ downloaded, now = new Date(), printing = false }) {
  return Boolean(downloaded) && !printing && inQuietHours(now);
}

class Updater extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.autoUpdater electron-updater's autoUpdater
   * @param {boolean} options.enabled false for development builds
   * @param {() => boolean} [options.isPrinting]
   * @param {(fn: Function, ms: number) => any} [options.setInterval]
   */
  constructor({ autoUpdater, enabled, isPrinting = () => false, log = console, setIntervalImpl = setInterval, setTimeoutImpl = setTimeout }) {
    super();
    this.autoUpdater = autoUpdater;
    this.enabled = enabled;
    this.isPrinting = isPrinting;
    this.log = log;
    this.setIntervalImpl = setIntervalImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.status = { state: enabled ? 'idle' : 'disabled', version: null, message: '', progress: null };
    // Set by updateNow(): install as soon as the update is downloaded.
    this.installWhenReady = false;
  }

  _set(update) {
    this.status = { ...this.status, ...update };
    this.emit('status', this.status);
  }

  start() {
    if (!this.enabled) return;
    const u = this.autoUpdater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.logger = this.log;

    u.on('checking-for-update', () => this._set({ state: 'checking', message: '' }));
    u.on('update-not-available', () => {
      this._set({ state: 'up_to_date', message: '' });
      this._finishManual('up_to_date');
    });
    u.on('update-available', (info) => this._set({ state: 'downloading', version: info && info.version, progress: 0 }));
    u.on('download-progress', (p) => this._set({ progress: Math.round((p && p.percent) || 0) }));
    u.on('update-downloaded', (info) => {
      this._set({ state: 'ready', version: info && info.version, progress: 100 });
      if (this.installWhenReady) this._installWhenNotPrinting();
    });
    u.on('error', (error) => this._fail(error));

    this.setTimeoutImpl(() => this.check(), FIRST_CHECK_MS);
    this.setIntervalImpl(() => this.check(), CHECK_EVERY_MS);
    this.setIntervalImpl(() => this.installIfQuiet(), QUIET_CHECK_EVERY_MS);
  }

  async check() {
    if (!this.enabled || ['downloading', 'ready', 'installing'].includes(this.status.state)) return;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      // Offline: try again at the next check.
      this._fail(error);
    }
  }

  _fail(error) {
    this._set({ state: 'error', message: String((error && error.message) || error).split('\n')[0] });
    this._finishManual('error');
  }

  /** Tells whoever pressed "Update now" how it ended: up_to_date, error, disabled or installing. */
  _finishManual(outcome) {
    if (!this.installWhenReady && outcome !== 'disabled') return;
    this.installWhenReady = false;
    this.emit('manual-result', { ...this.status, outcome });
  }

  /**
   * "Update now": check, download and install straight away, without waiting
   * for the quiet hours. Nobody needs to be signed in to the POS.
   */
  async updateNow() {
    if (!this.enabled) {
      this._finishManual('disabled');
      return;
    }
    if (this.status.state === 'installing' || this.installWhenReady) return;
    this.installWhenReady = true;
    if (this.status.state === 'ready') {
      this._installWhenNotPrinting();
    } else if (this.status.state !== 'downloading') {
      // A download already under way installs when it finishes.
      await this.check();
    }
  }

  _installWhenNotPrinting() {
    if (this.isPrinting()) {
      this._set({ message: 'Waiting for the ticket being printed' });
      this.setTimeoutImpl(() => this._installWhenNotPrinting(), PRINT_WAIT_MS);
      return;
    }
    this._finishManual('installing');
    this.installNow();
  }

  installIfQuiet(now = new Date()) {
    if (shouldInstallNow({ downloaded: this.status.state === 'ready', now, printing: this.isPrinting() })) {
      this.installNow();
      return true;
    }
    return false;
  }

  installNow() {
    if (this.status.state !== 'ready') return;
    this._set({ state: 'installing', message: '' });
    this.emit('installing');
    // Silent install, then start the app again.
    this.autoUpdater.quitAndInstall(true, true);
  }
}

module.exports = { Updater, inQuietHours, shouldInstallNow };

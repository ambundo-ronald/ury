// Prints an HTML page silently on a named Windows printer, through
// Chromium's own printing (the same engine as the POS window).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow } = require('electron');

const LOAD_TIMEOUT_MS = 20000;

function printHtml(html, deviceName) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `ury-print-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(file, html, 'utf8');

    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    // The page is only to be printed: no navigation, no popups.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let finished = false;
    const done = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      fs.rm(file, { force: true }, () => undefined);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => done(new Error('The page took too long to prepare.')), LOAD_TIMEOUT_MS);

    win.webContents.once('did-fail-load', (_e, code, description) => done(new Error(`Could not prepare the page (${description || code}).`)));
    win.webContents.once('did-finish-load', () => {
      // Let images (logos) settle before printing.
      setTimeout(() => {
        win.webContents.print(
          { silent: true, deviceName, printBackground: true, margins: { marginType: 'none' } },
          (success, failureReason) => done(success ? null : new Error(failureReason || 'The printer refused the job.'))
        );
      }, 300);
    });
    win.loadFile(file);
  });
}

async function listPrinters(webContents) {
  const printers = await webContents.getPrintersAsync();
  return printers.map((p) => p.name);
}

module.exports = { printHtml, listPrinters };

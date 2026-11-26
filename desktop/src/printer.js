// Prints an HTML page silently on a named Windows printer, through
// Chromium's own printing (the same engine as the POS window).
//
// By default the page is first drawn as a picture and only the picture is
// printed. Chromium sends text to Windows as font glyph numbers; some receipt
// printer drivers (Xprinter and others) swap the font for the printer's own
// and print those numbers as random characters. A picture has no text, so it
// prints the same on every driver.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow } = require('electron');

const LOAD_TIMEOUT_MS = 20000;
// Let images (logos) settle before printing or drawing.
const SETTLE_MS = 300;
// 80 mm receipt paper in CSS pixels (96 per inch). Tickets are laid out at
// this width, as when the page itself is printed on 80 mm paper.
const PAPER_CSS_PX = 302;
// Drawn at twice the size: 604 dots across, about the 576-640 dots of an
// 80 mm thermal printer, so text stays sharp.
const PICTURE_ZOOM = 2;
// Chromium cannot draw a picture taller than this.
const MAX_PICTURE_PX = 16000;

function tempFile(html) {
  const file = path.join(os.tmpdir(), `ury-print-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function hiddenWindow(extra = {}) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    ...extra,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(extra.webPreferences || {}) },
  });
  // The page is only to be printed: no navigation, no popups.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

/** Loads the page in a hidden window, runs work(win) once it has settled, and always cleans up. */
function withLoadedPage(html, windowOptions, work) {
  return new Promise((resolve, reject) => {
    const file = tempFile(html);
    const win = hiddenWindow(windowOptions);
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      fs.rm(file, { force: true }, () => undefined);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('The page took too long to prepare.')), LOAD_TIMEOUT_MS);
    win.webContents.once('did-fail-load', (_e, code, description) => done(new Error(`Could not prepare the page (${description || code}).`)));
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        Promise.resolve()
          .then(() => work(win))
          .then((value) => done(null, value), (error) => done(error));
      }, SETTLE_MS);
    });
    win.loadFile(file);
  });
}

function printLoaded(win, deviceName) {
  return new Promise((resolve, reject) => {
    win.webContents.print(
      { silent: true, deviceName, printBackground: true, margins: { marginType: 'none' } },
      (success, failureReason) => (success ? resolve() : reject(new Error(failureReason || 'The printer refused the job.')))
    );
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Draws the page at 80 mm wide and returns it as a PNG. */
function renderPicture(html) {
  return withLoadedPage(
    html,
    {
      width: PAPER_CSS_PX * PICTURE_ZOOM,
      height: 600,
      useContentSize: true,
      // Drawn off screen, so the window can be as tall as the ticket.
      webPreferences: { offscreen: true, zoomFactor: PICTURE_ZOOM },
    },
    async (win) => {
      const contents = win.webContents;
      const size = await contents.executeJavaScript(
        `(() => {
          const d = document.documentElement, b = document.body || d;
          return { width: Math.max(d.scrollWidth, b.scrollWidth), height: Math.max(d.scrollHeight, b.scrollHeight) };
        })()`
      );
      // A page wider than the paper is drawn whole and shrunk onto it.
      const cssWidth = Math.max(PAPER_CSS_PX, Math.ceil(size.width || 0));
      const cssHeight = Math.max(1, Math.ceil(size.height || 0));
      const zoom = Math.max(1, Math.min(PICTURE_ZOOM, Math.floor(MAX_PICTURE_PX / cssHeight)));
      contents.setZoomFactor(zoom);
      win.setContentSize(cssWidth * zoom, Math.min(cssHeight * zoom, MAX_PICTURE_PX));
      contents.invalidate();
      await wait(SETTLE_MS);
      const image = await contents.capturePage();
      if (image.isEmpty()) throw new Error('The ticket could not be drawn.');
      return image.toPNG();
    }
  );
}

/** The page that prints the picture across the paper's full width. */
function picturePage(png) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    img { display: block; width: 100%; height: auto; }
  </style></head><body><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`;
}

/**
 * @param {string} html the ticket or bill
 * @param {string} deviceName the Windows printer
 * @param {{asPicture?: boolean}} [options] asPicture defaults to true
 */
async function printHtml(html, deviceName, { asPicture = true } = {}) {
  let page = html;
  if (asPicture) {
    try {
      page = picturePage(await renderPicture(html));
    } catch (error) {
      // Better a ticket printed as text than none at all.
      console.warn(`Printing ${deviceName} as text: ${error.message}`);
    }
  }
  return withLoadedPage(page, {}, (win) => printLoaded(win, deviceName));
}

async function listPrinters(webContents) {
  const printers = await webContents.getPrintersAsync();
  return printers.map((p) => p.name);
}

module.exports = { printHtml, renderPicture, picturePage, listPrinters, PAPER_CSS_PX };

// URY POS for Windows: the POS in its own window, plus a print agent that
// keeps printing kitchen tickets and bills from the tray even when the POS
// window is closed or nobody is signed in.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, dialog, Notification } = require('electron');

const configModule = require('./config');
const { PrintAgent, pair } = require('./agent');
const printer = require('./printer');
const { Updater } = require('./updater');
const { FloatingButton, openKeyboard } = require('./floating-button');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let posWindow = null;
let setupWindow = null;
let tray = null;
let agent = null;
let updater = null;
let keyboardButton = null;
let updateButton = null;
let updateFlash = null;
let updateFlashTimer = null;
let config = null;
let quitting = false;

/**
 * Prints a ticket the way this PC is set to: ESC/POS straight to a receipt
 * printer, or through the Windows driver as a picture (the default) or as text.
 */
const printHtml = (html, printerName) => {
  const settings = config.get();
  if (settings.escposPrinters.includes(printerName)) return printer.printEscpos(html, printerName);
  return printer.printHtml(html, printerName, { asPicture: settings.printAsPicture });
};

const icon = () => nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));

function stateStore() {
  const file = path.join(app.getPath('userData'), 'agent-state.json');
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    save(state) {
      fs.writeFileSync(file, JSON.stringify(state));
    },
  };
}

/** The floating buttons show only over a visible POS window, and only if switched on. */
function syncFloatingButtons() {
  const visible = posWindow && !posWindow.isDestroyed() && posWindow.isVisible() && !posWindow.isMinimized();
  const settings = config.get();
  for (const [button, on] of [
    [keyboardButton, settings.keyboardButton],
    [updateButton, settings.updateButton],
  ]) {
    if (!button) continue;
    if (visible && on) button.show(posWindow);
    else button.hide();
  }
}

function setKeyboardButton(on) {
  config.setScreen({ keyboardButton: on });
  syncFloatingButtons();
  refreshTray();
}

function setUpdateButton(on) {
  config.setScreen({ updateButton: on });
  syncFloatingButtons();
  refreshTray();
}

/** What the update button shows: spinning while it works, a dot when an update waits. */
function renderUpdateButton() {
  if (!updateButton || !updater) return;
  const u = updater.status;
  const busy = ['checking', 'downloading', 'installing'].includes(u.state) || updater.installWhenReady;
  const title = {
    checking: 'Checking for an update...',
    downloading: `Downloading version ${u.version || ''} (${u.progress || 0}%)...`,
    installing: 'Installing the update...',
    ready: `Version ${u.version} is ready: tap to install it now`,
  }[u.state];
  updateButton.setState({
    busy,
    progress: u.state === 'downloading' ? u.progress || 0 : null,
    ready: u.state === 'ready',
    flash: busy ? null : updateFlash,
    title: title || `URY POS ${app.getVersion()}: tap to update now (drag to move)`,
  });
}

function flashUpdateButton(kind) {
  clearTimeout(updateFlashTimer);
  updateFlash = kind;
  renderUpdateButton();
  updateFlashTimer = setTimeout(() => {
    updateFlash = null;
    renderUpdateButton();
  }, kind === 'error' ? 6000 : 3000);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: icon() }).show();
}

/** "Update now": check, download and install straight away. Needs nobody signed in. */
function updateNow() {
  updater.updateNow();
  renderUpdateButton();
}

function onManualUpdateResult(result) {
  if (result.outcome === 'up_to_date') {
    flashUpdateButton('ok');
    notify('URY POS is up to date', `This is the latest version (${app.getVersion()}).`);
  } else if (result.outcome === 'installing') {
    notify(`Updating URY POS to ${result.version}`, 'The app closes and opens again in a few seconds. Printing carries on after.');
  } else if (result.outcome === 'disabled') {
    flashUpdateButton('error');
    notify('Updates are off', 'This copy of URY POS was not installed from a release, so it cannot update itself.');
  } else {
    flashUpdateButton('error');
    notify('Could not update URY POS', `${result.message || 'No connection'}. Check the internet connection and tap the update button again.`);
  }
}

function setFullScreen(on) {
  config.setScreen({ fullScreen: on });
  if (posWindow && !posWindow.isDestroyed()) posWindow.setFullScreen(on);
  refreshTray();
}

function openPos() {
  const { siteUrl, startPage, fullScreen } = config.get();
  if (!siteUrl) return openSetup();
  if (posWindow && !posWindow.isDestroyed()) {
    posWindow.show();
    posWindow.focus();
    return;
  }
  posWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    title: 'URY POS',
    icon: icon(),
    show: false,
    fullscreen: fullScreen,
    autoHideMenuBar: true,
    // The POS's own background, so there is no white flash while it loads.
    backgroundColor: '#f5f5f8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  posWindow.setMenu(null);
  if (!fullScreen) posWindow.maximize();
  posWindow.once('ready-to-show', () => posWindow.show());
  for (const event of ['show', 'hide', 'minimize', 'restore', 'closed', 'enter-full-screen', 'leave-full-screen']) {
    posWindow.on(event, syncFloatingButtons);
  }

  const contents = posWindow.webContents;
  // An app, not a browser: fixed size (no pinch or Ctrl+wheel zoom), F11 for full screen.
  contents.setVisualZoomLevelLimits(1, 1);
  const applyTextSize = () => contents.setZoomFactor(config.get().textSize);
  contents.on('zoom-changed', applyTextSize);
  contents.on('did-finish-load', applyTextSize);
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      setFullScreen(!posWindow.isFullScreen());
    } else if (input.control && ['+', '-', '=', '0'].includes(input.key)) {
      event.preventDefault();
    }
  });

  const origin = new URL(siteUrl).origin;
  const startUrl = configModule.posStartUrl(siteUrl, startPage);
  // No connection: show a page that says so and retries, instead of a white window.
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: navigation replaced by another
    posWindow.loadFile(path.join(__dirname, 'offline.html'), {
      query: { url: url && url.startsWith(origin) ? url : startUrl, reason: description || String(code) },
    });
  });
  // Stay on the URY site; anything else opens in the normal browser.
  posWindow.webContents.on('will-navigate', (event, url) => {
    // The offline page sends the window back to the site with Retry.
    if (url.startsWith('file:')) return;
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  posWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  posWindow.on('close', (event) => {
    // Closing the window keeps the print agent running in the tray.
    if (!quitting) {
      event.preventDefault();
      posWindow.hide();
    }
  });
  posWindow.loadURL(startUrl);
}

function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'URY POS - Printing',
    icon: icon(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'setup-preload.js'),
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}

function trayLabel(status) {
  return (
    {
      online: 'Printing: connected',
      offline: 'Printing: no connection, retrying',
      not_paired: 'Printing: not set up',
      stopped: 'Printing: stopped',
    }[status.state] || 'Printing'
  );
}

function updateMenuItems() {
  const u = updater ? updater.status : { state: 'disabled' };
  if (u.state === 'ready') {
    return [{ label: `Restart to update to ${u.version}`, click: updateNow }];
  }
  if (u.state === 'downloading') {
    const then = updater.installWhenReady ? ', installs when done' : '';
    return [{ label: `Downloading update ${u.version || ''} (${u.progress || 0}%${then})`, enabled: false }];
  }
  if (u.state === 'checking' || u.state === 'installing') return [{ label: 'Updating...', enabled: false }];
  if (u.state === 'disabled') return [];
  return [{ label: 'Update now', click: updateNow }];
}

function refreshTray() {
  if (!tray) return;
  const status = agent ? agent.status : { state: 'stopped' };
  const startsWithWindows = app.getLoginItemSettings().openAtLogin;
  tray.setToolTip(`URY POS - ${trayLabel(status)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open POS', click: openPos },
      { label: 'Printing status and setup', click: openSetup },
      { type: 'separator' },
      { label: trayLabel(status), enabled: false },
      ...updateMenuItems(),
      {
        label: 'POS full screen (F11)',
        type: 'checkbox',
        checked: config.get().fullScreen,
        click: (item) => setFullScreen(item.checked),
      },
      {
        label: 'Keyboard button on the POS',
        type: 'checkbox',
        checked: config.get().keyboardButton,
        click: (item) => setKeyboardButton(item.checked),
      },
      {
        label: 'Update button on the POS',
        type: 'checkbox',
        checked: config.get().updateButton,
        click: (item) => setUpdateButton(item.checked),
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startsWithWindows,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      {
        label: 'Quit (stops printing)',
        click: async () => {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Keep running', 'Quit'],
            defaultId: 0,
            cancelId: 0,
            message: 'Quit URY POS?',
            detail: 'Kitchen tickets and bills will not print from this PC until it is opened again.',
          });
          if (response === 1) {
            quitting = true;
            app.quit();
          }
        },
      },
    ])
  );
}

function sendStatus() {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('agent-status', agent.status);
  refreshTray();
}

function sendUpdateStatus() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('update-status', { ...updater.status, manual: updater.installWhenReady });
  }
  renderUpdateButton();
  refreshTray();
}

function setupIpc() {
  ipcMain.handle('get-state', () => {
    const { siteUrl, agentName, branch, token, startPage, fullScreen, keyboardButton: showKeyboardButton, updateButton: showUpdateButton, textSize, printAsPicture, escposPrinters } = config.get();
    return {
      siteUrl,
      agentName,
      branch,
      startPage,
      fullScreen,
      keyboardButton: showKeyboardButton,
      updateButton: showUpdateButton,
      textSize,
      printAsPicture,
      escposPrinters,
      paired: Boolean(token),
      status: agent.status,
      update: { ...updater.status, manual: updater.installWhenReady },
      version: app.getVersion(),
    };
  });

  ipcMain.handle('set-screen', (_event, { startPage, fullScreen, keyboardButton: showKeyboardButton, updateButton: showUpdateButton, textSize, printAsPicture }) => {
    const before = config.get();
    config.setScreen({ startPage, fullScreen, textSize, printAsPicture });
    if (textSize !== undefined && posWindow && !posWindow.isDestroyed()) {
      posWindow.webContents.setZoomFactor(config.get().textSize);
    }
    if (showKeyboardButton !== undefined) setKeyboardButton(Boolean(showKeyboardButton));
    if (showUpdateButton !== undefined) setUpdateButton(Boolean(showUpdateButton));
    if (fullScreen !== undefined && Boolean(fullScreen) !== before.fullScreen) setFullScreen(Boolean(fullScreen));
    // A different start page applies when the POS window opens next; reload it now if open.
    if (startPage !== undefined && startPage !== before.startPage && posWindow && !posWindow.isDestroyed()) {
      const now = config.get();
      posWindow.loadURL(configModule.posStartUrl(now.siteUrl, now.startPage));
    }
    return true;
  });

  ipcMain.handle('check-update', () => updater.check());
  ipcMain.handle('install-update', () => updateNow());
  ipcMain.handle('update-now', () => updateNow());

  ipcMain.handle('pair', async (_event, { siteUrl, agentName, code }) => {
    const site = configModule.normaliseSiteUrl(siteUrl);
    const result = await pair({ siteUrl: site, agentName: String(agentName || '').trim(), code: String(code || '').trim() });
    config.setPairing({ siteUrl: site, agentName: result.agentName, branch: result.branch, token: result.token });
    // A printing PC must come back by itself after a restart or power cut.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    agent.stop();
    agent.start();
    return { agentName: result.agentName, branch: result.branch };
  });

  ipcMain.handle('set-site', (_event, siteUrl) => {
    const first = !config.get().siteUrl;
    config.setSite(configModule.normaliseSiteUrl(siteUrl));
    // A POS screen should be back on the POS after a restart or power cut.
    // (Pairing a printing PC changes this to start hidden in the tray.)
    if (first && app.isPackaged && !app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args: [] });
    }
    return true;
  });

  ipcMain.handle('unpair', () => {
    config.clearPairing();
    agent.stop();
    agent.start();
    return true;
  });

  ipcMain.handle('list-printers', () => printer.listPrinters(setupWindow.webContents));

  ipcMain.handle('set-escpos', (_event, { printerName, on }) => {
    config.setEscpos(String(printerName || ''), Boolean(on));
    return config.get().escposPrinters;
  });

  ipcMain.handle('test-print', async (_event, printerName) => {
    const now = new Date().toLocaleString();
    await printHtml(
      `<!doctype html><html><body style="font-family:sans-serif;width:72mm;margin:0;padding:4mm">
        <h2 style="margin:0 0 2mm">URY test print</h2>
        <div>${printerName.replace(/[<>&]/g, '')}</div><div>${now}</div>
        <p>If you can read this, this printer works from URY POS.</p></body></html>`,
      printerName
    );
    return true;
  });

  ipcMain.handle('open-pos', () => openPos());
}

app.whenReady().then(() => {
  app.setAppUserModelId('io.ury.pos');
  config = configModule.create({ dir: app.getPath('userData'), safeStorage });

  agent = new PrintAgent({
    getConfig: () => config.get(),
    printHtml,
    listPrinters: async () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win) return printer.listPrinters(win.webContents);
      const probe = new BrowserWindow({ show: false });
      try {
        return await printer.listPrinters(probe.webContents);
      } finally {
        probe.destroy();
      }
    },
    store: stateStore(),
    version: app.getVersion(),
  });
  agent.on('status', sendStatus);

  updater = new Updater({
    autoUpdater: require('electron-updater').autoUpdater,
    // Development runs and local builds have no update feed; release builds
    // from CI carry app-update.yml.
    enabled: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    isPrinting: () => Boolean(agent.busy),
  });
  updater.on('status', sendUpdateStatus);
  updater.on('manual-result', onManualUpdateResult);
  updater.on('installing', () => {
    quitting = true;
    agent.stop();
  });
  updater.start();

  keyboardButton = new FloatingButton({
    page: 'keyboard.html',
    title: 'Keyboard',
    onTap: openKeyboard,
    getPosition: () => config.get().keyboardButtonPosition,
    savePosition: (position) => config.setScreen({ keyboardButtonPosition: position }),
  });
  updateButton = new FloatingButton({
    page: 'update-button.html',
    title: 'Update',
    slot: 1,
    onTap: updateNow,
    getPosition: () => config.get().updateButtonPosition,
    savePosition: (position) => config.setScreen({ updateButtonPosition: position }),
  });
  renderUpdateButton();

  setupIpc();
  tray = new Tray(icon());
  tray.on('double-click', openPos);
  refreshTray();

  agent.start();
  const hidden = process.argv.includes('--hidden');
  // Only the PC with the printers is paired; every other PC is just a POS screen.
  if (!config.get().siteUrl) openSetup();
  else if (!hidden) openPos();
});

app.on('second-instance', () => openPos());
// Keep running in the tray when every window is closed.
app.on('window-all-closed', () => undefined);
app.on('before-quit', () => {
  quitting = true;
  if (agent) agent.stop();
});

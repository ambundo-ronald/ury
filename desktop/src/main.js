// URY POS for Windows: the POS in its own window, plus a print agent that
// keeps printing kitchen tickets and bills from the tray even when the POS
// window is closed or nobody is signed in.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, dialog } = require('electron');

const configModule = require('./config');
const { PrintAgent, pair } = require('./agent');
const printer = require('./printer');
const { Updater } = require('./updater');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let posWindow = null;
let setupWindow = null;
let tray = null;
let agent = null;
let updater = null;
let config = null;
let quitting = false;

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

function openPos() {
  const { siteUrl } = config.get();
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
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  posWindow.maximize();

  const origin = new URL(siteUrl).origin;
  // Stay on the URY site; anything else opens in the normal browser.
  posWindow.webContents.on('will-navigate', (event, url) => {
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
  posWindow.loadURL(`${origin}/pos`);
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
    return [{ label: `Restart to update to ${u.version}`, click: () => updater.installNow() }];
  }
  if (u.state === 'downloading') {
    return [{ label: `Downloading update ${u.version || ''} (${u.progress || 0}%)`, enabled: false }];
  }
  if (u.state === 'disabled') return [];
  return [{ label: 'Check for updates', click: () => updater.check() }];
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
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('update-status', updater.status);
  refreshTray();
}

function setupIpc() {
  ipcMain.handle('get-state', () => {
    const { siteUrl, agentName, branch, token } = config.get();
    return {
      siteUrl,
      agentName,
      branch,
      paired: Boolean(token),
      status: agent.status,
      update: updater.status,
      version: app.getVersion(),
    };
  });

  ipcMain.handle('check-update', () => updater.check());
  ipcMain.handle('install-update', () => updater.installNow());

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
    config.setSite(configModule.normaliseSiteUrl(siteUrl));
    return true;
  });

  ipcMain.handle('unpair', () => {
    config.clearPairing();
    agent.stop();
    agent.start();
    return true;
  });

  ipcMain.handle('list-printers', () => printer.listPrinters(setupWindow.webContents));

  ipcMain.handle('test-print', async (_event, printerName) => {
    const now = new Date().toLocaleString();
    await printer.printHtml(
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
    printHtml: printer.printHtml,
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
  updater.on('installing', () => {
    quitting = true;
    agent.stop();
  });
  updater.start();

  setupIpc();
  tray = new Tray(icon());
  tray.on('double-click', openPos);
  refreshTray();

  agent.start();
  const hidden = process.argv.includes('--hidden');
  if (!config.get().siteUrl || !config.get().token) openSetup();
  else if (!hidden) openPos();
});

app.on('second-instance', () => openPos());
// Keep running in the tray when every window is closed.
app.on('window-all-closed', () => undefined);
app.on('before-quit', () => {
  quitting = true;
  if (agent) agent.stop();
});

// A small floating button over the POS window that opens Windows' On-Screen
// Keyboard, so staff can type in full screen without a physical keyboard.
//
// The button never takes focus (focusable: false): the cursor stays in the
// POS text box, and the keyboard types there. Drag it to move it; a tap
// (a press that moves less than a few pixels) opens the keyboard.

const path = require('path');
const { BrowserWindow, ipcMain, screen, shell } = require('electron');

const SIZE = 64;
const TAP_PIXELS = 6;

function oskPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'osk.exe');
}

/** Keep the button fully on the display it is on. */
function clampToDisplay(x, y) {
  const area = screen.getDisplayNearestPoint({ x, y }).bounds;
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - SIZE),
    y: Math.min(Math.max(y, area.y), area.y + area.height - SIZE),
  };
}

class KeyboardButton {
  constructor({ getPosition, savePosition, openKeyboard = () => shell.openPath(oskPath()) }) {
    this.getPosition = getPosition;
    this.savePosition = savePosition;
    this.openKeyboard = openKeyboard;
    this.window = null;
    this.drag = null;

    ipcMain.on('keyboard-button', (event, phase) => {
      if (!this.window || event.sender !== this.window.webContents) return;
      this.onPointer(phase);
    });
  }

  defaultPosition(nearWindow) {
    const bounds = nearWindow ? nearWindow.getBounds() : screen.getPrimaryDisplay().bounds;
    const area = screen.getDisplayMatching(bounds).bounds;
    // Left edge, a little below the middle: clear of the POS header and the order panel.
    return { x: area.x + 12, y: area.y + Math.round(area.height * 0.55) };
  }

  show(nearWindow) {
    if (!this.window || this.window.isDestroyed()) this.create(nearWindow);
    this.window.showInactive();
    this.window.setAlwaysOnTop(true, 'screen-saver');
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  create(nearWindow) {
    const wanted = this.getPosition() || this.defaultPosition(nearWindow);
    const start = clampToDisplay(wanted.x, wanted.y);
    this.window = new BrowserWindow({
      ...start,
      width: SIZE,
      height: SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      alwaysOnTop: true,
      title: 'Keyboard',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'keyboard-preload.js'),
      },
    });
    this.window.loadFile(path.join(__dirname, 'keyboard.html'));
  }

  onPointer(phase) {
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'down') {
      const [x, y] = this.window.getPosition();
      this.drag = { cursor, x, y, moved: false };
    } else if (phase === 'move' && this.drag) {
      const dx = cursor.x - this.drag.cursor.x;
      const dy = cursor.y - this.drag.cursor.y;
      if (Math.abs(dx) > TAP_PIXELS || Math.abs(dy) > TAP_PIXELS) this.drag.moved = true;
      if (this.drag.moved) {
        const next = clampToDisplay(this.drag.x + dx, this.drag.y + dy);
        this.window.setPosition(next.x, next.y);
      }
    } else if (phase === 'up' && this.drag) {
      const { moved } = this.drag;
      this.drag = null;
      if (moved) {
        const [x, y] = this.window.getPosition();
        this.savePosition({ x, y });
      } else {
        this.openKeyboard();
      }
    } else if (phase === 'cancel') {
      this.drag = null;
    }
  }
}

module.exports = { KeyboardButton, clampToDisplay, SIZE };

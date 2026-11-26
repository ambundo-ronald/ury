// Small round buttons that float over the POS window: one opens Windows'
// On-Screen Keyboard, so staff can type in full screen without a physical
// keyboard; one updates the app ("sync"). They belong to the app, not to the
// site, so they work on the station PIN screen and the offline page too, with
// nobody signed in.
//
// A button never takes focus (focusable: false): the cursor stays in the POS
// text box, and the keyboard types there. Drag a button to move it; a tap (a
// press that moves less than a few pixels) runs its action.

const path = require('path');
const { BrowserWindow, ipcMain, screen, shell } = require('electron');

const SIZE = 64;
const TAP_PIXELS = 6;
// The update button's default place: just above the keyboard button.
const STACK_GAP = 12;

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

class FloatingButton {
  /**
   * @param {object} options
   * @param {string} options.page HTML file in src/
   * @param {string} options.title
   * @param {() => void} options.onTap
   * @param {() => ({x: number, y: number} | null)} options.getPosition
   * @param {(position: {x: number, y: number}) => void} options.savePosition
   * @param {number} [options.slot] 0 = keyboard place, 1 = just above it
   */
  constructor({ page, title, onTap, getPosition, savePosition, slot = 0 }) {
    this.page = page;
    this.title = title;
    this.onTap = onTap;
    this.getPosition = getPosition;
    this.savePosition = savePosition;
    this.slot = slot;
    this.window = null;
    this.drag = null;
    this.lastState = null;

    ipcMain.on('floating-button', (event, phase) => {
      if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) return;
      this.onPointer(phase);
    });
  }

  defaultPosition(nearWindow) {
    const bounds = nearWindow ? nearWindow.getBounds() : screen.getPrimaryDisplay().bounds;
    const area = screen.getDisplayMatching(bounds).bounds;
    // Left edge, a little below the middle: clear of the POS header and the order panel.
    return { x: area.x + 12, y: area.y + Math.round(area.height * 0.55) - this.slot * (SIZE + STACK_GAP) };
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

  /** Sends a state to the button's page (the update button shows progress). */
  setState(state) {
    this.lastState = state;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('floating-button-state', state);
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
      title: this.title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'floating-button-preload.js'),
      },
    });
    this.window.webContents.on('did-finish-load', () => {
      if (this.lastState) this.setState(this.lastState);
    });
    this.window.loadFile(path.join(__dirname, this.page));
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
        this.onTap();
      }
    } else if (phase === 'cancel') {
      this.drag = null;
    }
  }
}

const openKeyboard = () => shell.openPath(oskPath());

module.exports = { FloatingButton, openKeyboard, clampToDisplay, SIZE };

// Settings kept on this PC: the site address and the print agent's token.
// The token is encrypted with Windows' own protection (DPAPI) when available.

const fs = require('fs');
const path = require('path');

function create({ dir, safeStorage }) {
  const file = path.join(dir, 'config.json');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  function write(data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function encrypt(text) {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(text).toString('base64') };
    }
    return { plain: text };
  }

  function decrypt(stored) {
    if (!stored) return null;
    if (stored.enc && safeStorage) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
      } catch {
        return null;
      }
    }
    return stored.plain || null;
  }

  return {
    get() {
      const data = read();
      return {
        siteUrl: data.siteUrl || '',
        agentName: data.agentName || '',
        branch: data.branch || '',
        token: decrypt(data.token),
        // The POS window: the station PIN screen or the normal login, full screen or not.
        startPage: data.startPage === 'login' ? 'login' : 'station',
        fullScreen: data.fullScreen !== false,
      };
    },
    setScreen({ startPage, fullScreen }) {
      const data = read();
      if (startPage !== undefined) data.startPage = startPage === 'login' ? 'login' : 'station';
      if (fullScreen !== undefined) data.fullScreen = Boolean(fullScreen);
      write(data);
    },
    setSite(siteUrl) {
      write({ ...read(), siteUrl });
    },
    setPairing({ siteUrl, agentName, branch, token }) {
      write({ ...read(), siteUrl, agentName, branch, token: encrypt(token) });
    },
    clearPairing() {
      const data = read();
      delete data.token;
      write(data);
    },
  };
}

/** "red.example.com/" or "https://red.example.com/pos" -> "https://red.example.com" */
function normaliseSiteUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Enter the site address.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname) && !url.hostname.endsWith('.localhost')) {
    throw new Error('The site address must start with https://');
  }
  return url.origin;
}

/** Where the POS window opens: the station PIN screen, or URY's normal login (which leads to the POS). */
function posStartUrl(siteUrl, startPage) {
  return `${new URL(siteUrl).origin}${startPage === 'login' ? '/pos' : '/station'}`;
}

module.exports = { create, normaliseSiteUrl, posStartUrl };

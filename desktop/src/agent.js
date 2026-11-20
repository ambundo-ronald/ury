// The print agent: asks the URY site for tickets and bills to print, prints
// them on this PC's Windows printers and reports back. Runs in the
// background whether or not anyone is signed in to the POS window.
//
// Server side: ury/ury/printing/agent.py. Outgoing HTTPS only.

const EventEmitter = require('events');

const POLL_MS = 3000;
const OFFLINE_POLL_MS = 10000;
const PRINTERS_EVERY_MS = 60000;
const REMEMBER_PRINTED = 500;

class ApiError extends Error {
  constructor(message, status, excType) {
    super(message);
    this.status = status;
    this.excType = excType;
  }
}

/** Frappe error text from a failed response body. */
function errorMessage(body, fallback) {
  try {
    if (body && body._server_messages) {
      const messages = JSON.parse(body._server_messages).map((m) => {
        try {
          return JSON.parse(m).message;
        } catch {
          return m;
        }
      });
      if (messages.length) return messages.join(' ').replace(/<[^>]+>/g, '');
    }
    if (body && body.exception) return String(body.exception).split(':').slice(1).join(':').trim() || fallback;
  } catch {
    // fall through
  }
  return fallback;
}

async function callApi(fetchImpl, siteUrl, method, data, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['X-URY-Agent-Token'] = token;
  let response;
  try {
    response = await fetchImpl(`${siteUrl}/api/method/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data || {}),
    });
  } catch (error) {
    throw new ApiError(`Cannot reach ${siteUrl}: ${error.message}`, 0);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiError(errorMessage(body, `The site answered ${response.status}.`), response.status, body && body.exc_type);
  }
  return body ? body.message : null;
}

/** Swap a pairing code from the URY Print Agent form for this PC's token. */
async function pair({ fetchImpl = fetch, siteUrl, agentName, code }) {
  const result = await callApi(fetchImpl, siteUrl, 'ury.ury.printing.agent.pair', { agent_name: agentName, code });
  return { agentName: result.agent, branch: result.branch, token: `${result.agent}:${result.token}` };
}

class PrintAgent extends EventEmitter {
  /**
   * @param {object} options
   * @param {() => {siteUrl: string, token: string|null}} options.getConfig
   * @param {(html: string, printer: string) => Promise<void>} options.printHtml rejects with the reason
   * @param {() => Promise<string[]>} options.listPrinters
   * @param {{load: () => object, save: (state: object) => void}} options.store
   */
  constructor({ getConfig, printHtml, listPrinters, store, fetchImpl = fetch, version = '0.0.0', setTimer = setTimeout }) {
    super();
    this.getConfig = getConfig;
    this.printHtml = printHtml;
    this.listPrinters = listPrinters;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.version = version;
    this.setTimer = setTimer;
    const saved = (store && store.load()) || {};
    // Printed but not yet confirmed to the site: never print these again.
    this.printed = new Map(saved.printed || []);
    this.unreported = saved.unreported || [];
    this.lastPrintersSent = 0;
    this.running = false;
    this.status = { state: 'stopped', message: '', lastContact: null, recent: [] };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this._setStatus({ state: 'stopped', message: '' });
  }

  _setStatus(update) {
    this.status = { ...this.status, ...update };
    this.emit('status', this.status);
  }

  _remember(entry) {
    const recent = [entry, ...this.status.recent].slice(0, 20);
    this._setStatus({ recent });
  }

  _save() {
    if (!this.store) return;
    const printed = [...this.printed.entries()].slice(-REMEMBER_PRINTED);
    this.printed = new Map(printed);
    this.store.save({ printed, unreported: this.unreported });
  }

  async _loop() {
    if (!this.running) return;
    let delay = POLL_MS;
    try {
      await this.tick();
    } catch (error) {
      delay = OFFLINE_POLL_MS;
      const notPaired = error.status === 401 || error.status === 403 || error.excType === 'AuthenticationError';
      this._setStatus({
        state: notPaired ? 'not_paired' : 'offline',
        message: error.message,
      });
    }
    if (this.running) this.timer = this.setTimer(() => this._loop(), delay);
  }

  /** One round: send pending reports, poll, print what came back. */
  async tick() {
    const { siteUrl, token } = this.getConfig();
    if (!siteUrl || !token) {
      const error = new Error('Printing is not set up on this PC yet.');
      error.status = 401;
      throw error;
    }
    const api = (method, data) => callApi(this.fetchImpl, siteUrl, method, data, token);

    await this._flushReports(api);

    const payload = { app_version: this.version };
    if (Date.now() - this.lastPrintersSent > PRINTERS_EVERY_MS) {
      try {
        payload.printers = JSON.stringify(await this.listPrinters());
      } catch {
        // Not fatal: the site just keeps the last list.
      }
    }
    const result = await api('ury.ury.printing.agent.poll', payload);
    if (payload.printers) this.lastPrintersSent = Date.now();
    this._setStatus({ state: 'online', message: '', lastContact: new Date().toISOString() });

    for (const job of (result && result.jobs) || []) {
      await this._printJob(api, job);
    }
  }

  async _printJob(api, job) {
    const key = String(job.job);
    let ok = true;
    let reason = null;
    if (this.printed.has(key)) {
      // Printed before, but the site never heard: just confirm it.
    } else {
      try {
        await this.printHtml(job.html, job.printer);
        this.printed.set(key, Date.now());
      } catch (error) {
        ok = false;
        reason = `${job.printer}: ${error.message || error}`;
      }
    }
    this._remember({ job: key, label: job.label, printer: job.printer, ok, reason, at: new Date().toISOString() });
    this.unreported.push({ job: key, ok: ok ? 1 : 0, error: reason });
    this._save();
    await this._flushReports(api);
  }

  async _flushReports(api) {
    while (this.unreported.length) {
      const next = this.unreported[0];
      try {
        await api('ury.ury.printing.agent.report', next);
      } catch (error) {
        // A job the site no longer knows (e.g. deleted) must not block the rest.
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 401) {
          this.unreported.shift();
          this._save();
          continue;
        }
        throw error;
      }
      this.unreported.shift();
      this._save();
    }
  }
}

module.exports = { PrintAgent, pair, callApi, ApiError, errorMessage };

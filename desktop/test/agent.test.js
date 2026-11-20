const test = require('node:test');
const assert = require('node:assert');
const { PrintAgent, pair, errorMessage } = require('../src/agent');

function fakeSite(handlers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/api/method/')[1];
    const body = JSON.parse(options.body);
    calls.push({ method, body, token: options.headers['X-URY-Agent-Token'] });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected ${method}`);
    const result = await handler(body);
    if (result && result.httpStatus) {
      return { ok: false, status: result.httpStatus, json: async () => result.body || {} };
    }
    return { ok: true, status: 200, json: async () => ({ message: result }) };
  };
  return { fetchImpl, calls };
}

function memoryStore(initial = {}) {
  let state = initial;
  return { load: () => state, save: (s) => (state = JSON.parse(JSON.stringify(s))), get: () => state };
}

function makeAgent(site, { printHtml, store = memoryStore() } = {}) {
  const printed = [];
  const agent = new PrintAgent({
    getConfig: () => ({ siteUrl: 'https://pos.example.com', token: 'PC:secret' }),
    printHtml: printHtml || (async (html, printer) => printed.push({ html, printer })),
    listPrinters: async () => ['Kitchen', 'Bar'],
    store,
    fetchImpl: site.fetchImpl,
    version: '1.0.0',
  });
  return { agent, printed, store };
}

const job = (id, printer = 'Kitchen') => ({ job: id, label: `KOT ${id}`, printer, html: `<p>${id}</p>` });

test('prints each job on its printer and reports it', async () => {
  const site = fakeSite({
    'ury.ury.printing.agent.poll': () => ({ jobs: [job(1), job(2, 'Bar')] }),
    'ury.ury.printing.agent.report': () => ({ status: 'Printed' }),
  });
  const { agent, printed } = makeAgent(site);
  await agent.tick();

  assert.deepStrictEqual(printed.map((p) => p.printer), ['Kitchen', 'Bar']);
  const reports = site.calls.filter((c) => c.method.endsWith('.report')).map((c) => c.body);
  assert.deepStrictEqual(reports, [
    { job: '1', ok: 1, error: null },
    { job: '2', ok: 1, error: null },
  ]);
  assert.ok(site.calls.every((c) => c.token === 'PC:secret'));
  assert.strictEqual(agent.status.state, 'online');
});

test('sends the printer list with the first poll', async () => {
  const site = fakeSite({ 'ury.ury.printing.agent.poll': () => ({ jobs: [] }) });
  const { agent } = makeAgent(site);
  await agent.tick();
  await agent.tick();
  const polls = site.calls.filter((c) => c.method.endsWith('.poll'));
  assert.strictEqual(polls[0].body.printers, JSON.stringify(['Kitchen', 'Bar']));
  assert.strictEqual(polls[1].body.printers, undefined);
});

test('a printer error is reported as a failure with the reason', async () => {
  const site = fakeSite({
    'ury.ury.printing.agent.poll': () => ({ jobs: [job(3)] }),
    'ury.ury.printing.agent.report': () => ({ status: 'Failed' }),
  });
  const { agent } = makeAgent(site, {
    printHtml: async () => {
      throw new Error('Invalid deviceName provided');
    },
  });
  await agent.tick();
  const report = site.calls.find((c) => c.method.endsWith('.report')).body;
  assert.deepStrictEqual(report, { job: '3', ok: 0, error: 'Kitchen: Invalid deviceName provided' });
});

test('a job printed but not confirmed is confirmed later, never printed twice', async () => {
  let reportUp = false;
  let handOut = true;
  const site = fakeSite({
    'ury.ury.printing.agent.poll': () => ({ jobs: handOut ? [job(4)] : [] }),
    'ury.ury.printing.agent.report': () => {
      if (!reportUp) throw new Error('network down');
      return { status: 'Printed' };
    },
  });
  const store = memoryStore();
  const { agent, printed } = makeAgent(site, { store });

  await assert.rejects(agent.tick());
  assert.strictEqual(printed.length, 1);
  assert.strictEqual(store.get().unreported.length, 1);

  // App restarts; the site offers the job again after the claim expires.
  const restarted = makeAgent(site, { store });
  reportUp = true;
  await restarted.agent.tick();
  assert.strictEqual(restarted.printed.length, 0, 'not printed again');
  assert.strictEqual(store.get().unreported.length, 0);
  handOut = false;
});

test('a not-paired answer is shown as not set up', async () => {
  const site = fakeSite({
    'ury.ury.printing.agent.poll': () => ({
      httpStatus: 401,
      body: { exc_type: 'AuthenticationError', _server_messages: JSON.stringify([JSON.stringify({ message: 'This print agent is not paired.' })]) },
    }),
  });
  const { agent } = makeAgent(site);
  agent.running = true;
  agent.setTimer = () => 0;
  await agent._loop();
  assert.strictEqual(agent.status.state, 'not_paired');
  assert.match(agent.status.message, /not paired/);
});

test('pairing returns the header token', async () => {
  const site = fakeSite({
    'ury.ury.printing.agent.pair': (body) => {
      assert.deepStrictEqual(body, { agent_name: 'POS-PC', code: '123456' });
      return { agent: 'POS-PC', token: 'abc', branch: 'Main' };
    },
  });
  const result = await pair({ fetchImpl: site.fetchImpl, siteUrl: 'https://pos.example.com', agentName: 'POS-PC', code: '123456' });
  assert.deepStrictEqual(result, { agentName: 'POS-PC', branch: 'Main', token: 'POS-PC:abc' });
});

test('frappe error messages are readable', () => {
  const body = { _server_messages: JSON.stringify([JSON.stringify({ message: 'Wrong <b>code</b>' })]) };
  assert.strictEqual(errorMessage(body, 'x'), 'Wrong code');
  assert.strictEqual(errorMessage(null, 'fallback'), 'fallback');
});

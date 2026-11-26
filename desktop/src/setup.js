const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  online: 'Connected: printing',
  offline: 'No connection: tickets wait on the site and print when it is back',
  not_paired: 'Not set up',
  stopped: 'Stopped',
};

function showResult(el, ok, text) {
  el.className = ok ? 'good' : 'error';
  el.textContent = text;
}

function cleanError(error) {
  // Electron prefixes IPC errors with "Error invoking remote method '...': Error: "
  return String((error && error.message) || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function renderStatus(status) {
  $('status').className = `status ${status.state}`;
  $('status-text').textContent = STATE_TEXT[status.state] || status.state;
  const last = status.lastContact ? `Last contact ${new Date(status.lastContact).toLocaleTimeString()}. ` : '';
  $('status-msg').textContent = last + (status.message || '');

  const recent = status.recent || [];
  const list = $('recent');
  list.innerHTML = '';
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'msg';
    li.textContent = 'Nothing yet.';
    list.appendChild(li);
  }
  for (const item of recent) {
    const li = document.createElement('li');
    li.className = item.ok ? '' : 'bad';
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${item.ok ? 'Printed' : 'Failed'}: ${item.label || item.job}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.printer} · ${new Date(item.at).toLocaleTimeString()}${item.reason ? ` · ${item.reason}` : ''}`;
    li.append(what, meta);
    list.appendChild(li);
  }
}

async function loadPrinters() {
  const select = $('printers');
  select.innerHTML = '';
  try {
    const names = await window.ury.listPrinters();
    for (const name of names) {
      const option = document.createElement('option');
      option.value = option.textContent = name;
      select.appendChild(option);
    }
    if (!names.length) {
      const option = document.createElement('option');
      option.textContent = 'No printers installed in Windows';
      option.value = '';
      select.appendChild(option);
    }
  } catch (error) {
    showResult($('test-result'), false, cleanError(error));
  }
}

function renderUpdate(update) {
  const text = {
    disabled: 'Updates are off in this build (development or no update feed).',
    idle: 'Checks for updates every few hours.',
    checking: 'Checking for updates...',
    up_to_date: 'Up to date.',
    downloading: `Downloading version ${update.version || ''} (${update.progress || 0}%). Printing carries on.`,
    ready: `Version ${update.version} is ready. It installs by itself between 3 and 5 a.m., when the app is quit, or now with Restart to update (printing pauses for about 10 seconds).`,
    error: `Could not check for updates: ${update.message || 'no connection'}. Will try again later.`,
  }[update.state];
  $('update-text').textContent = text || update.state;
  $('install-update').classList.toggle('hidden', update.state !== 'ready');
  $('check-update').disabled = ['disabled', 'checking', 'downloading', 'ready'].includes(update.state);
}

async function load() {
  const state = await window.ury.getState();
  $('site').value = state.siteUrl || '';
  $('agent').value = state.agentName || '';
  $('version').textContent = `URY POS ${state.version}`;
  $('unpair').classList.toggle('hidden', !state.paired);
  $('paired-as').textContent = state.paired ? `Paired as ${state.agentName} (${state.branch}) on ${state.siteUrl}` : '';
  $('open-pos').disabled = !state.siteUrl;
  $('start-page').value = state.startPage || 'station';
  $('full-screen').checked = state.fullScreen !== false;
  $('text-size').value = String(state.textSize || 0.875);
  $('keyboard-button').checked = state.keyboardButton !== false;
  renderStatus(state.status);
  renderUpdate(state.update);
}

$('check-update').addEventListener('click', () => window.ury.checkUpdate());
$('install-update').addEventListener('click', () => window.ury.installUpdate());
window.ury.onUpdate(renderUpdate);

$('pair').addEventListener('click', async () => {
  const button = $('pair');
  button.disabled = true;
  try {
    const result = await window.ury.pair({ siteUrl: $('site').value, agentName: $('agent').value, code: $('code').value });
    $('code').value = '';
    showResult($('pair-result'), true, `Paired as ${result.agentName}. Tickets for its printers now print here.`);
    await load();
  } catch (error) {
    showResult($('pair-result'), false, cleanError(error));
  } finally {
    button.disabled = false;
  }
});

$('unpair').addEventListener('click', async () => {
  if (!confirm('This PC will stop printing until it is paired again. Continue?')) return;
  await window.ury.unpair();
  await load();
});

$('test').addEventListener('click', async () => {
  const name = $('printers').value;
  if (!name) return;
  $('test').disabled = true;
  try {
    await window.ury.testPrint(name);
    showResult($('test-result'), true, `Sent a test page to ${name}.`);
  } catch (error) {
    showResult($('test-result'), false, cleanError(error));
  } finally {
    $('test').disabled = false;
  }
});

async function saveScreen(settings) {
  try {
    await window.ury.setScreen(settings);
    showResult($('screen-result'), true, 'Saved.');
  } catch (error) {
    showResult($('screen-result'), false, cleanError(error));
  }
}
$('start-page').addEventListener('change', () => saveScreen({ startPage: $('start-page').value }));
$('text-size').addEventListener('change', () => saveScreen({ textSize: Number($('text-size').value) }));
$('full-screen').addEventListener('change', () => saveScreen({ fullScreen: $('full-screen').checked }));
$('keyboard-button').addEventListener('change', () => saveScreen({ keyboardButton: $('keyboard-button').checked }));

$('refresh').addEventListener('click', loadPrinters);
$('open-pos').addEventListener('click', async () => {
  try {
    if ($('site').value) await window.ury.setSite($('site').value);
    await window.ury.openPos();
  } catch (error) {
    showResult($('pair-result'), false, cleanError(error));
  }
});

window.ury.onStatus(renderStatus);
load();
loadPrinters();

const FIELDS = ['provider', 'apiKey', 'model', 'fallbackModel', 'geminiKey', 'geminiModel', 'geminiFallbackModel',
                'openaiKey', 'openaiModel', 'openaiFallbackModel',
                'deepseekToken', 'deepseekModel', 'deepseekThinking', 'deepseekSearch',
                'geminiWebModel', 'geminiWebFallbackModel', 'geminiWebThinking', 'geminiWebModels', 'reuseChat', 'speedCache', 'speedParallel',
                'answerDelay', 'hotkeys', 'devMode'];
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_API = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const SERVICES = ['openrouter', 'gemini', 'openai', 'deepseek', 'gemini-web'];

// Reports are written by every context and read here, so the lines from this page carry their own
// tag rather than a bare 'page'.
window.ATSDebug?.scope?.('options');

/* ------------------------------------------------------------- shortcuts */

// The shortcuts as they were before they could be changed; the page script and the popup
// keep the same table (a test checks all three agree). `null` is "no shortcut".
const DEFAULT_HOTKEYS = {
  solve:  { code: 'KeyS', key: 's', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+S' },
  stop:   { code: 'KeyX', key: 'x', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+X' },
};
const ACTIONS = [
  ['solve', 'Solve this attempt'],
  ['stop', 'Stop'],
];
const clone = o => JSON.parse(JSON.stringify(o));

let hotkeys = clone(DEFAULT_HOTKEYS);
let recording = null;                 // the action whose box is waiting for a key press

// A shortcut is stored as the key itself, not as text, so the page can match it exactly:
// `code` is the physical key (so it does not move with the keyboard layout), the four
// flags are the modifiers, `label` is what to show.
const MODIFIER_KEY = /^(Control|Shift|Alt|AltGraph|Meta|OS)(Left|Right)?$/;
const KEY_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};
const keyName = code => KEY_NAMES[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');

function fromEvent(e) {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  return { code: e.code, key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
           label: [...mods, keyName(e.code)].join('+') };
}
const sameKey = (a, b) => a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;

function renderKeys() {
  const host = document.getElementById('keys');
  host.textContent = '';
  for (const [action, name] of ACTIONS) {
    const b = hotkeys[action];
    const row = document.createElement('div');
    row.className = 'keyrow';

    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;

    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'keybox' + (recording === action ? ' rec' : '') + (!b && recording !== action ? ' unset' : '');
    box.dataset.action = action;
    box.textContent = recording === action ? 'Press the keys… (Esc cancels)' : b ? b.label : 'Not set';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear';
    clear.dataset.clear = action;
    clear.textContent = 'Clear';
    clear.disabled = !b;

    row.append(label, box, clear);
    host.append(row);
  }
}

document.getElementById('keys').addEventListener('click', e => {
  const box = e.target.closest('[data-action]');
  const clear = e.target.closest('[data-clear]');
  e.stopPropagation();                                 // the click-away handler below must not cancel what this starts
  if (box) { recording = box.dataset.action; renderKeys(); return; }
  if (clear) { hotkeys[clear.dataset.clear] = null; recording = null; renderKeys(); status('Shortcut cleared — press Save to keep it.'); }
});

document.getElementById('resetKeys').addEventListener('click', () => {
  hotkeys = clone(DEFAULT_HOTKEYS);
  recording = null;
  renderKeys();
  status('Shortcuts reset — press Save to keep them.');
});

// Clicking anywhere else gives up on a recording.
document.addEventListener('click', () => { if (recording) { recording = null; renderKeys(); } });

// While a box is waiting, the next key press is the shortcut — it must not also do what
// that key normally does here.
document.addEventListener('keydown', e => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recording = null; renderKeys(); return; }
  if (!e.code || MODIFIER_KEY.test(e.code) || MODIFIER_KEY.test(e.key)) return;      // wait for the key itself
  const b = fromEvent(e);
  const action = recording;
  const clash = ACTIONS.find(([a]) => a !== action && hotkeys[a] && sameKey(hotkeys[a], b));
  recording = null;
  if (clash) {
    status(`${b.label} is already the shortcut for “${clash[1]}”. Clear that one first.`, 'bad');
  } else {
    hotkeys[action] = b;
    status('Shortcut changed — press Save to keep it.');
  }
  renderKeys();
}, true);

/* --------------------------------------------------------------- the rest */

async function load() {
  const s = await chrome.storage.local.get(FIELDS);
  // Settings saved before shortcuts could be changed name none; an action they do not
  // name keeps its default, and one saved as null stays unset.
  hotkeys = { ...clone(DEFAULT_HOTKEYS), ...(s.hotkeys || {}) };
  renderKeys();
  document.getElementById('provider').value = SERVICES.includes(s.provider) ? s.provider : 'openrouter';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('model').value = s.model || 'deepseek/deepseek-v4.1-flash';
  document.getElementById('fallbackModel').value = s.fallbackModel || '';
  document.getElementById('geminiKey').value = s.geminiKey || '';
  document.getElementById('geminiModel').value = s.geminiModel || DEFAULT_GEMINI_MODEL;
  document.getElementById('geminiFallbackModel').value = s.geminiFallbackModel || '';
  document.getElementById('openaiKey').value = s.openaiKey || '';
  document.getElementById('openaiModel').value = s.openaiModel || DEFAULT_OPENAI_MODEL;
  document.getElementById('openaiFallbackModel').value = s.openaiFallbackModel || '';
  document.getElementById('deepseekToken').value = s.deepseekToken || '';
  document.getElementById('deepseekModel').value = s.deepseekModel || 'deepseek-chat';
  document.getElementById('deepseekThinking').checked = s.deepseekThinking === true;
  document.getElementById('deepseekSearch').checked = s.deepseekSearch === true;
  renderGeminiWebModels(s.geminiWebModels || [], s.geminiWebModel || '', s.geminiWebFallbackModel || '');
  document.getElementById('geminiWebModel').value = s.geminiWebModel || '';
  document.getElementById('geminiWebFallbackModel').value = s.geminiWebFallbackModel || '';
  document.getElementById('geminiWebThinking').value = s.geminiWebThinking === true ? 'high' : (s.geminiWebThinking || '');
  document.getElementById('reuseChat').checked = s.reuseChat === true;      // off unless switched on
  document.getElementById('speedCache').checked = s.speedCache !== false;       // the speed ideas are on unless switched off
  document.getElementById('speedParallel').checked = s.speedParallel !== false;
  showProvider();
  document.getElementById('answerDelay').value = s.answerDelay ?? 120;
  document.getElementById('devMode').checked = s.devMode === true;
  renderSpeed();
}

/* ------------------------------------------------------------------------------- speed */

const SPEED_NAMES = { openrouter: 'OpenRouter', gemini: 'Gemini key', openai: 'OpenAI', deepseek: 'DeepSeek', 'gemini-web': 'Gemini login' };

/** The logged answers, averaged per combination of switches that was on when they were made, so
 *  "with" and "without" an idea can be read side by side. A stage a service does not have is null
 *  (shown as a dash) rather than 0, which would claim it was instant. */
function speedSummary(log) {
  const groups = new Map();
  for (const e of Array.isArray(log) ? log : []) {
    const m = e && e.mode;
    if (!m || !Number.isFinite(e.total)) continue;
    const web = m.provider === 'gemini-web';
    const label = [
      SPEED_NAMES[m.provider] || m.provider,
      web ? `session kept ${m.cache ? 'on' : 'off'}, parallel upload ${m.parallel ? 'on' : 'off'}` : '',
      `screenshot ${m.shot}`,
    ].filter(Boolean).join(' · ');
    const g = groups.get(label) || { label, n: 0, all: 0, shot: 0, stages: { setup: [0, 0], upload: [0, 0], ai: [0, 0] } };
    g.n++;
    g.all += e.total + (e.shot || 0);          // the capture happens before the worker is asked, so it is added on
    g.shot += e.shot || 0;
    for (const k of ['setup', 'upload', 'ai']) {
      if (Number.isFinite(e[k])) { g.stages[k][0] += e[k]; g.stages[k][1]++; }
    }
    groups.set(label, g);
  }
  const avg = ([sum, n]) => (n ? sum / n : null);
  return [...groups.values()].map(g => ({
    label: g.label, n: g.n, all: g.all / g.n, shot: g.shot / g.n,
    setup: avg(g.stages.setup), upload: avg(g.stages.upload), ai: avg(g.stages.ai),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

async function renderSpeed() {
  const box = document.getElementById('speedTable');
  box.textContent = '';
  let log = [];
  try { log = (await chrome.storage.local.get('speedLog')).speedLog || []; } catch { /* nothing logged */ }
  const rows = speedSummary(log);
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'Nothing logged yet. Answer a few questions, then press Refresh.';
    box.append(none);
    return;
  }

  const sec = ms => (ms == null ? '–' : (ms / 1000).toFixed(1));
  const table = document.createElement('table');
  table.className = 'speed';
  const head = table.createTHead().insertRow();
  for (const h of ['seconds, averaged', 'n', 'per question', 'shot', 'setup', 'pic', 'ai']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    [r.label, String(r.n), sec(r.all), sec(r.shot), sec(r.setup), sec(r.upload), sec(r.ai)].forEach((text, i) => {
      const td = tr.insertCell();
      td.textContent = text;
      if (i === 2) td.className = 'all';
    });
  }
  box.append(table);
}

document.getElementById('speedRefresh').addEventListener('click', () => { renderSpeed(); });
document.getElementById('speedClear').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ speedLog: [] });
    await renderSpeed();
    status('The speed log is cleared.', 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
});

/** Show the fields of the service that is chosen, and only those. */
function showProvider() {
  const which = document.getElementById('provider').value;
  document.getElementById('openrouterFields').hidden = which !== 'openrouter';
  document.getElementById('geminiFields').hidden = which !== 'gemini';
  document.getElementById('openaiFields').hidden = which !== 'openai';
  document.getElementById('deepseekFields').hidden = which !== 'deepseek';
  document.getElementById('geminiWebFields').hidden = which !== 'gemini-web';
  // Only these two have chats of their own to keep, so the choice is only offered for them.
  document.getElementById('chatFields').hidden = which !== 'deepseek' && which !== 'gemini-web';
  // There is no key to test for the Gemini-site login, so the button says what it actually does
  // there. Its own hint tells the person to press this by name, so the two must agree.
  document.getElementById('test').textContent = which === 'gemini-web' ? 'Test login' : 'Test key';
}
document.getElementById('provider').addEventListener('change', () => { showProvider(); status('Press Save to switch.'); });

function status(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

function read() {
  const num = (id, max) => {
    const el = document.getElementById(id);
    return Math.max(0, Math.min(max, parseInt(el.value, 10) || 0));
  };
  return {
    provider: SERVICES.includes(document.getElementById('provider').value) ? document.getElementById('provider').value : 'openrouter',
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim() || 'deepseek/deepseek-v4.1-flash',
    fallbackModel: document.getElementById('fallbackModel').value.trim(),
    geminiKey: document.getElementById('geminiKey').value.trim(),
    geminiModel: document.getElementById('geminiModel').value.trim() || DEFAULT_GEMINI_MODEL,
    geminiFallbackModel: document.getElementById('geminiFallbackModel').value.trim(),
    openaiKey: document.getElementById('openaiKey').value.trim(),
    openaiModel: document.getElementById('openaiModel').value.trim() || DEFAULT_OPENAI_MODEL,
    openaiFallbackModel: document.getElementById('openaiFallbackModel').value.trim(),
    deepseekToken: document.getElementById('deepseekToken').value.trim(),
    deepseekModel: document.getElementById('deepseekModel').value || 'deepseek-chat',
    deepseekThinking: document.getElementById('deepseekThinking').checked,
    deepseekSearch: document.getElementById('deepseekSearch').checked,
    geminiWebModel: document.getElementById('geminiWebModel').value,
    geminiWebFallbackModel: document.getElementById('geminiWebFallbackModel').value,
    geminiWebThinking: document.getElementById('geminiWebThinking').value,
    reuseChat: document.getElementById('reuseChat').checked,
    speedCache: document.getElementById('speedCache').checked,
    speedParallel: document.getElementById('speedParallel').checked,
    answerDelay: num('answerDelay', 3000),
    devMode: document.getElementById('devMode').checked,
    hotkeys: clone(hotkeys),
  };
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set(read());
  status('Saved.', 'ok');
});

/** Ask Google which models this key may use, and offer exactly those. Best effort: the test
 *  already passed, and the suggestions in the page stay if this cannot be read. Returns how
 *  many were found. */
async function listGeminiModels(key) {
  try {
    const res = await fetch(`${GEMINI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) return 0;
    const j = await res.json();
    const names = (j.models || [])
      .filter(m => /gemini/i.test(m.name || '') && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || '' }));
    if (!names.length) return 0;
    const list = document.getElementById('geminiModels');
    list.textContent = '';
    for (const { id, label } of names) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = label ? `${id} — ${label}` : id;
      list.append(o);
    }
    return names.length;
  } catch { return 0; }
}

async function testGemini() {
  const { geminiKey, geminiModel } = read();
  if (!geminiKey) { status('Paste a Gemini key first.', 'bad'); return; }
  status('Testing…');
  try {
    const model = geminiModel.replace(/^models\//, '');
    const res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { maxOutputTokens: 256 },       // room for a model that thinks first
      }),
    });
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      status(`HTTP ${res.status} — ${d}`, 'bad');
      return;
    }
    const j = await res.json();
    const reply = (j?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim() || '(empty)';
    const n = await listGeminiModels(geminiKey);
    status(`✓ ${model} responded: "${reply}"${n ? ` · ${n} models available to this key are in the list` : ''}`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}

/** Ask OpenAI which chat models this key may use, and offer exactly those (not embeddings, speech,
 *  images or moderation). Best effort, like the Gemini list. Returns how many were found. */
async function listOpenAIModels(key) {
  try {
    const res = await fetch(`${OPENAI_API}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return 0;
    const j = await res.json();
    const ids = [...new Set((j.data || []).map(m => String(m.id)))]
      .filter(id => /^(?:gpt-|o\d|chatgpt-)/.test(id) && !/embed|audio|tts|whisper|image|moderation|realtime|transcribe|search|instruct|codex|dall-e|davinci|babbage/i.test(id))
      .sort();
    if (!ids.length) return 0;
    const list = document.getElementById('openaiModels');
    list.textContent = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      list.append(o);
    }
    return ids.length;
  } catch { return 0; }
}

async function testOpenAI() {
  const { openaiKey, openaiModel } = read();
  if (!openaiKey) { status('Paste an OpenAI key first.', 'bad'); return; }
  status('Testing…');
  try {
    const ask = limit => fetch(`${OPENAI_API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: openaiModel,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        [limit]: 256,                                     // room for a model that thinks first
      }),
    });
    let res = await ask('max_completion_tokens');
    if (res.status === 400) {                             // an older model that names the limit the old way
      const d = (await res.text()).slice(0, 200);
      if (!/max_completion_tokens/.test(d)) { status(`HTTP 400 — ${d}`, 'bad'); return; }
      res = await ask('max_tokens');
    }
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      status(`HTTP ${res.status} — ${d}`, 'bad');
      return;
    }
    const j = await res.json();
    const reply = (j?.choices?.[0]?.message?.content || '').trim() || '(empty)';
    const n = await listOpenAIModels(openaiKey);
    status(`✓ ${openaiModel} responded: "${reply}"${n ? ` · ${n} models available to this key are in the list` : ''}`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}

/* ------------------------------------------------------------- DeepSeek */

/** Read the login token out of the person's own chat.deepseek.com tab. The token sits in that
 *  page's localStorage, which this extension cannot read across origins — so the page itself is
 *  asked for it, in its own context, and only that one value comes back. Nothing else is taken.
 *  Runs only on a click, and only in a tab that is already on that site. */
async function grabDeepseekToken() {
  status('Looking for a signed-in chat.deepseek.com tab…');
  try {
    const [tab] = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
    if (!tab?.id) {
      status('No chat.deepseek.com tab is open. Open the site, sign in, then try again.', 'bad');
      return;
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',                       // the page's own storage lives here, not in the isolated world
      func: () => {
        try {
          const raw = localStorage.getItem('userToken');
          if (!raw) return { error: 'not signed in' };
          // It is normally JSON: {"value":"<token>"...}. A bare string is taken as-is.
          const v = raw.trim().startsWith('{') ? JSON.parse(raw).value : raw;
          return v ? { token: String(v) } : { error: 'empty token' };
        } catch (e) { return { error: String(e) }; }
      },
    });
    if (result?.token) {
      document.getElementById('deepseekToken').value = result.token;
      status(`Got the token from “${tab.title || 'the DeepSeek tab'}”. Press Save to keep it.`, 'ok');
    } else {
      status(`Could not read a token from that tab (${result?.error || 'not found'}). Sign in on chat.deepseek.com first.`, 'bad');
    }
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}
document.getElementById('grabToken').addEventListener('click', grabDeepseekToken);

/** Check the token by doing what the tool does: ask for a challenge and solve it. That proves
 *  the token works and that the proof-of-work is being answered correctly — the two things that
 *  actually go wrong. The solving itself lives in the service worker, so the crypto is in one
 *  place; nothing is sent to the model, so this costs no allowance. */
async function testDeepseek() {
  const { deepseekToken } = read();
  if (!deepseekToken) { status('Get a token first, with the button above.', 'bad'); return; }
  status('Testing the token and the proof-of-work…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'deepseek-test', token: deepseekToken });
    if (!r) { status('The extension\'s service worker did not answer — reload the extension and try again.', 'bad'); return; }
    if (r.ok) status(`✓ ${r.note}`, 'ok');
    else status(r.error || 'the test failed', 'bad');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}

/** The models the site said this account may use, as two drop-downs. The saved list is kept in
 *  storage by the service worker, so the boxes are useful on a later visit without asking the
 *  site again — and if the list is empty the boxes still offer the default, which always works.
 *
 *  `keepMain`/`keepFall` are the values to stay on, and are given by the caller because this
 *  rebuilds both boxes from scratch: reading the current selection instead would only work when
 *  the box already shows it, and on a fresh page load it does not yet. */
function renderGeminiWebModels(models, keepMain = document.getElementById('geminiWebModel').value,
                                        keepFall = document.getElementById('geminiWebFallbackModel').value) {
  const main = document.getElementById('geminiWebModel');
  const fall = document.getElementById('geminiWebFallbackModel');

  main.textContent = '';
  const dflt = document.createElement('option');
  dflt.value = '';
  dflt.textContent = "The account's default model (recommended)";
  main.append(dflt);

  fall.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  fall.append(none);

  for (const m of models) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.description ? `${m.label || m.name} — ${m.description}` : (m.label || m.name);
    main.append(o);
    fall.append(o.cloneNode(true));
  }

  // Keep whatever was chosen, even if this account's list no longer offers it: silently
  // switching the model would change the answers without saying so.
  if (keepMain && ![...main.options].some(o => o.value === keepMain)) {
    const o = document.createElement('option');
    o.value = keepMain;
    o.textContent = `${keepMain} (saved, not offered by this account)`;
    main.append(o);
  }
  main.value = keepMain || '';
  if (keepFall && ![...fall.options].some(o => o.value === keepFall)) {
    const o = document.createElement('option');
    o.value = keepFall;
    o.textContent = `${keepFall} (saved, not offered by this account)`;
    fall.append(o);
  }
  fall.value = keepFall || '';
}

/** Check the Gemini-site provider: a signed-in tab open, and the site still answering with a
 *  model list. Nothing is sent to the model, so it costs none of the account's allowance. */
async function testGeminiWeb() {
  status('Looking for a signed-in gemini.google.com tab…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'gemini-web-test' });
    if (!r) { status('The extension\'s service worker did not answer — reload the extension and try again.', 'bad'); return; }
    if (r.error) { status(r.error, 'bad'); return; }
    const s = await chrome.storage.local.get('geminiWebModels');
    renderGeminiWebModels(s.geminiWebModels || []);
    status(`✓ ${r.note}`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
}

/** Forget the saved chats, so the next question starts a new one on each site. This acts at once
 *  and does not wait for Save: it is an action, not a setting. */
document.getElementById('newChat').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ geminiWebChat: null, deepseekChat: null });
    status('The next question will start a new chat.', 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
});

document.getElementById('openGemini').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://gemini.google.com/app' });
});

document.getElementById('test').addEventListener('click', async () => {
  const which = document.getElementById('provider').value;
  if (which === 'gemini') { await testGemini(); return; }
  if (which === 'openai') { await testOpenAI(); return; }
  if (which === 'deepseek') { await testDeepseek(); return; }
  if (which === 'gemini-web') { await testGeminiWeb(); return; }
  const { apiKey, model } = read();
  if (!apiKey) { status('Paste a key first.', 'bad'); return; }
  status('Testing…');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
      }),
    });
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      status(`HTTP ${res.status} — ${d}`, 'bad');
      return;
    }
    const j = await res.json();
    const reply = j?.choices?.[0]?.message?.content?.trim() || '(empty)';
    status(`✓ ${model} responded: "${reply}"`, 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
});

/* --------------------------------------------------------------- developer */

// Both of these read what the service worker and the page scripts have already left in storage, so
// they are useful from here even when the tab that went wrong is long gone.
document.getElementById('saveLog').addEventListener('click', async () => {
  const text = await window.ATSDebug.fullLog();
  if (window.ATSDebug.saveFile(text)) status('Saved the log as a file.', 'ok');
  else status('Could not save the file.', 'bad');
});

document.getElementById('clearLog').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ debugLog: [], lastReport: '', lastReportAt: 0 });
    status('The log and the last report are cleared.', 'ok');
  } catch (e) {
    status(`✗ ${e.message || e}`, 'bad');
  }
});

renderKeys();
load();
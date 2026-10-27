const KEYS = ['autoSubmit', 'screenshot', 'apiKey', 'provider', 'geminiKey', 'openaiKey', 'deepseekToken', 'geminiWebModel', 'hotkeys', 'devMode'];

// Developer mode (set in Options) shows the report buttons. The report is saved either way, so a
// bug that has already happened can be described once the switch is turned on.
let dev = false;
window.ATSDebug?.scope?.('popup');

// The shortcuts as they were before they could be changed; Options and the page script
// keep the same table. `null` is "no shortcut".
const DEFAULT_HOTKEYS = {
  solve: { code: 'KeyS', key: 's', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+S' },
  stop:  { code: 'KeyX', key: 'x', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl+Shift+X' },
};
let hotkeys = DEFAULT_HOTKEYS;
let runLabel = 'Solve the open attempt';
const keyLabel = action => ((action in hotkeys ? hotkeys[action] : DEFAULT_HOTKEYS[action]) || {}).label || '';
const withKey = (text, action) => (keyLabel(action) ? `${text} (${keyLabel(action)})` : text);

// The page script reports the same number, so a tab left on an older copy after
// the extension was reloaded can be told apart from a page with no question on it.
const BUILD = chrome.runtime.getManifest().version;
const say = text => { document.getElementById('last').textContent = text; };

async function load() {
  const s = await chrome.storage.local.get(KEYS);
  document.getElementById('autoSubmit').checked = s.autoSubmit === true;      // off until switched on
  // The report buttons are a developer tool, not part of the ordinary screen.
  dev = s.devMode === true;
  document.getElementById('devbox').hidden = !dev;
  document.getElementById('screenshot').value = s.screenshot || 'auto';
  // The warning is about the credential of the service that is chosen: a Gemini key does nothing for OpenRouter.
  const cred = s.provider === 'gemini' ? s.geminiKey
             : s.provider === 'openai' ? s.openaiKey
             : s.provider === 'deepseek' ? s.deepseekToken
             : s.provider === 'gemini-web' ? true      // its credential is an open tab, checked below
             : s.apiKey;
  document.getElementById('warn').classList.toggle('on', !cred);
  document.getElementById('warn').textContent = s.provider === 'deepseek'
    ? 'No DeepSeek token set. Open Options and copy one from the site.'
    : 'No API key set. Open Options and paste your key.';
  document.getElementById('ver').textContent = ` · v${BUILD}`;

  // The Gemini-site service has nothing to paste, so what can go wrong is simply that no
  // signed-in tab is open — which is worth saying before a question is asked, not after.
  if (s.provider === 'gemini-web') {
    let tuned = false;
    try {
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      for (const tab of tabs) {
        if (tab.id == null) continue;
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'gw-ping' });
          if (r?.ok) { tuned = true; break; }
        } catch { /* that tab is old or still loading */ }
      }
    } catch { /* no permission to look: say nothing rather than something wrong */ }
    document.getElementById('warn').classList.toggle('on', !tuned);
    document.getElementById('warn').textContent = 'No signed-in gemini.google.com tab is open. Open one and leave it open.';
  }

  hotkeys = { ...DEFAULT_HOTKEYS, ...(s.hotkeys || {}) };
  document.getElementById('hk').textContent = keyLabel('solve') ? `· ${keyLabel('solve')}` : '';
  runLabel = withKey('Solve the open attempt', 'solve');
  document.getElementById('run').textContent = runLabel;
}

for (const [id, key, prop] of [
  ['autoSubmit', 'autoSubmit', 'checked'],
  ['screenshot', 'screenshot', 'value'],
]) {
  document.getElementById(id).addEventListener('change', e => {
    chrome.storage.local.set({ [key]: e.target[prop] });
  });
}

/** Send a command to the active tab and say how it went. `reachable: false` means
 *  nothing there answered, which is what a tab that was open when the extension
 *  was reloaded looks like (its old script is cut off from the new one). */
async function toTab(type, opt, timeout = 5000) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { reachable: false, tab: null, why: 'no active tab' };
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ reachable: false, tab, why: 'the page script did not answer' }), timeout);
    chrome.tabs.sendMessage(tab.id, { type, ...opt }, res => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      resolve(err ? { reachable: false, tab, why: err.message } : { reachable: true, tab, res });
    });
  });
}

const isAts = tab => /^https:\/\/ats\.blackboard\.com\//.test(tab?.url || '');

const unreachable = r => (isAts(r.tab)
  ? `⚠ This tab isn't running the extension (v${BUILD}) yet — press F5 on it, then try again.`
  : "This isn't an ATS tab — open ats.blackboard.com first.");

const olderCopy = p => `⚠ This tab runs an older copy (v${p.build ?? '?'}; the popup is v${BUILD}) — press F5 on it.`;

function notHandled(r) {
  if (!r.reachable) return unreachable(r);
  const p = r.res || {};
  if (p.build !== BUILD) return olderCopy(p);
  // With developer mode on, say where the report went: that is the whole point of the switch.
  const saved = p.report && dev ? ' A report was saved — press Copy the last report.' : '';
  return p.why ? `No question found (${p.why}) — open the assessment and press Start first.${saved}` : `No question found in this tab — open the assessment and press Start first.${saved}`;
}

document.getElementById('run').addEventListener('click', async () => {
  say('working…');
  const r = await toTab('do-solve');
  if (r.reachable && r.res?.handled && r.res.build === BUILD) { say('solving…'); window.close(); return; }
  say(notHandled(r));
});

for (const [id, type] of [['runOne', 'do-run-assessment'], ['runCourse', 'do-run-course'], ['runAll', 'do-run-all']]) {
  document.getElementById(id).addEventListener('click', async () => {
    say('starting…');
    const r = await toTab(type);
    if (r.reachable && r.res?.handled && r.res.build === BUILD) { say('running — this tab does the work, leave it open'); window.close(); return; }
    say(notHandled(r));
  });
}

document.getElementById('stop').addEventListener('click', async () => {
  // The page may be mid-reload and not hear the message; the page also watches this key.
  try {
    const { atsRun } = await chrome.storage.local.get('atsRun');
    if (atsRun?.active) await chrome.storage.local.set({ atsRun: { ...atsRun, active: false } });
  } catch { /* the message below still tries */ }
  await toTab('do-stop');
  say('stopping…');
});

document.getElementById('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

/** Show only the buttons that make sense for where the tab is: an open attempt, an assessment's
 *  overview, a course, or anywhere else in Blackboard. */
const SCREENS = {
  attempt:   { text: 'An attempt is open.',                             show: ['run'] },
  overview:  { text: "You're on an assessment's overview.",             show: ['runOne', 'runCourse', 'runAll'] },
  course:    { text: "You're in a course.",                             show: ['runCourse', 'runAll'] },
  dashboard: { text: "You're in Blackboard.",                           show: ['runAll'] },
  other:     { text: 'Open Blackboard Ultra on ats.blackboard.com.',    show: [] },
};

async function adapt() {
  const r = await toTab('do-where', undefined, 2500);
  const screen = SCREENS[r.res?.where];
  if (!screen) return;
  for (const id of ['run', 'runOne', 'runCourse', 'runAll']) {
    const el = document.getElementById(id);
    el.hidden = !screen.show.includes(id);
    el.classList.toggle('ghost', screen.show.length > 1 && id !== screen.show[0]);
    if (screen.labels?.[id]) el.textContent = screen.labels[id];
  }
  document.getElementById('where').textContent = screen.text;
}

/** On opening: is this tab running this version, and what does it see on screen? */
async function ping() {
  const r = await toTab('do-ping', undefined, 2500);
  if (!r.reachable) { say(unreachable(r)); return; }
  const p = r.res || {};
  if (p.build !== BUILD) { say(olderCopy(p)); return; }
  const st = (await toTab('do-status', undefined, 2500)).res?.run;
  if (st?.active) { say(`a run is active — ${st.solved} solved, ${st.skipped.length} skipped so far`); return; }
  if (st?.finished && Date.now() - st.finished < 3600e3) { say(`last run: ${st.solved} solved, ${st.skipped.length} skipped${st.note ? ` (${st.note})` : ''}`); return; }
  say(p.kind ? `page script v${p.build} · sees: ${p.summary}` : `page script v${p.build} · no question detected${p.why ? ` (${p.why})` : ''}`);
}

load().then(adapt);
ping();

/* ---------------------------------------------------------- developer mode */

const ago = ms => (ms < 90e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`);

// The dump has to run in the page, because it describes what the page script can see. Everything
// else here reads what has already been left in storage, so it works from any tab — including one
// that is not Blackboard at all, which is where a person lands after a run has gone wrong.
document.getElementById('dump').addEventListener('click', async () => {
  say('dumping…');
  const r = await toTab('do-dump');
  if (r.reachable && r.res?.ok) { say('Dumped — now press Copy the last report.'); return; }
  if (r.reachable && r.res?.devOff) { say(r.res.error || 'Developer mode is off — turn it on in Options.'); return; }
  say(notHandled(r));
});

document.getElementById('copyReport').addEventListener('click', async () => {
  const { text, at } = await window.ATSDebug.lastReport();
  if (!text) { say('No report saved yet — press Dump this page, or let a run stop once.'); return; }
  if (!(await window.ATSDebug.copy(text))) { say('The browser refused the clipboard — press Save the log as a file.'); return; }
  const age = Date.now() - (at || 0);
  say(`Copied the report from ${new Date(at).toLocaleTimeString()} (${ago(age)})` +
      (age > 10 * 60e3 ? ' — that one is old: press Dump this page for a fresh one' : ' — paste it into the bug report'));
});

document.getElementById('saveLog').addEventListener('click', async () => {
  const text = await window.ATSDebug.fullLog();
  say(window.ATSDebug.saveFile(text) ? 'Saved the log as a file — attach it to the bug report.' : 'Could not save the file.');
});

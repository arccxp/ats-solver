/* ATS Solver — keeping what happened, so a bug can be described.
 *
 * One file, loaded wherever a report can be wanted: the page scripts (`ats.js` on
 * Blackboard, `gemini-web.js` on the Gemini site), the popup and Options. It does three
 * things and nothing else.
 *
 *   1. `log()` — one line into a rolling log. The log lives in extension storage and is
 *      written by the service worker, which is the only context that always runs; a page
 *      posts its lines to it. Bounded at both ends: a fixed number of entries, and a
 *      fixed length per entry.
 *   2. `register()` — the page script hands over a function that describes the page. That
 *      description is the part nobody else can reconstruct: what was read, and, when
 *      nothing was read, the shape of what was on the page instead. Blackboard's markup is
 *      the thing that changes, so a report without it says nothing useful.
 *   3. `report()` — a header, that description, and the tail of the log, as copy-pasteable
 *      text. It is kept in storage as well, because by the time the popup says "no question
 *      found" the page may be gone, and a clipboard write needs a click by a person.
 *
 * Every report is scrubbed on the way out: nothing shaped like a key or a token survives.
 * Nothing here throws, either — a logger that fails a run is worse than no logger.
 */
(() => {
  'use strict';
  if (window.ATSDebug) return;

  const LOG_KEY = 'debugLog';
  const REPORT_KEY = 'lastReport';
  const REPORT_AT_KEY = 'lastReportAt';

  let tag = 'page';            // which script a line came from: page, gemini, popup, options
  let dumpFn = null;           // registered by the page script: function -> string | Promise<string>

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const clock = t => {
    const d = new Date(t || 0);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };

  /* ------------------------------------------------------------------ scrubbing */

  /** Anything that looks like a credential, out. The extension never puts a key in a log
   *  line itself; this is the belt for the braces — an error string from a service or a
   *  URL from a stack trace is not under its control. */
  function scrub(value) {
    let s = String(value == null ? '' : value);
    s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza<redacted>');
    s = s.replace(/\bsk-[0-9A-Za-z_-]{12,}/g, 'sk-<redacted>');
    s = s.replace(/\b(Bearer)\s+[0-9A-Za-z._~+/=-]{8,}/gi, '$1 <redacted>');
    s = s.replace(/\b((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)("?)[^\s",}]{4,}\2/gi, '$1$2<redacted>$2');
    s = s.replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1<redacted>');
    return s;
  }

  /** JSON with the things that cannot be serialised turned into a note. A DOM node in a
   *  detail object is normal here; a crash while describing a crash is not. */
  function stringify(value) {
    const seen = new Set();
    try {
      return JSON.stringify(value, (_k, v) => {
        if (typeof Element === 'function' && v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
        if (typeof v === 'function') return '[function]';
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }, 1);
    } catch (e) {
      return `(detail could not be written: ${e.message || e})`;
    }
  }

  /* ------------------------------------------------------------------ writing */

  /** One line into the rolling log. `data` is anything small: an outcome, a count, an error. */
  function log(level, message, data) {
    const entry = { t: Date.now(), s: tag, l: level || 'info', m: String(message == null ? '' : message).slice(0, 500) };
    if (data !== undefined && data !== null) {
      const d = typeof data === 'string' ? data : stringify(data);
      if (d) entry.d = String(d).slice(0, 600);
    }
    try {
      // The worker owns the log; a page that outlived an extension reload has no worker to
      // post to, and that is not worth a word to anyone.
      chrome.runtime?.sendMessage?.({ type: 'dbg', entry })?.catch?.(() => {});
    } catch { /* no messaging: the console line below is all that is left */ }
    try {
      // A log line is not an error, even when it is about one: reporting it as one would make
      // every failed question look like a broken page in the console.
      console.log(`[ats-solver:${entry.s}] ${entry.l}: ${entry.m}`, data === undefined ? '' : data);
    } catch { /* a dead console */ }
    return entry;
  }

  /* ------------------------------------------------------------------ reading */

  async function readLog() {
    try {
      const v = (await chrome.storage.local.get(LOG_KEY))?.[LOG_KEY];
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  const asLine = e => `${clock(e?.t)} ${String(e?.s || '?').padEnd(7)} ${String(e?.l || 'info').padEnd(5)} ${scrub(e?.m)}${e?.d ? `  ${scrub(e.d)}` : ''}`;

  /** The tail of the log as text. Oldest first, so a report reads the way it happened. */
  async function logText(count = 400) {
    const all = await readLog();
    return all.slice(-count).map(asLine).join('\n') || '(nothing logged yet)';
  }

  /* ------------------------------------------------------------------ the page */

  /** The page script's description of the page. Called fresh every time: a description
   *  kept from earlier would describe a page that no longer exists. */
  function register(fn) {
    if (typeof fn === 'function') dumpFn = fn;
  }

  async function pageDescription() {
    if (!dumpFn) return '(this context has no page script — nothing to describe)';
    try {
      const text = await dumpFn();
      return scrub(text || '(the page script described nothing)');
    } catch (e) {
      return `(the page description threw: ${e && (e.message || e)})`;
    }
  }

  /* ------------------------------------------------------------------ the report */

  const build = () => {
    try { return chrome.runtime.getManifest().version; } catch { return '?'; }
  };

  /** Everything known about a failure, as one block of text. Kept in storage under
   *  `lastReport` so the popup can copy it long after the page has moved on. */
  async function report(stage, message, detail) {
    const when = new Date();
    const parts = [];
    parts.push('=== ATS Solver report ===');
    parts.push(`build:   ${build()}`);
    parts.push(`when:    ${when.toISOString()}`);
    parts.push(`stage:   ${stage || 'unknown'}`);
    parts.push(`message: ${scrub(message || '')}`);
    try { parts.push(`url:     ${scrub(location.href)}`); } catch { /* a context with no location */ }
    try { parts.push(`browser: ${navigator.userAgent}`); } catch { /* as above */ }

    if (detail !== undefined && detail !== null) {
      const said = typeof detail === 'string' ? detail : stringify(detail);
      parts.push('');
      parts.push('--- detail ---');
      parts.push(scrub(said).slice(0, 4000));
    }

    parts.push('');
    parts.push('--- page ---');
    parts.push(await pageDescription());
    parts.push('');
    parts.push('--- log (oldest first) ---');
    parts.push(await logText(250));
    parts.push('=== end ===');

    const text = scrub(parts.join('\n'));
    try { await chrome.storage.local.set({ [REPORT_KEY]: text, [REPORT_AT_KEY]: Date.now() }); } catch { /* storage may be gone; the caller still gets the text */ }
    return text;
  }

  /** The saved report and when it was made, for the popup's Copy button. */
  async function lastReport() {
    try {
      const s = await chrome.storage.local.get([REPORT_KEY, REPORT_AT_KEY]);
      return { text: s?.[REPORT_KEY] || '', at: s?.[REPORT_AT_KEY] || 0 };
    } catch { return { text: '', at: 0 }; }
  }

  /** The whole log on its own, for a file worth keeping. */
  async function fullLog() {
    const head = [
      '=== ATS Solver log ===',
      `build:   ${build()}`,
      `when:    ${new Date().toISOString()}`,
      '',
    ];
    return scrub(head.concat([await logText(400), '=== end ===']).join('\n'));
  }

  /* ------------------------------------------------------------------ getting it out */

  const FILE_STAMP = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

  /** A download, from a page that a person is looking at. No permission is needed for this:
   *  a blob URL handed to an anchor is an ordinary download, not the downloads API. */
  function saveFile(text, name) {
    try {
      const blob = new Blob([String(text == null ? '' : text)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || `ats-solver-log-${FILE_STAMP()}.txt`;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 20000);
      return true;
    } catch (e) {
      log('error', 'could not save the file', String(e && (e.message || e)));
      return false;
    }
  }

  /** The clipboard, on a real click. Refused by the browser when no gesture is behind it,
   *  which is why a background run saves the report instead of copying it. */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(String(text == null ? '' : text));
      return true;
    } catch (e) {
      log('warn', 'clipboard refused', String(e && (e.message || e)));
      return false;
    }
  }

  /* ------------------------------------------------------------------ crashes */

  // A page that throws while solving leaves nothing behind otherwise, and "it did nothing"
  // is the least useful bug report there is.
  window.addEventListener('error', e => {
    log('error', `uncaught: ${e.message}`, { at: `${e.filename}:${e.lineno}:${e.colno}`, stack: String((e.error && e.error.stack) || '').slice(0, 800) });
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    log('error', 'unhandled rejection', String((r && (r.stack || r.message)) || r).slice(0, 800));
  });

  window.ATSDebug = {
    log,
    info: (m, d) => log('info', m, d),
    warn: (m, d) => log('warn', m, d),
    error: (m, d) => log('error', m, d),
    scope: name => { if (name) tag = String(name); return tag; },
    register,
    report,
    lastReport,
    readLog,
    logText,
    fullLog,
    saveFile,
    copy,
    scrub,
    stringify,
    build,
  };
})();

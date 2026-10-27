/* ATS Solver — content script for ats.blackboard.com (Blackboard Ultra).
 *
 * Answers multiple choice, true/false, select-all and short text/blank questions. Essays, matching,
 * ordering and anything it does not recognise are left alone and the run stops before Submit, so
 * nothing is ever handed in half done. Assessments behind Respondus LockDown Browser or proctoring
 * are never opened. */
(() => {
  'use strict';
  if (window.__atsSolver) return;
  window.__atsSolver = true;

  const BUILD = chrome.runtime.getManifest().version;
  const IS_TOP = window === window.top;
  const CFG = { autoSubmit: false, answerDelay: 40, screenshot: 'auto', hotkeys: null, concurrency: 2, verify: true, reuseChat: false, devMode: false, rateWait: 10000 };

  // Logging is optional on purpose: this file is also injected on its own by the offline tests,
  // where debug.js is not loaded, and a run must not depend on a debugger being attached.
  const D = window.ATSDebug || null;
  const dbg = (level, message, data) => { try { D?.log(level, message, data); } catch { /* a logger must not fail a run */ } };

  const DEFAULT_HOTKEYS = {
    solve: { code: 'KeyS', ctrl: true, shift: true, alt: false, meta: false },
    stop: { code: 'KeyX', ctrl: true, shift: true, alt: false, meta: false },
  };

  let busy = false;      // a question set is being answered
  let running = false;   // an auto run is stepping through assessments
  let stopRun = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const LETTERS = 'ABCDEFGHIJ';

  /* ------------------------------------------------------------------ hud */

  let hudEl = null;
  function hud(text, bad) {
    if (!IS_TOP) return;
    // Everything the page decides to tell the person is also the run's transcript: it is the
    // fastest way to see where a run stopped, and it costs one line.
    dbg(bad ? 'warn' : 'info', `hud: ${text}`);
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'ats-solver-hud';
      document.documentElement.appendChild(hudEl);
    }
    hudEl.textContent = text;
    hudEl.classList.add('on');
    clearTimeout(hud.t);
    hud.t = setTimeout(() => hudEl.classList.remove('on'), bad ? 9000 : 5000);
  }

  /* ---------------------------------------------------------------- pages */

  // Ultra is a single-page app whose routes carry the ids: /ultra/courses/{courseId}/assessment/{contentId}/{overview|attempt/{id}}.
  const ROUTE = /^\/ultra\/courses\/(_\d+_\d+)\/assessment\/(_\d+_\d+)\/(overview|attempt)/;
  const route = () => { const m = location.pathname.match(ROUTE); return m ? { courseId: m[1], contentId: m[2], page: m[3] } : null; };
  const courseIdHere = () => (location.pathname.match(/^\/ultra\/courses\/(_\d+_\d+)\//) || [])[1] || '';
  const overviewUrl = (courseId, contentId) => `${location.origin}/ultra/courses/${courseId}/assessment/${contentId}/overview?courseId=${courseId}`;

  /** The site sets a <base> to its asset host, so a relative URL goes to the wrong server. Always use the origin. */
  async function api(path) {
    const r = await fetch(location.origin + path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  }

  /* --------------------------------------------------------------- scrape */

  /** Text with paragraph breaks kept, minus anything only a screen reader is meant to hear. */
  function blockText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('style,script,button,.sr-only,.ql-clipboard,[class*="hideOffScreen"]').forEach(n => n.remove());
    c.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,tr,br,div.ql-editor > *').forEach(n => n.after('\n'));
    return c.textContent.split('\n').map(clean).filter(Boolean).join('\n');
  }

  /** An image the model can be given as data. A URL would be fetched by the provider, which has no login. */
  async function toDataUrl(img) {
    try {
      const src = img.currentSrc || img.src;
      if (!src) return null;
      if (src.startsWith('data:')) return src;
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      if (blob.size > 6e6) return null;
      return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
    } catch { return null; }
  }

  const TEXT_INPUTS = 'input[type="text"], input[type="number"], input:not([type]), textarea';

  /** What a question asks for. Anything not listed (essay, matching, ordering, ...) is 'other' and never answered. */
  function kindOf(box) {
    // A grid or several choice groups in one question is not one pick.
    if (box.querySelectorAll('[role="radiogroup"], [role="group"]').length > 1) return 'other';
    if (box.querySelector('input[type="checkbox"]')) return 'multi';
    if (box.querySelectorAll('input[type="radio"]').length >= 2) return 'mcq';
    // A rich-text editor is an essay; a plain text box is a short answer or a blank.
    if (box.querySelector('[contenteditable="true"]:not(.ql-clipboard)')) return 'other';
    const boxes = [...box.querySelectorAll(TEXT_INPUTS)].filter(i => !i.closest('.ql-container'));
    if (boxes.length === 1) return 'short';
    if (boxes.length > 1) return 'fill';
    return 'other';
  }

  /** The question's own words. Ultra labels the choice group with its stem. */
  function stemOf(box, group) {
    const labelled = group?.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby'));
    const raw = labelled ? blockText(labelled) : (() => {
      const c = box.cloneNode(true);
      c.querySelectorAll('input,textarea,label,[role="radiogroup"],[role="group"],ul').forEach(n => n.remove());
      return blockText(c);
    })();
    return raw.replace(/^question\s+\d+\s*/i, '').replace(/^\d+(\.\d+)?\s+points?\s*/i, '').trim();
  }

  /** Every question on the open attempt. A "presentation" block is a reading text; it belongs to the questions after it. */
  function scrape() {
    const list = document.querySelector('ol.attempt-question-list');
    if (!list) return { items: [], submit: null };
    const items = [];
    let passage = '', passageEls = [], afterPassage = false;

    for (const li of list.children) {
      const box = li.querySelector('.assessment-question');
      if (!box) continue;
      const type = (box.className.match(/js-question-type-(\w+)/) || [])[1] || '';

      if (type === 'presentation') {
        const text = blockText(li).replace(/^question\s*\S*\s*/i, '').trim();
        // Consecutive text blocks are one passage; a text block after questions starts a new one.
        passage = afterPassage && passage ? `${passage}\n\n${text}` : text;
        passageEls = afterPassage ? [...passageEls, ...li.querySelectorAll('img')] : [...li.querySelectorAll('img')];
        afterPassage = true;
        continue;
      }
      afterPassage = false;

      const kind = kindOf(box);
      const group = box.querySelector('[role="radiogroup"], [role="group"]');
      const pickers = [...box.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
      const options = ['mcq', 'multi'].includes(kind) ? pickers.map(input => {
        const label = input.closest('label');
        const body = label?.querySelector('.ql-editor') || label;
        return { input, label, text: body ? blockText(body) : '', imgs: body ? [...body.querySelectorAll('img')] : [] };
      }) : [];

      const stem = stemOf(box, group);
      const item = { li, box, kind, type, options, stem, passage, imgs: [...li.querySelectorAll('img')].filter(i => !options.some(o => o.imgs.includes(i))), passageImgs: passageEls, images: [], answered: false };
      if (kind === 'mcq' || kind === 'multi') item.answered = pickers.some(r => r.checked);
      else if (kind === 'short' || kind === 'fill') {
        item.inputs = [...box.querySelectorAll(TEXT_INPUTS)].filter(i => !i.closest('.ql-container'));
        item.answered = item.inputs.every(i => clean(i.value));
        if (kind === 'fill') item.stem = `${stem}\n(${item.inputs.length} blanks)`;
      }
      items.push(item);
    }
    const submit = [...document.querySelectorAll('button')].filter(visible).find(b => /^submit( late)?$/i.test(clean(b.innerText)));
    return { items, submit };
  }

  /** The pictures a question needs, as data. Done once per question, before it is asked. */
  async function loadImages(q) {
    const els = [...q.imgs, ...q.passageImgs, ...q.options.flatMap(o => o.imgs)].slice(0, 6);
    q.images = (await Promise.all(els.map(toDataUrl))).filter(Boolean);
    // A picture that would not download still counts, so the model is told it is missing.
    q.imageTotal = els.length;
  }

  /* ------------------------------------------------------------------ ask */

  async function screenshotOf(el) {
    el.scrollIntoView({ block: 'center' });
    await sleep(250);
    const s = await chrome.runtime.sendMessage({ type: 'capture' }).catch(() => null);
    return s?.dataUrl || null;
  }

  /** A screenshot is needed when the text alone does not carry the question. */
  const needsPicture = q => q.images.length > 0 || (q.imageTotal || 0) > 0 || q.stem.length < 8 || q.options.some(o => !o.text) ||
    (!q.passage && /\b(passage|paragraph|text|poem|story|article|diagram|figure|graph|table|picture|image)\b.{0,40}\b(above|below|following|shown)\b|\b(above|below|following)\b.{0,20}\b(passage|paragraph|text|poem|story|article)\b/i.test(q.stem));

  /** Send an ask to the worker. A worker that has not woken yet, or a model that failed for the moment, is waited for
   *  instead of ending the run with an attempt left open. */
  async function askWorker(msg) {
    const WAKE = /receiving end does not exist|message port closed/i, LIMIT = /rate.?limit|too many requests|\b429\b/i;
    // The chat sites answer an overloaded moment with a sentence instead of an answer.
    const GLITCH = /something went wrong|try (your request )?again|overloaded|temporarily unavailable|service unavailable/i;
    const wakeWaits = [1000, 2000, 4000];
    let woke = 0, limited = 0, glitched = 0;
    for (;;) {
      if (stopRun) return { error: 'stopped' };
      const ans = await chrome.runtime.sendMessage(msg).catch(e => ({ error: String(e?.message || e) }));
      const err = ans && ans.error ? String(ans.error) : '';
      if (/context invalidated/i.test(err)) return { error: 'the extension was reloaded — refresh this page' };
      if (WAKE.test(err) && woke < wakeWaits.length) { await until(() => stopRun, wakeWaits[woke++], 250); continue; }
      // The reason is shown as the model gave it; a retry is a guess that the failure was momentary, not a diagnosis.
      const retry = (waits, n) => {
        const wait = waits * n, why = err.replace(/\s+/g, ' ').slice(0, 90);
        hud(`the model did not answer (${why}) — asking again in ${Math.round(wait / 1000)}s (${n}/3)…`);
        return until(() => stopRun, wait, 250);
      };
      if (GLITCH.test(err) && glitched < 3) { await retry(Math.round(CFG.rateWait / 4), ++glitched); continue; }
      if (LIMIT.test(err) && limited < 3) { await retry(CFG.rateWait, ++limited); continue; }
      return ans;
    }
  }

  /** One opinion from the model. `order` is the order the choices are shown in; the answer comes back mapped to the page's. */
  async function opinion(q, image, order, first = false) {
    if (stopRun) return { error: 'stopped' };
    const ans = await askWorker({
      type: 'ask',
      payload: {
        kind: 'mcq',
        // A shared chat is only used for the first opinion; a second opinion in it would just echo the first.
        fresh: !(CFG.reuseChat && first),
        stem: q.stem,
        passage: q.passage,
        options: order.map(i => ({ text: q.options[i].text })),
        multi: false,
        instruction: '',
        tried: [],
        cloze: null, dropdown: null, match: null, drag: null, sort: null,
        images: q.images,
        imageCount: q.imageTotal || q.images.length,
        image,
      },
    });
    if (!ans || ans.error) return { error: ans?.error || 'no response' };
    const shown = ans.index;
    if (shown == null || shown < 0 || shown >= order.length) return { error: `answer out of range (${ans.letter})` };
    return { idx: order[shown], confidence: typeof ans.confidence === 'number' ? ans.confidence : null, why: ans.why };
  }

  /** The model's answer. A confident answer to a plain question is taken as it is. A doubtful one, or one about a
   *  passage, is asked again with the choices shown in a different order, so a pull towards a position or a
   *  wording does not decide it; two agreeing opinions settle it, and a third breaks a tie. */
  async function answer(q, shot) {
    const image = shot === undefined
      ? (CFG.screenshot !== 'never' && needsPicture(q) ? await screenshotOf(q.li) : null)
      : shot;
    const n = q.options.length;
    const straight = [...Array(n).keys()];
    const first = await opinion(q, image, straight, true);
    if (first.error) return { ok: false, error: first.error };
    const sure = first.confidence != null && first.confidence >= 0.9 && !q.passage;
    if (!CFG.verify || sure) return { ok: true, idx: first.idx, letter: LETTERS[first.idx], confidence: first.confidence, why: first.why };

    const reversed = [...straight].reverse();
    const second = await opinion(q, image, reversed);
    const votes = [first, second].filter(v => !v.error);
    if (votes.length === 2 && votes[0].idx !== votes[1].idx) {
      const turned = straight.map((_, i) => (i + Math.ceil(n / 2)) % n);
      const third = await opinion(q, image, turned);
      if (!third.error) votes.push(third);
    }
    const tally = new Map();
    for (const v of votes) tally.set(v.idx, (tally.get(v.idx) || 0) + 1 + (v.confidence || 0) / 10);
    const [idx] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const agreeing = votes.filter(v => v.idx === idx);
    dbg('info', 'votes', votes.map(v => LETTERS[v.idx]).join(''));
    return { ok: true, idx, letter: LETTERS[idx], confidence: agreeing.length / votes.length, why: agreeing[0]?.why };
  }

  /** One opinion for a question that is not plain single-answer multiple choice. */
  async function askOther(q, shot) {
    if (stopRun) return { ok: false, error: 'stopped' };
    const image = shot === undefined
      ? (CFG.screenshot !== 'never' && needsPicture(q) ? await screenshotOf(q.li) : null)
      : shot;
    const extra = {
      multi: { kind: 'mcq', multi: true, options: q.options.map(o => ({ text: o.text })) },
      fill: { kind: 'cloze', cloze: { text: q.stem, blanks: (q.inputs || []).map(() => ({})), wordBank: [] } },
      short: { kind: 'cloze', cloze: { text: `${q.stem} [blank 1]`, blanks: [{}], wordBank: [] } },
    }[q.kind];
    const ans = await askWorker({
      type: 'ask',
      payload: {
        fresh: !CFG.reuseChat, stem: q.stem, passage: q.passage, options: [], multi: false, instruction: '', tried: [],
        cloze: null, dropdown: null, match: null, drag: null, sort: null,
        images: q.images, imageCount: q.imageTotal || q.images.length, image, ...extra,
      },
    });
    if (!ans || ans.error) return { ok: false, error: ans?.error || 'no response' };
    if (q.kind === 'multi') return ans.indices?.length ? { ok: true, indices: ans.indices, why: ans.why } : { ok: false, error: 'no choice picked' };
    if (ans.mismatch) return { ok: false, error: ans.mismatch };
    const blanks = q.kind === 'short' ? 1 : (q.inputs || []).length;
    if (!ans.words?.length) return { ok: false, error: 'no answer text' };
    if (ans.words.length !== blanks) return { ok: false, error: `expected ${blanks} answer(s), got ${ans.words.length}` };
    return { ok: true, words: ans.words, why: ans.why };
  }

  /* --------------------------------------------------------------- commit */

  /** The choices are React-controlled, so the change has to come from a real click on the label. */
  async function pick(opt, want = true) {
    if (opt.input.checked === want) return true;
    const target = opt.label || opt.input;
    target.scrollIntoView({ block: 'center' });
    await sleep(CFG.answerDelay);
    target.click();
    // React may repaint late; a second click too early would undo the first.
    if (!(await until(() => opt.input.checked === want, 600, 50)) && opt.input.type === 'radio') opt.input.click();
    await sleep(80);
    return opt.input.checked === want;
  }

  /** Text boxes are controlled too: set the value through the native setter, then tell React about it. */
  async function typeInto(input, text) {
    input.scrollIntoView({ block: 'center' });
    await sleep(CFG.answerDelay);
    input.focus();
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    await sleep(80);
    return input.value === text;
  }

  /** Write the model's answer into the page. Returns whether the page shows it. */
  async function apply(q, r) {
    if (q.kind === 'mcq') return pick(q.options[r.idx]);
    if (q.kind === 'multi') {
      for (const [i, o] of q.options.entries()) if (!(await pick(o, r.indices.includes(i)))) return false;
      return true;
    }
    if (q.kind === 'short') return typeInto(q.inputs[0], r.words[0]);
    if (q.kind === 'fill') {
      for (const [i, input] of q.inputs.entries()) if (!(await typeInto(input, r.words[i]))) return false;
      return true;
    }
    return false;
  }

  const SOLVABLE = new Set(['mcq', 'multi', 'short', 'fill']);
  const solve1 = (q, shot) => (q.kind === 'mcq' ? answer(q, shot) : askOther(q, shot));
  const label1 = r => r.letter || (r.indices ? r.indices.map(i => LETTERS[i]).join('') : r.words ? r.words.join(' | ') : '');

  /** Submit opens a confirmation dialog; press the affirmative button in it. */
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .MuiDialog-root, .bb-modal')].filter(visible);
  const AFFIRM = /^(start|begin|continue|submit|yes|confirm|ok|got it)\b/i;
  const NEGATE = /cancel|\bno\b|close|back|exit/i;
  const affirm = d => [...d.querySelectorAll('button')].filter(visible).find(b => AFFIRM.test(clean(b.innerText)) && !NEGATE.test(clean(b.innerText)));

  async function submit(btn) {
    btn.scrollIntoView({ block: 'center' });
    await sleep(CFG.answerDelay);
    if (stopRun) return false;
    btn.click();
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      // No dialog and the attempt is gone: the site submitted straight away.
      if (!document.querySelector('ol.attempt-question-list') && await submitted()) return true;
      const d = dialogs().find(affirm);
      if (!d) continue;
      if (stopRun) { [...d.querySelectorAll('button')].find(b => /cancel/i.test(b.innerText))?.click(); return false; }
      affirm(d).click();
      for (let j = 0; j < 60 && document.querySelector('ol.attempt-question-list'); j++) await sleep(250);
      return submitted();
    }
    return false;
  }

  /** The attempt is gone and stays gone; a list that blinks out during a re-render does not count. */
  async function submitted() {
    if (document.querySelector('ol.attempt-question-list')) return false;
    await sleep(1000);
    return !document.querySelector('ol.attempt-question-list');
  }

  /* ---------------------------------------------------------------- solve */

  const NEXT = /^(go to )?next\b/i;
  const nextCandidates = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible)
    .filter(b => [b.innerText, b.getAttribute('aria-label'), b.getAttribute('title')].some(t => NEXT.test(clean(t))));
  const nextButton = () => nextCandidates().find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');

  /** What identifies the questions on screen, so a page turn can be told from a page that has not repainted. */
  const pageSignature = () => {
    const list = document.querySelector('ol.attempt-question-list');
    return list ? [...list.children].map(li => clean(li.innerText).slice(0, 80)).join('|') : '';
  };

  /** Answer what the screen shows. Returns how many were answered and which could not be. */
  async function answerPage(n0, total) {
    const { items } = scrape();
    await Promise.all(items.map(loadImages));
    const skipped = items.filter(q => !SOLVABLE.has(q.kind));
    let done = 0;

    // The model's answers do not depend on the page, so the questions that need no screenshot are asked
    // together, a few at a time, while the clicking below walks through them in order.
    const waiting = [];
    let inflight = 0;
    const pump = () => {
      while (inflight < (CFG.reuseChat ? 1 : Math.max(1, CFG.concurrency)) && waiting.length) {
        const job = waiting.shift();
        inflight++;
        job().finally(() => { inflight--; pump(); });
      }
    };
    for (const q of items) {
      if (!SOLVABLE.has(q.kind) || q.answered || needsPicture(q) || CFG.screenshot === 'always') continue;
      q.pending = new Promise(resolve => {
        waiting.push(() => stopRun ? Promise.resolve(resolve({ ok: false, error: 'stopped' }))
          : solve1(q, null).then(resolve, e => resolve({ ok: false, error: String(e?.message || e) })));
      });
    }
    pump();

    for (const [n, q] of items.entries()) {
      if (stopRun) { waiting.length = 0; return { ok: false, reason: 'stopped', done, skipped }; }
      if (!SOLVABLE.has(q.kind)) continue;
      if (q.answered) { done++; continue; }
      hud(`question ${n0 + n + 1}/${total || '?'}: asking ai…`);
      const r = await (q.pending || solve1(q));
      // Questions still queued would only keep calling the model for a run that has already ended.
      if (stopRun) { waiting.length = 0; return { ok: false, reason: 'stopped', done, skipped }; }
      if (!r.ok) { waiting.length = 0; hud(`✗ ${r.error}`, true); return { ok: false, reason: 'api', error: r.error, done, skipped }; }
      if (!(await apply(q, r))) {
        waiting.length = 0;
        hud(`✗ could not answer question ${n0 + n + 1} (${q.kind})`, true);
        return { ok: false, reason: 'click', done, skipped };
      }
      dbg('info', `answered #${n0 + n + 1} (${q.kind})`, { answer: label1(r), why: r.why, confidence: r.confidence });
      done++;
    }
    return { ok: true, done, skipped, count: items.length };
  }

  /** Every failure is kept, not merely shown. A report written the moment a run stops still has
   *  the live page in it; by the time the popup is read, the page has usually moved on. */
  async function solve(opts = {}) {
    const r = await solveOnce(opts);
    if (!r.ok && r.reason !== 'busy') {
      dbg('error', `solve stopped: ${r.reason || r.error || 'no reason given'}`, { done: r.done, skippedCount: (r.skipped || []).length });
      report('solve', r.error || r.reason || 'the run stopped', { result: r, opts });
    }
    return r;
  }

  async function solveOnce(opts = {}) {
    if (busy) { hud('already running', true); return { ok: false, reason: 'busy' }; }
    busy = true;
    if (!opts.keepStop) stopRun = false;
    try {
      if (!scrape().items.length) { hud('no question on this page', true); return { ok: false, reason: 'no-question' }; }

      let done = 0, seen = 0;
      const skipped = [];
      // A test can show every question at once or one page at a time; walk forward through the pages either way.
      for (let page = 0; page < 100; page++) {
        const total = (document.body.innerText.match(/(\d+)\s+OF\s+(\d+)\s+QUESTIONS\s+REMAINING/i) || [])[2];
        const r = await answerPage(seen, total && +total);
        done += r.done;
        skipped.push(...r.skipped);
        if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
        seen += r.count;
        // A Next that is present but still disabled, or questions the counter says are open, mean the site is still saving: wait.
        const open = () => +(document.body.innerText.match(/(\d+)\s+OF\s+\d+\s+QUESTIONS\s+REMAINING/i) || [])[1] > 0;
        const next = nextButton() || (nextCandidates().length || open() ? await until(nextButton, 6000, 250) : null);
        if (!next) break;
        // The page must change before it is read again, or the old page is answered twice and one is skipped.
        const before = pageSignature();
        next.click();
        if (!(await until(() => pageSignature() !== before, 10000, 200))) {
          hud('✗ the next page did not open', true);
          return { ok: false, reason: 'page', error: 'next page did not open' };
        }
        await sleep(400);
      }

      // The site's own counter has the last word on whether anything is still open.
      const remaining = () => (document.body.innerText.match(/(\d+)\s+OF\s+\d+\s+QUESTIONS\s+REMAINING/i) || [])[1];
      // The counter trails the last autosave by a moment.
      if (!skipped.length) await until(() => !(+remaining() > 0), 3000, 250);
      const left = remaining();
      if (left && +left > 0 && !skipped.length) {
        hud(`✗ ${left} question(s) still unanswered — not submitting`, true);
        return { ok: false, reason: 'unanswered', error: `${left} unanswered` };
      }

      // Leaving anything unanswered means a person should look at it before it is handed in.
      if (skipped.length) {
        const kinds = [...new Set(skipped.map(q => q.type || q.kind))].join(', ');
        hud(`answered ${done} of ${seen}; left ${skipped.length} that cannot be answered here (${kinds}) — not submitting`, true);
        return { ok: done > 0, submitted: false, skipped: skipped.length, kinds };
      }

      if (stopRun) { hud('stopped', true); return { ok: false, reason: 'stopped' }; }
      hud(`✓ answered ${done}/${seen}`);
      // The site enables Submit only once its autosave has caught up with the last answer.
      const submitBtn = await until(() => { const b = scrape().submit; return b && !b.disabled ? b : null; }, 8000);
      if ((CFG.autoSubmit || opts.forceSubmit) && submitBtn) {
        const sent = await submit(submitBtn);
        if (!sent && stopRun) { hud('stopped before submitting', true); return { ok: false, reason: 'stopped' }; }
        hud(sent ? `✓ answered ${done} and submitted` : '⚠ pressed Submit but the attempt is still open', !sent);
        return { ok: true, submitted: sent };
      }
      if (CFG.autoSubmit || opts.forceSubmit) hud('⚠ answered everything but the Submit button was not found or never became enabled — submit it yourself', true);
      return { ok: true, submitted: false };
    } catch (e) {
      console.error('[ats-solver]', e);
      hud(`✗ ${e.message || e}`, true);
      return { ok: false, error: String(e.message || e) };
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------ auto mode */

  // A run walks a list of assessments by itself. Its progress lives in storage, because opening the next
  // assessment reloads the page and this script starts over.
  const RUN_KEY = 'atsRun';
  const runStore = {
    async get() { try { return (await chrome.storage.local.get(RUN_KEY))[RUN_KEY] || null; } catch { return null; } },
    // A stop must not be written over by a step that still holds the old run.
    async set(v) { try { if (stopRun) v.active = false; await chrome.storage.local.set({ [RUN_KEY]: v }); } catch { /* run state is best effort */ } },
  };
  // A stop pressed in the popup reaches a page that is mid-reload only through storage.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[RUN_KEY]?.newValue && changes[RUN_KEY].newValue.active === false) stopRun = true;
  });
  // Each tab keeps its own owner id across reloads, so another tab never picks the run up.
  const OWNER_KEY = 'atsOwner';
  const ownerHere = () => { try { return sessionStorage.getItem(OWNER_KEY); } catch { return null; } };

  async function until(fn, ms = 20000, step = 250) {
    for (let t = 0; t < ms; t += step) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /** The assessments of one course that a run may open. Everything else comes back as a skip with its reason. */
  async function courseWork(courseId, courseName) {
    const out = { queue: [], skipped: [] };
    const { results = [] } = await api(`/learn/api/v1/courses/${courseId}/gradebook/columns?limit=200`);
    const now = Date.now();
    const cols = results.filter(c => c.contentId && /x-bb-assessment/.test(c.scoreProviderHandle || ''))
      .sort((a, b) => (Date.parse(a.dueDate) || Infinity) - (Date.parse(b.dueDate) || Infinity));
    for (const c of cols) {
      const title = c.effectiveColumnName || c.columnName;
      const skip = why => out.skipped.push({ title, course: courseName, why });
      if (/Assignment/i.test(c.gradebookCategory?.title || '')) { skip('assignment (not questions)'); continue; }
      if (c.enforceDueDate && c.dueDate && Date.parse(c.dueDate) < now) { skip('past its due date'); continue; }
      out.queue.push({ courseId, contentId: c.contentId, title, course: courseName });
    }
    return out;
  }

  async function buildQueue(run) {
    const queue = [], skipped = [];
    if (run.scope === 'assessment') {
      const r = route();
      queue.push({ courseId: r.courseId, contentId: r.contentId, title: clean(document.querySelector('h1, h2')?.textContent) || r.contentId, course: '' });
      return { queue, skipped };
    }
    const { results = [] } = await api('/learn/api/v1/users/me/memberships?expand=course&limit=200');
    const names = Object.fromEntries(results.filter(m => m.course).map(m => [m.courseId, m.course.name || m.courseId]));
    const ids = run.scope === 'course' ? [courseIdHere()].filter(Boolean) : Object.keys(names);
    for (const id of ids) {
      try {
        const w = await courseWork(id, names[id] || id);
        queue.push(...w.queue);
        skipped.push(...w.skipped);
      } catch (e) { skipped.push({ title: names[id] || id, course: '', why: `could not read its assessments (${e.message})` }); }
    }
    return { queue, skipped };
  }

  const START = /^(start|continue)\s+attempt\b/i;
  const startButton = () => [...document.querySelectorAll('a, button')].filter(visible).find(e => START.test(clean(e.innerText || e.getAttribute('aria-label'))));

  /** True when the overview shows a grade at its maximum, e.g. "Grade 10 / 10", "Score: 100/100" or "Grade 100%". Dates like 9/17/26 never match. */
  function fullMark(text) {
    for (const m of text.matchAll(/(?:grade|score|points?)\D{0,30}?(\d+(?:[.,]\d+)?)\s*(?:\/|out of)\s*(\d+(?:[.,]\d+)?)(?!\s*\/\s*\d)/gi)) {
      const got = parseFloat(m[1].replace(',', '.')), max = parseFloat(m[2].replace(',', '.'));
      if (max > 0 && got >= max) return true;
    }
    return /(?:grade|score)\D{0,30}?\b100(?:[.,]0+)?\s*%/i.test(text);
  }

  /** What the overview page says about the assessment, and the control that opens an attempt. Skips what must not be opened. */
  async function inspectOverview() {
    await until(() => /attempt|due date/i.test(document.body.innerText), 30000);
    await sleep(1500);
    const text = document.body.innerText;
    if (/respondus|lockdown/i.test(text)) return { skip: 'needs Respondus LockDown Browser' };
    if (/proctor/i.test(text)) return { skip: 'proctored' };
    // "Start attempt 2" means an earlier try was handed in; retake it while attempts remain and the grade is below full marks.
    if (/\b0 attempts? left|no attempts left/i.test(text)) return { skip: '0 attempts left' };
    if (fullMark(text)) return { skip: 'already full marks' };
    const btn = startButton();
    if (!btn) return { skip: (text.match(/no attempts left|\d+ attempts? left/i) || ['no Start button (already taken or locked)'])[0] };
    return { btn };
  }

  /** Press Start and get through whatever the site asks before the questions appear. */
  async function openAttempt(btn) {
    btn.click();
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (document.querySelector('ol.attempt-question-list .assessment-question')) return true;
      const d = dialogs().find(affirm);
      if (d) {
        if (/respondus|lockdown|proctor/i.test(d.innerText)) return false;
        affirm(d).click();
        await sleep(600);
      }
    }
    return false;
  }

  const summary = run => `${run.solved} solved, ${run.skipped.length} skipped` +
    (run.skipped.length ? ` — ${run.skipped.slice(0, 4).map(s => `${s.title} (${s.why})`).join('; ')}${run.skipped.length > 4 ? '…' : ''}` : '');

  async function finish(run, note) {
    run.active = false;
    run.finished = Date.now();
    run.note = note || '';
    await runStore.set(run);
    hud(`${note ? note + ' · ' : ''}done: ${summary(run)}`, run.skipped.length > 0);
    dbg('info', 'run finished', { note: run.note, solved: run.solved, skipped: run.skipped.length, scope: run.scope });
  }

  /** Move on to the next assessment. A full load, so a page left in a odd state cannot carry over. */
  async function advance(run) {
    if (stopRun) return finish(run, 'stopped');
    run.i++;
    run.tries = 0;
    await runStore.set(run);
    const next = run.queue[run.i];
    if (!next) return finish(run);
    location.href = overviewUrl(next.courseId, next.contentId);
  }

  /** One step of a run, wherever the page happens to be. Safe to call again after a reload. */
  async function runStep() {
    const run = await runStore.get();
    if (!run?.active || running) return;
    if (run.owner !== ownerHere()) return;
    // A run left active by a crash or a closed tab must not wake up on some later visit.
    if (Date.now() - (run.started || 0) > 2 * 3600e3) { run.active = false; await runStore.set(run); return; }
    running = true;
    try {
      if (!run.queue) {
        hud('finding assessments…');
        const { queue, skipped } = await buildQueue(run);
        Object.assign(run, { queue, i: 0, tries: 0 });
        run.skipped.push(...skipped);
        await runStore.set(run);
        if (!queue.length) { await finish(run, 'nothing to open'); return; }
      }
      const item = run.queue[run.i];
      if (!item) { await finish(run); return; }
      const here = route();

      // Handing an attempt in can load the site's confirmation page, which ends the script that pressed Submit.
      // That page is the proof it went through; count it and move on instead of opening the assessment again.
      if (run.submitting === item.contentId && !document.querySelector('ol.attempt-question-list')) {
        const done = await until(() => /submission was successful/i.test(document.body.innerText), 15000, 300);
        if (done) {
          run.submitting = null;
          run.solved++;
          await runStore.set(run);
          if (run.scope === 'assessment') return finish(run);
          await advance(run);
          return;
        }
      }

      // Not on this item's page yet: go there. A guard stops a page that never matches from looping.
      if (!here || here.contentId !== item.contentId) {
        if (run.tries++ >= 3) { run.skipped.push({ title: item.title, course: item.course, why: 'its page would not open' }); await advance(run); return; }
        await runStore.set(run);
        location.href = overviewUrl(item.courseId, item.contentId);
        return;
      }

      if (here.page === 'overview') {
        hud(`${item.course ? item.course + ': ' : ''}checking “${item.title}”…`);
        const o = await inspectOverview();
        if (stopRun) return finish(run, 'stopped');
        if (o.skip) {
          dbg('info', `skipped “${item.title}”`, o.skip);
          run.skipped.push({ title: item.title, course: item.course, why: o.skip });
          await advance(run);
          return;
        }
        hud(`${item.course ? item.course + ': ' : ''}starting “${item.title}”…`);
        if (!(await openAttempt(o.btn))) {
          run.skipped.push({ title: item.title, course: item.course, why: 'the attempt did not open' });
          await advance(run);
          return;
        }
      }

      // On the attempt: answer it and hand it in. A reload lands here before the questions have rendered.
      await until(() => scrape().items.length, 30000, 300);
      await sleep(500);
      if (stopRun) { run.skipped.push({ title: item.title, course: item.course, why: 'stopped; attempt left open' }); return finish(run, 'stopped'); }
      run.submitting = item.contentId;
      await runStore.set(run);
      const r = await solve({ forceSubmit: true, keepStop: true });
      if (r.reason === 'stopped') { run.skipped.push({ title: item.title, course: item.course, why: 'stopped; attempt left open' }); return finish(run, 'stopped'); }
      if (!r.ok || !r.submitted) {
        // Stop rather than move on: an attempt was started and left open, and a person should look.
        run.skipped.push({ title: item.title, course: item.course, why: `stopped: ${r.error || r.reason || (r.skipped ? `has ${r.kinds}` : 'not submitted')}` });
        return finish(run, 'halted on an attempt left open');
      }
      run.solved++;
      run.submitting = null;
      await sleep(1500);
      if (run.scope === 'assessment') return finish(run);
      await advance(run);
    } catch (e) {
      console.error('[ats-solver]', e);
      dbg('error', `the run threw on step ${run.i + 1}`, { message: String(e && (e.message || e)), stack: String(e && e.stack || '').slice(0, 800) });
      report('run', String(e && (e.message || e)) || 'the run threw', { step: run.i, item: run.queue?.[run.i], run: { active: run.active, scope: run.scope, solved: run.solved, skipped: run.skipped } });
      hud(`✗ ${e.message || e}`, true);
      run.active = false;
      await runStore.set(run);
    } finally {
      running = false;
    }
  }

  async function startRun(scope) {
    if (running || busy) return { ok: false, reason: 'running' };
    stopRun = false;
    const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { sessionStorage.setItem(OWNER_KEY, owner); } catch { /* without it the run cannot resume after a reload */ }
    const run = { owner, active: true, scope, started: Date.now(), solved: 0, skipped: [], queue: null, i: 0, tries: 0 };
    await runStore.set(run);
    runStep();
    return { ok: true };
  }

  async function stopAll() {
    stopRun = true;
    const run = await runStore.get();
    if (run?.active) { run.active = false; await runStore.set(run); }
  }

  /** Where the page is: an open attempt, an assessment's overview, a course, or anywhere else on the site. */
  const whereAmI = () => (scrape().items.length ? 'attempt'
    : route()?.page === 'overview' ? 'overview'
    : courseIdHere() ? 'course'
    : /^\/ultra\//.test(location.pathname) ? 'dashboard'
    : 'other');

  /* --------------------------------------------------------------- report */

  /** A shallow shape of a container, for a page nothing was recognised on. Blackboard's markup is
   *  the part that changes under this extension, so a tag-and-class tree is what turns "it didn't
   *  work" into something that can be fixed without asking for a screenshot. */
  function outline(root, maxDepth = 7, maxNodes = 240) {
    const lines = [];
    const walk = (el, depth) => {
      if (!el || el.nodeType !== 1 || depth > maxDepth || lines.length >= maxNodes) return;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.') : '';
      const text = clean(el.textContent).slice(0, 60);
      lines.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}` +
                 `${el.children.length ? ` ×${el.children.length}` : ''}${text ? ` “${text}”` : ''}`);
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    if (lines.length >= maxNodes) lines.push('  … (cut off)');
    return lines.join('\n');
  }

  /** Everything a bug report needs from this page: what was read, what it was read as, and — when
   *  nothing was read — the shape of the page instead. Printed as text, because a collapsed object
   *  in a console is worth nothing to whoever receives it. */
  async function pageDump() {
    const L = [];
    const add = (k, v) => L.push(`  ${String(k).padEnd(16)} ${v}`);
    const r = route();

    L.push('--- page ---');
    add('build', BUILD);
    add('where', whereAmI());
    add('top frame', IS_TOP ? 'yes' : 'no');
    add('route', r ? `${r.page}, course ${r.courseId}, content ${r.contentId}` : 'not an assessment route');
    add('url', location.href);
    add('title', clean(document.title).slice(0, 120));
    add('viewport', `${innerWidth}x${innerHeight}${document.hidden ? ', tab hidden' : ''}`);

    let items = [], submit = null, scrapeError = '';
    try { ({ items, submit } = scrape()); } catch (e) { scrapeError = String(e && (e.message || e)); }

    add('questions', scrapeError ? `SCRAPE THREW: ${scrapeError}` : (items.length || '— NONE FOUND —'));
    add('counter', (document.body.innerText.match(/\d+\s+OF\s+\d+\s+QUESTIONS\s+REMAINING/i) || ['absent'])[0]);
    add('submit', submit ? `“${clean(submit.innerText)}”, disabled=${submit.disabled}` : 'not found');
    add('next', nextButton() ? 'found' : nextCandidates().length ? 'present but disabled' : 'not found');
    // When Next is missing, the controls on screen show what the site calls it.
    const controls = [...document.querySelectorAll('button, [role="button"], a[href]')].filter(visible)
      .map(e => `${e.tagName.toLowerCase()} “${clean(e.innerText).slice(0, 40)}”${e.getAttribute('aria-label') ? ` aria-label=“${e.getAttribute('aria-label').slice(0, 40)}”` : ''}${e.disabled || e.getAttribute('aria-disabled') === 'true' ? ' disabled' : ''}`);
    add('controls', controls.length ? controls.slice(0, 25).join(' | ') : 'none');
    add('list items', document.querySelector('ol.attempt-question-list')?.children.length ?? 'no list');
    const openDialogs = dialogs().map(d => clean(d.innerText).slice(0, 100));
    add('dialogs', openDialogs.length ? openDialogs.join(' | ') : 'none');

    items.forEach((q, i) => {
      L.push('');
      L.push(`  [${i + 1}] ${q.kind}${q.type ? ` (${q.type})` : ''}${q.answered ? ' · answered already' : ''}${SOLVABLE.has(q.kind) ? '' : ' · CANNOT BE ANSWERED'}`);
      L.push(`        stem      ${JSON.stringify(q.stem.slice(0, 260))}`);
      for (const [n, o] of q.options.entries()) {
        L.push(`        ${`${LETTERS[n]}         `.slice(0, 10)}${JSON.stringify(o.text.slice(0, 90))}${o.text ? '' : ' · NO TEXT'}${o.imgs.length ? ' · picture' : ''}`);
      }
      if (q.inputs) L.push(`        inputs    ${q.inputs.length}`);
      if (q.passage) L.push(`        passage   ${q.passage.length} chars`);
      L.push(`        pictures  ${q.imageTotal || 0} on the page, ${q.images.length} attached`);
    });

    // Nothing recognised: the outline is the whole value of the report.
    if (!items.length) {
      const root = document.querySelector('ol.attempt-question-list')
                || document.querySelector('main, [role="main"]')
                || document.body;
      L.push('');
      L.push('--- outline (nothing was recognised on this page) ---');
      L.push(outline(root));
    }

    L.push('');
    L.push('--- settings ---');
    add('autoSubmit', CFG.autoSubmit);
    add('screenshot', CFG.screenshot);
    add('answerDelay', CFG.answerDelay);
    add('verify', CFG.verify);
    add('concurrency', CFG.concurrency);
    add('reuseChat', CFG.reuseChat);
    add('devMode', CFG.devMode);

    let run = null;
    try { run = await runStore.get(); } catch { /* no run state to report */ }
    L.push('');
    L.push('--- run ---');
    if (!run) {
      add('run', 'none');
    } else {
      add('active', run.active);
      add('scope', run.scope);
      add('step', `${(run.i || 0) + 1} of ${run.queue ? run.queue.length : '?'}`);
      add('solved', run.solved);
      add('skipped', (run.skipped || []).length);
      if (run.note) add('note', run.note);
      add('this tab owns it', run.owner === ownerHere() ? 'yes' : 'no');
      for (const s of (run.skipped || []).slice(0, 12)) L.push(`        · ${s.title}${s.course ? ` [${s.course}]` : ''} — ${s.why}`);
    }
    return L.join('\n');
  }

  /** Keep a report under the key the popup reads. `debug.js` does the assembling when it is loaded;
   *  without it (an older tab, or the offline harness) the same promise is kept the short way, so
   *  the Copy button never has nothing to hand back. */
  async function report(stage, message, detail) {
    try {
      if (D) return await D.report(stage, message, detail);
      const text = [
        '=== ATS Solver report ===',
        `build:   ${BUILD}`,
        `when:    ${new Date().toISOString()}`,
        `stage:   ${stage}`,
        `message: ${message}`,
        '',
        await pageDump(),
      ].join('\n');
      await chrome.storage.local.set({ lastReport: text, lastReportAt: Date.now() });
      return text;
    } catch { return ''; }
  }

  if (D) D.register(pageDump);

  /* ------------------------------------------------------------- plumbing */

  async function loadSettings() {
    try { Object.assign(CFG, await chrome.storage.local.get(Object.keys(CFG))); } catch { /* defaults */ }
  }
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) if (k in CFG) CFG[k] = v.newValue;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg?.type) {
      case 'do-solve': {
        const { items } = scrape();
        if (!items.length) {
          if (!IS_TOP) return false;
          // The most common bug report there is: "it found nothing". The page will not look like
          // this later, so what it looks like now is kept, and the popup says so.
          report('no-question', 'the page script found no question', { where: whereAmI(), url: location.href })
            .then(() => respond({ handled: false, why: 'no question on this page', build: BUILD, report: true }))
            .catch(() => respond({ handled: false, why: 'no question on this page', build: BUILD }));
          return true;
        }
        solve();
        respond({ handled: true, kind: items.every(q => q.kind === 'mcq') ? 'mcq' : 'mixed', build: BUILD });
        return true;
      }
      case 'do-dump': {
        if (!IS_TOP) return false;
        if (CFG.devMode !== true) {
          respond({ ok: false, devOff: true, error: 'Developer mode is off — turn it on in Options.', build: BUILD });
          return true;
        }
        report('dump', 'the page was dumped by hand')
          .then(() => respond({ ok: true, build: BUILD }))
          .catch(e => respond({ ok: false, error: String(e && (e.message || e)), build: BUILD }));
        return true;
      }
      case 'do-where':
        if (!IS_TOP) return false;
        respond({ build: BUILD, where: whereAmI() });
        return true;
      case 'do-ping': {
        if (!IS_TOP) return false;
        const { items } = scrape();
        respond({ build: BUILD, kind: items.length ? items.map(q => q.kind).join(',') : '', summary: `${items.length} question(s)`, why: items.length ? '' : 'no question on this page' });
        return true;
      }
      case 'do-run-assessment':
      case 'do-run-course':
      case 'do-run-all':
        startRun({ 'do-run-assessment': 'assessment', 'do-run-course': 'course', 'do-run-all': 'all' }[msg.type])
          .then(r => respond({ handled: r.ok, why: r.reason, build: BUILD }));
        return true;
      case 'do-status':
        runStore.get().then(run => respond({ build: BUILD, run }));
        return true;
      case 'do-stop':
        stopAll();
        respond({ stopping: true });
        return true;
    }
    return false;
  });

  const hotkeyOf = action => (CFG.hotkeys && action in CFG.hotkeys ? CFG.hotkeys[action] : DEFAULT_HOTKEYS[action]);
  const isPressed = (e, k) => !!k && e.code === k.code &&
    e.ctrlKey === !!k.ctrl && e.shiftKey === !!k.shift && e.altKey === !!k.alt && e.metaKey === !!k.meta;

  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    const action = ['solve', 'stop'].find(a => isPressed(e, hotkeyOf(a)));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'stop') { stopAll(); hud('stopping…'); return; }
    if (scrape().items.length) solve();
  }, true);

  loadSettings().then(() => {
    // One line per page the script wakes up on, so a run's log reads as the walk it actually took.
    dbg('info', `page ready · ${whereAmI()}`, { build: BUILD, url: location.pathname });
    return runStep();
  });
})();

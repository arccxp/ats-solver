"""Offline harness for ats.js.

Every request the page makes is answered here: the Ultra routes are served from fixtures, the REST API from
canned JSON, everything else is aborted, so the real ats.blackboard.com is never contacted. ats.js is injected
on `load` (like a document_idle content script) so it also comes back after a navigation, and `chrome.*` is a
mock whose state (storage, ask log, scripted model replies) lives in sessionStorage so it survives reloads.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
# ATS_JS=/path/to/copy.js runs the whole suite against another build (used to prove tests catch regressions).
ATS_JS = Path(os.environ.get("ATS_JS") or ROOT / "ats.js")
ORIGIN = "https://ats.blackboard.com"

MOCK = r"""
(() => {
  const ss = {
    get: (k, d) => { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const INIT = __INIT__;
  if (sessionStorage.getItem('__booted') == null) {
    sessionStorage.setItem('__booted', '1');
    ss.set('__store', INIT.store);
    ss.set('__script', INIT.script);
    ss.set('__asks', []);
  }
  window.__asks = () => ss.get('__asks', []);
  window.__store = () => ss.get('__store', {});
  window.__setScript = s => ss.set('__script', s);

  const pickKeys = (all, keys) => {
    if (keys == null) return all;
    const out = {};
    for (const k of (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)))
      if (k in all) out[k] = all[k];
    return out;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function reply(m) {
    if (m.type !== 'ask') return null;
    const p = m.payload;
    const asks = ss.get('__asks', []); asks.push(m); ss.set('__asks', asks);
    const script = ss.get('__script', []);
    const hit = script.find(s => !s.match || (p.stem || '').includes(s.match));
    if (!hit) return { error: 'no scripted reply for: ' + (p.stem || '').slice(0, 60) };
    if (hit.times != null) {                                // a scripted entry that applies this many times, then is gone
      hit.times -= 1;
      ss.set('__script', hit.times > 0 ? script : script.filter(s => s !== hit));
    }
    if (hit.throw) throw new Error(hit.throw);
    if (hit.delay) await sleep(hit.delay);
    const r = { ...hit.reply };
    if (r.pick != null) {                                   // choose by option text: independent of shown order
      const i = p.options.findIndex(o => o.text === r.pick);
      r.index = i; r.letter = 'ABCDEFGHIJ'[i]; delete r.pick;
    }
    if (r.index != null && r.confidence === undefined) r.confidence = 0.95;
    return r;
  }

  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async m => JSON.parse(JSON.stringify((await reply(m)) ?? null)),
      onMessage: { addListener: f => { window.__listener = f; } },
    },
    storage: {
      local: {
        get: async keys => pickKeys(ss.get('__store', {}), keys),
        set: async items => { const s = ss.get('__store', {}); Object.assign(s, JSON.parse(JSON.stringify(items))); ss.set('__store', s); },
      },
      onChanged: { addListener() {} },
    },
  };

  window.addEventListener('load', () => {
    try { (function () { __ATS__ })(); } catch (e) { console.error('[harness] inject failed', e); }
  });
})();
"""


def init_script(store, script):
    init = {"store": {"answerDelay": 5, **(store or {})}, "script": script or []}
    return MOCK.replace("__INIT__", json.dumps(init)).replace("__ATS__", ATS_JS.read_text(encoding="utf-8"))


class Env:
    """One browser tab on a served fixture, plus the helpers the tests use."""

    def __init__(self, ctx, page, errors):
        self.ctx, self.page, self.errors = ctx, page, errors

    def goto(self, url):
        self.page.goto(url, wait_until="load")
        self.page.wait_for_function("typeof window.__listener === 'function'", timeout=5000)

    def call(self, type_, timeout=1500):
        """Send a message through the listener ats.js registered, as popup.js / background.js would."""
        return self.page.evaluate(
            "([t, ms]) => new Promise(r => { window.__listener({type: t}, {}, r); setTimeout(() => r('no-reply'), ms) })",
            [type_, timeout],
        )

    def script(self, entries):
        self.page.evaluate("s => window.__setScript(s)", entries)

    def asks(self):
        return self.page.evaluate("window.__asks()")

    def store(self):
        return self.page.evaluate("window.__store()")

    def ev(self):
        return self.page.evaluate("window.__ev || []")

    def hud(self):
        return self.page.evaluate("document.getElementById('ats-solver-hud')?.textContent || ''")

    def wait(self, expr, timeout=20000):
        self.page.wait_for_function(expr, timeout=timeout)

    def wait_hud(self, pattern, timeout=20000):
        self.page.wait_for_function(
            "p => new RegExp(p, 'i').test(document.getElementById('ats-solver-hud')?.textContent || '')", arg=pattern, timeout=timeout
        )

    def run_finished(self, timeout=40000):
        self.page.wait_for_function(
            "() => { const r = window.__store().atsRun; return r && r.active === false && r.finished }", timeout=timeout
        )
        return self.store()["atsRun"]

    def settle(self, ms=1200):
        self.page.wait_for_timeout(ms)


def make_router(serve, api):
    def pick(url):
        parts = urlsplit(url)
        if isinstance(serve, str):
            return serve
        if callable(serve):
            return serve(url)
        return serve.get(parts.path)

    def handler(route):
        url = route.request.url
        if url.startswith(ORIGIN + "/learn/api/"):
            body = api(url) if callable(api) else (api or {}).get(urlsplit(url).path)
            if body is None:
                return route.fulfill(status=404, content_type="application/json", body="{}")
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        if url.startswith(ORIGIN + "/ultra"):
            html = pick(url)
            if html is None:
                return route.fulfill(status=404, content_type="text/html", body="not found")
            return route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html)
        route.abort()

    return handler

'use strict';
/**
 * Runs inside a gemini.google.com tab and does the talking, because that is the only place
 * the site's own requests can honestly come from: same origin, so the browser attaches the
 * session cookies by itself, and — for the accounts Google has switched Device Bound Session
 * Credentials on for — the proof-of-possession that Chrome keeps in the OS key store is added
 * by the network stack, not by us.
 *
 * A service worker cannot do either. It is a different origin, so a SameSite=Lax session
 * cookie is simply not sent, and it cannot produce the bound-session proof, so every request
 * would arrive signed out. Copying the cookies into an options box is worse still: that is
 * the one thing Device Bound Session Credentials exists to defeat, so a copied cookie stops
 * working within hours.
 *
 * So this file is a thin, faithful relay of what the page itself does: the same endpoints,
 * the same JSPB body, the same headers. The service worker decides *what* to ask; this decides
 * nothing and only carries it.
 */

/* The page's own lines join the same log as everything else. Absent when debug.js is not loaded
 * (the offline tests inject this file on its own), so it is optional at every call. */
const dbg = (level, message, data) => { try { window.ATSDebug?.log(level, message, data); } catch { /* a logger must not fail a relay */ } };

/* ------------------------------------------------------------ reading responses */

/** Read field `index` of a JSPB array. A field is either in its own slot or, when the number
 *  is sparse, in a dict of high-numbered fields that always sits in the array's last slot,
 *  keyed by the field number plus one. Only one of the two ever holds a given field. */
function gwField(container, index, fallback = null) {
  if (!Array.isArray(container) || !container.length) return fallback;
  let v = index >= 0 && index < container.length ? container[index] : null;

  const empty = x => x === null || x === undefined || (Array.isArray(x) && !x.length);
  if (empty(v)) {
    const last = container[container.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) v = last[String(index + 1)];
  }
  return empty(v) ? fallback : v;
}

/** Walk a mixed path of list indices and dict keys, giving up rather than throwing. */
function gwPath(data, path, fallback = null) {
  let cur = data;
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number') {
      const i = key < 0 ? cur.length + key : key;
      if (i < 0 || i >= cur.length) return fallback;
      cur = cur[i];
    } else if (cur && typeof cur === 'object' && typeof key === 'string' && key in cur) {
      cur = cur[key];
    } else {
      return fallback;
    }
  }
  return cur === null || cur === undefined ? fallback : cur;
}

/** Google's replies are `)]}'` and then frames, each introduced by a length line (`<count>\n`).
 *  The count is NOT trusted as a boundary. What it counts — UTF-16 units, bytes, whether the
 *  newline is included — is not something to bet a whole reply on: one miscount on a frame with
 *  non-ASCII text (an Arabic answer, say) and every frame after it is cut in the wrong place and
 *  lost. So the frames are read the way a streaming JSON decoder reads them, one value after
 *  another, and the count is only stepped over. The Go and Python clients both end up here too.
 *
 *  A frame is a list, so a frame starts at `[` and ends at its matching `]`; brackets inside
 *  strings, and escaped quotes inside those, are skipped. Anything between frames (the length
 *  line, whitespace, rubbish) is ignored, and a frame that does not parse is skipped, not fatal. */
function gwFrames(raw) {
  let s = String(raw);
  const lead = /^\s*/.exec(s)[0].length;
  s = s.slice(lead);
  if (s.startsWith(")]}'")) s = s.slice(4);

  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '[') { i++; continue; }
    const end = gwListEnd(s, i);
    if (end === -1) break;            // cut off mid-frame: nothing after it can be trusted
    try {
      const parsed = JSON.parse(s.slice(i, end));
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch { /* a frame we cannot read is skipped, not fatal */ }
    i = end;
  }
  return out;
}

/** Where the list that opens at `start` ends (the index after its closing bracket), or -1 if the
 *  text stops first. Only brackets outside strings count. */
function gwListEnd(s, start) {
  let depth = 0, inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Where the page leaves a placeholder for a rendered attachment instead of the thing itself. */
const GW_CARD = /^https?:\/\/googleusercontent\.com\/card_content\/\d+/;
const GW_ARTIFACT = /https?:\/\/googleusercontent\.com\/(?:\w+\/)+\d+\n*/g;

/** One candidate's answer text. The block is cumulative — each frame carries the whole text
 *  so far rather than the newest piece — so the caller keeps the last one it sees. */
function gwCandidateText(cand) {
  let t = gwPath(cand, [1, 0], '');
  if (typeof t !== 'string' || !t) return '';
  if (GW_CARD.test(t)) t = gwPath(cand, [22, 0]) || t;
  return t.replace(GW_ARTIFACT, '');
}

/* ------------------------------------------------------------------- the requests */

const GW_ORIGIN = 'https://gemini.google.com';
const GW_BATCH_PATH = '/_/BardChatUi/data/batchexecute';
const GW_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const GW_MODEL_HEADER = 'x-goog-ext-525001261-jspb';
const GW_RPC_USER_STATUS = 'otAQ7b';
const GW_METADATA = ['', '', '', null, null, null, null, null, null, ''];
const GW_BROWSER_TYPE = 'chrome145';   // what the site sees for the browser these values came from

/** Which Google account this tab is showing. A browser signed in to more than one account keeps
 *  each at its own path slot — `/u/0/app`, `/u/1/app` and so on — and every request has to be
 *  made at the matching one. Asking the bare path is not "the same thing": it resolves to the
 *  browser's default account, which on a multi-account machine is often not the one this tab is
 *  showing, and the reply then arrives for an account whose session this is not.
 *
 *  So the slot is read from the tab's own address rather than assumed. An address with no slot is
 *  a single-account browser, where the bare path is correct. */
function gwAccount() {
  try {
    const m = /^\/u\/(\d+)(?:\/|$)/.exec(String(location?.pathname || ''));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** A site address, inside this tab's own account slot when it has one. */
function gwUrl(path, account = gwAccount()) {
  return account ? `${GW_ORIGIN}/u/${account}${path}` : `${GW_ORIGIN}${path}`;
}

/** The address the site is told the request came from. It carries the account slot as well:
 *  a request made from inside `/u/2/` that claims to come from `/app` describes a different
 *  account from the one the request is being made as. */
function gwSourcePath(account = gwAccount()) {
  return account ? `/u/${account}/app` : '/app';
}

/** The conversation slot of a request. A new conversation sends it empty; continuing one sends
 *  the three ids the site gave back for the last turn — the conversation, the reply and the
 *  chosen candidate — in the first three places, with the rest left as in an empty one. Ids that
 *  are not all non-empty strings are not a conversation, so the request starts a new one rather
 *  than naming something the site would not recognise. */
function gwChatMetadata(chat) {
  const ids = Array.isArray(chat) ? chat.slice(0, 3) : [];
  if (ids.length !== 3 || !ids.every(id => typeof id === 'string' && id)) return GW_METADATA;
  return [...ids, ...GW_METADATA.slice(3)];
}

/** The three thinking levels the site's request takes, as it numbers them. The numbers are not
 *  in the order the words are — the protocol puts `medium` at 4, above `high` at 2 — so the
 *  words are what a person picks and these are only what goes on the wire. An unnamed level is
 *  the standard one, which is also what `low` means. */
const GW_THINKING = { '': 1, low: 1, standard: 1, medium: 4, high: 2, extended: 2 };
function gwThinkingLevel(level) {
  const key = String(level ?? '').trim().toLowerCase();
  return GW_THINKING[key] ?? 1;
}

/** A fresh session id for this request, and the request counter the site expects to climb. */
const gwSessionId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toUpperCase();
let gwReqId = Math.floor(10000 + Math.random() * 89999);

/** The three headers that between them name a model. `capacity` is the account's tier value,
 *  read out of its own status reply, so an account is never offered a model it cannot use.
 *
 *  The array is one-based in the protocol but zero-based here, and the tail shifts by one when
 *  the account's capacity sits in field 13 rather than 12 — which is why `tail` is two elements
 *  wide in that case. The list stops at the model number: the site's bundle appends the thinking
 *  level and the session id before sending, and gwGenerate does the same. */
function gwModelHeaders(modelId, capacity, capacityField, modelNumber) {
  const tail = capacityField === 13 ? `null,${capacity}` : String(capacity);
  return {
    [GW_MODEL_HEADER]: `[1,null,null,null,"${modelId}",null,null,0,[4,5,6,8],null,null,${tail},null,null,${modelNumber}]`,
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0,0,0]',
  };
}

/** The access token and friends, read out of the page's own HTML — the same five values the
 *  site's bundle reads out of the same place. Without them the site answers 400. */
async function gwInit() {
  const account = gwAccount();
  const res = await fetch(gwUrl('/app', account), { credentials: 'include' });
  if (!res.ok) throw new Error(`gemini.google.com answered HTTP ${res.status} for the page itself`);
  const html = await res.text();

  const pick = re => (re.exec(html) || [])[1] || '';
  const out = {
    // The token sits in the page as a key of one object, or as a `["SNlM0e","…"]` pair in another.
    at: pick(/"SNlM0e":\s*"(.*?)"/) || pick(/\["SNlM0e",\s*"(.*?)"\]/),
    bl: pick(/"cfb2h":\s*"(.*?)"/),
    sid: pick(/"FdrFJe":\s*"(.*?)"/),
    hl: pick(/"TuX5cc":\s*"(.*?)"/) || 'en',
    push: pick(/"qKIAYe":\s*"(.*?)"/),
  };
  if (!out.at) {
    // The page loaded but carried no token, which is what being signed out looks like.
    throw new Error(
      account
        ? `no session token in the page for account slot ${account} — sign in at gemini.google.com as that account`
        : 'no session token in the page — sign in at gemini.google.com in this browser');
  }
  return { ...out, account, browser: GW_BROWSER_TYPE };
}

/** Every model this account may use, from the site's own status call. `tier` and `capability`
 *  are the account flags that decide which of them are actually selectable. */
async function gwModels(session) {
  const params = new URLSearchParams({
    rpcids: GW_RPC_USER_STATUS,
    hl: session.hl,
    _reqid: String((gwReqId += 100000)),
    rt: 'c',
    'source-path': gwSourcePath(session.account),
  });
  if (session.bl) params.set('bl', session.bl);
  if (session.sid) params.set('f.sid', session.sid);

  // The batch call sends its own model header: the same shape, with no model named.
  const header = JSON.parse('[1,null,null,null,null,null,null,null,[4,5,6,8],null,null,null,null,null,null,null]');
  header.push(gwSessionId());

  const res = await fetch(gwUrl(`${GW_BATCH_PATH}?${params}`, session.account), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      'x-goog-ext-73010989-jspb': '[0]',
      [GW_MODEL_HEADER]: JSON.stringify(header),
    },
    body: `at=${encodeURIComponent(session.at || '')}&f.req=${encodeURIComponent(
      JSON.stringify([[ [GW_RPC_USER_STATUS, '[]', null, 'generic'] ]]))}`,
  });
  if (!res.ok) throw new Error(`the site answered HTTP ${res.status} when asked for the model list`);

  const text = await res.text();
  const parts = gwFrames(text);
  for (const part of parts) {
    if (gwPath(part, [1]) !== GW_RPC_USER_STATUS) continue;
    // Slot 5 is the rejection list. Anything non-zero in it means the site refused this
    // session outright — a signed-out or revoked login — and no model list will follow.
    const rejected = gwPath(part, [5, 0]);
    if (typeof rejected === 'number' && rejected !== 0) throw new Error('the site says this session is not signed in');
    const raw = gwPath(part, [2]);
    // The status is normally a string of JSON; an already-decoded list is taken as it is. Anything
    // else is not a status: an `er` frame carries a bare error number in this slot, and running
    // that through JSON.parse would turn it into a "successful" reply with no models in it.
    let body;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw); } catch { continue; }
    } else if (Array.isArray(raw)) {
      body = raw;
    } else {
      if (gwPath(part, [0]) === 'er') {
        throw new Error(`the site reported an error for the model-list call${typeof raw === 'number' ? ` (code ${raw})` : ''} — the session may have expired or be for another account`);
      }
      continue;
    }

    // The account's own status code: 1000 is "fine". Anything else is the account being
    // barred, blocked or not signed in, and the caller turns the number into words.
    const status = gwPath(body, [14]);
    const list = gwPath(body, [15], []);
    const tier = gwPath(body, [16], []);
    const caps = gwPath(body, [17], []);
    return {
      status: typeof status === 'number' ? status : 1000,
      capacity: gwCapacity(Array.isArray(tier) ? tier : [], Array.isArray(caps) ? caps : []),
      models: gwModelList(Array.isArray(list) ? list : []),
    };
  }

  // Nothing recognisable came back. Rather than only saying so, describe what did arrive —
  // which RPC ids the frames carried and how long each part was — so a report is enough to
  // tell "the site changed its mind about the payload" from "we were sent somewhere else".
  const seen = parts.map(p => ({
    marker: gwPath(p, [0], '?'),
    rpc: gwPath(p, [1], '?'),
    len: Array.isArray(gwPath(p, [2], null)) ? gwPath(p, [2]).length : (typeof gwPath(p, [2], null) === 'string' ? gwPath(p, [2]).length : 0),
    reject: gwPath(p, [5, 0], null),
  }));
  throw new Error(`the model list did not arrive — the reply carried ${describeParts(seen, text)}`);
}

/** A short, safe description of what the frames held, for the message above. Numbers and the
 *  site's own labels only: the reply's contents are the account's own business and are not
 *  echoed back. With no frames at all it says how big the reply was and whether it looks like a
 *  web page rather than data — a sign-in or error page arrives as one and is easily mistaken for
 *  an empty reply. */
function describeParts(seen, text = '') {
  if (!seen.length) {
    const t = String(text).trimStart();
    const page = /^<(?:!doctype|html|head|body)/i.test(t);
    return `no frames at all (${String(text).length} chars came back${page ? ', and they look like a web page, not data — the tab may be signed out or on a sign-in page' : ''})`;
  }
  const rpcs = [...new Set(seen.map(s => String(s.rpc)))].slice(0, 6);
  const sizes = seen.map(s => s.len).filter(n => n > 0);
  const biggest = sizes.length ? Math.max(...sizes) : 0;
  const odd = [...new Set(seen.map(s => String(s.marker)).filter(m => m !== 'wrb.fr'))].slice(0, 4);
  return `${seen.length} frame${seen.length === 1 ? '' : 's'} (rpc ids: ${rpcs.map(r => r === '?' ? 'none' : r).join(', ')}; largest part ${biggest} chars${odd.length ? `; other markers: ${odd.join(', ')}` : ''})`;
}

/** Which tier this account is on, as the two numbers the model header needs. Read from the
 *  account's own flags rather than guessed from a plan name. */
function gwCapacity(tier, caps) {
  if (tier.includes(21)) return { capacity: 1, capacityField: 13 };
  if (tier.includes(22)) return { capacity: 2, capacityField: 13 };
  if (caps.includes(115)) return { capacity: 4, capacityField: 12 };   // Plus
  if (tier.includes(16) || caps.includes(106)) return { capacity: 3, capacityField: 12 };
  return { capacity: tier.includes(8) || caps.includes(19) ? 2 : 1, capacityField: 12 };
}

/** One entry of that list, as something a person can pick in Options.
 *
 *  The entry's own fields are sparse and have moved between site versions, so each is read from
 *  wherever the site currently keeps it: the two places the site is known to put a category, the
 *  two it puts a display name, and the two it puts the routing number. The display name is
 *  preferred for the public name because it is the one the person actually sees on the site. */
function gwModel(entry) {
  if (!Array.isArray(entry) || !entry.length) return null;
  const id = gwPath(entry, [0], '');
  if (!id || typeof id !== 'string') return null;

  const category = String(gwPath(entry, [1], '') || gwPath(entry, [10], ''));
  const display = String(gwPath(entry, [11], '') || gwPath(entry, [19], '') || gwPath(entry, [1], '') || category);
  const description = String(gwPath(entry, [12], '') || gwPath(entry, [2], ''));
  const number = gwPath(entry, [17]);
  const secondary = gwPath(entry, [9]);

  // A routing number the site actually stated but which is unusable (not a positive integer)
  // means this entry cannot be asked for by index, so it is left out rather than defaulted —
  // the entry name and number must agree or the site answers with the wrong model.
  if (number !== null && number !== undefined && (!Number.isInteger(number) || number <= 0)) return null;
  const modelNumber = Number.isInteger(number) ? number : (Number.isInteger(secondary) ? secondary : 1);

  // The name the site shows ("Flash", "Pro", "2.5 Pro"), in the shape the rest of this
  // extension already uses for Google's models: one `gemini-` prefix and the version kept.
  const name = `gemini-${gwSlug(display || category || id)}`;

  return {
    id, name,
    label: display || category || name,
    description,
    number: modelNumber,
  };
}

/** The whole list, with the repeats taken out. The site lists some ids under more than one
 *  entry, and a name that would collide is given the id's first characters so the two stay
 *  distinguishable in Options — choosing either one has to select the entry it came from. */
function gwModelList(entries) {
  const out = [];
  const seenId = new Set();
  const seenName = new Set();
  for (const entry of entries) {
    const m = gwModel(entry);
    if (!m || seenId.has(m.id)) continue;
    seenId.add(m.id);
    if (seenName.has(m.name)) m.name = `${m.name}-${m.id.slice(0, 8).toLowerCase()}`;
    seenName.add(m.name);
    out.push(m);
  }
  return out;
}

/** A model's display name reduced to the middle of a model id. Dots survive because they are
 *  part of a version — dropping them turns "2.5 Pro" into "2-5-pro", which is not the name. */
function gwSlug(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^gemini-/, '')
    .replace(/^-+|-+$/g, '');
}

/** One question. Returns the answer text, what the model was thinking if it says, and why it
 *  stopped — in the same shape every other provider in this extension returns. */
async function gwGenerate(session, opts) {
  const { prompt, model, thinking, fileData, chat } = opts;
  const modelNumber = model?.number || 1;
  const level = gwThinkingLevel(thinking);

  // An 81-slot body where only the slots the site fills are written, and everything else stays
  // null. This is the same layout the page's own bundle builds; the gaps are not ours to fill.
  const inner = new Array(81).fill(null);
  const uuid = gwSessionId();
  inner[0] = [prompt, 0, null, fileData || null, null, null, 0];
  inner[1] = [session.hl];
  inner[2] = gwChatMetadata(chat);
  inner[6] = [1];
  inner[7] = 1;                    // streaming
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = uuid;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelNumber;
  inner[80] = level;

  // The model header carries its own copy of the model number, and the site's bundle extends
  // it with the thinking level and the session id before sending. Both are mirrored here.
  const headers = model ? gwModelHeaders(model.id, model.capacity, model.capacityField, model.number) : {};
  if (headers[GW_MODEL_HEADER]) {
    const parsed = JSON.parse(headers[GW_MODEL_HEADER]);
    const last = parsed[parsed.length - 1];
    if (Number.isInteger(last)) inner[79] = last;
    parsed.push(level);
    parsed.push(uuid);
    headers[GW_MODEL_HEADER] = JSON.stringify(parsed);
  }

  const params = new URLSearchParams({ hl: session.hl, _reqid: String((gwReqId += 100000)), rt: 'c' });
  if (session.bl) params.set('bl', session.bl);
  if (session.sid) params.set('f.sid', session.sid);

  const res = await fetch(gwUrl(`${GW_GENERATE_PATH}?${params}`, session.account), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      'x-goog-ext-525005358-jspb': `["${uuid}",1]`,
      ...headers,
    },
    body: `at=${encodeURIComponent(session.at || '')}&f.req=${encodeURIComponent(
      JSON.stringify([null, JSON.stringify(inner)]))}`,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: String(detail).slice(0, 300) };
  }

  const parts = gwFrames(await res.text());
  let text = '', thoughts = '', cid = '', rid = '', rcid = '', done = false, code = 0;

  for (const part of parts) {
    // A refusal is reported as a BardErrorInfo block beside the number that says which one.
    // The direct path below covers the shape seen most often; the walk is the fallback for
    // the versions that move it, which is most of them.
    const err = gwPath(part, [5, 2, 0, 1, 0]) || gwBardError(part);
    if (err) { code = err; continue; }

    const raw = gwPath(part, [2]);
    if (!raw) continue;
    let body;
    try { body = JSON.parse(raw); } catch { continue; }

    const meta = gwPath(body, [1]);
    if (meta) {
      if (gwPath(meta, [0])) cid = gwPath(meta, [0]);
      if (gwPath(meta, [1])) rid = gwPath(meta, [1]);
    }

    // Most turns arrive as a candidate list in slot 4. Some tools instead stream numbered
    // field updates — `[null, ["c_…","r_…"], {"7": ["text"]}]` — with no candidates at all,
    // and the answer then sits in that dict's "7".
    const streamed = gwPath(body, [2, '7', 0]);
    if (typeof streamed === 'string' && streamed) text = streamed;

    const candidates = gwPath(body, [4], []);
    if (!Array.isArray(candidates) || !candidates.length) continue;
    for (const cand of candidates) {
      const id = gwPath(cand, [0]);
      if (!id) continue;
      rcid = id;
      const t = gwCandidateText(cand);
      if (t) text = t;
      const th = gwPath(cand, [37, 0, 0]);
      if (typeof th === 'string' && th) thoughts = th;
      if (gwPath(cand, [8, 0]) === 2) done = true;   // 2 is "this turn is finished"
    }
  }

  // Where the reasoning is not a field of its own it is woven into the text between two
  // control characters, and has to be cut out of the answer rather than shown as part of it.
  const split = gwSplitThinking(text);
  if (split.thoughts) { thoughts = split.thoughts; text = split.text; }

  return { ok: true, text, thoughts, done, code, cid, rid, rcid };
}

/** The failure code inside a `BardErrorInfo` block, or 0 when the frame holds none. The block
 *  sits at a different depth in each version of the site, so the frame is walked branch by
 *  branch rather than addressed. The payload is a JSON *string* holding JSON, so a string that
 *  parses is walked too — otherwise the block is seen and the number that goes with it is not.
 *  -1 means the block was there and carried no number, which is still a failure. */
function gwBardError(part) {
  for (const branch of Array.isArray(part) ? part : []) {
    const codes = [];
    let block = false;
    const walk = v => {
      if (Array.isArray(v)) { for (const child of v) walk(child); return; }
      if (v && typeof v === 'object') { for (const child of Object.values(v)) walk(child); return; }
      if (typeof v === 'number') { codes.push(v); return; }
      if (typeof v !== 'string') return;
      // The payload arrives as a string of JSON, so the block inside it — and the number that
      // goes with the block — is only reachable by parsing it. A string that is not JSON is
      // just text, and is only checked for the marker itself.
      if (v.length && (v[0] === '[' || v[0] === '{')) {
        try { walk(JSON.parse(v)); return; } catch { /* not JSON after all */ }
      }
      // Numbers from elsewhere in the frame are not the block's, so the list starts again
      // where the block does; the first number after the marker is the code.
      if (v.includes('BardErrorInfo')) { block = true; codes.length = 0; }
    };
    walk(branch);
    if (block) return codes.length ? codes[0] : -1;
  }
  return 0;
}

/** The two markers the site fences its reasoning with. The word after the opening one is part
 *  of the marker, not of the thought, so it is dropped. */
const GW_THOUGHT_OPEN = ['<ctrl94>thought', '<ctrl94>'];
const GW_THOUGHT_CLOSE = '<ctrl95>';

/** Pull the reasoning out of an answer that carries it inline. A marker with no closing one
 *  means the reply stopped mid-thought, which still leaves the text before it as the answer. */
function gwSplitThinking(raw) {
  const s = String(raw || '');
  let at = -1, open = '';
  for (const marker of GW_THOUGHT_OPEN) {
    const i = s.indexOf(marker);
    if (i !== -1) { at = i; open = marker; break; }
  }
  if (at === -1) return { thoughts: '', text: s };

  const close = s.indexOf(GW_THOUGHT_CLOSE, at + open.length);
  if (close === -1) {
    return { thoughts: s.slice(at + open.length).trim(), text: s.slice(0, at).trim() };
  }
  return {
    thoughts: s.slice(at + open.length, close).trim(),
    text: (s.slice(0, at) + s.slice(close + GW_THOUGHT_CLOSE.length)).trim(),
  };
}

/* -------------------------------------------------------------- what the worker asks for */

const GW_ERRORS = {
  1013: 'the site had a temporary error — trying again may work',
  1037: 'this account is out of Gemini allowance for now — wait, or pick another service',
  1050: 'the model no longer matches this conversation — start a fresh one',
  1052: 'the site would not accept the model header — the model list needs refreshing',
  1060: 'the site has temporarily blocked this network address',
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const run = async () => {
    switch (msg?.type) {
      case 'gw-ping':
        return { ok: true };
      case 'gw-init':
        return { ok: true, session: await gwInit() };
      case 'gw-models':
        return { ok: true, ...(await gwModels(msg.session)) };
      case 'gw-generate': {
        const out = await gwGenerate(msg.session, msg);
        if (out.ok && out.code) {
          // -1 is a block that named itself but carried no number, which is a refusal all the
          // same and should not be reported as "error -1".
          const words = out.code === -1
            ? 'the site refused the question without saying why — the login may have expired'
            : GW_ERRORS[out.code] || `the site reported error ${out.code}`;
          dbg('warn', 'the site refused the question', { code: out.code, words });
          return { ok: true, text: '', failure: words, code: out.code };
        }
        if (!out.ok) dbg('warn', 'the site did not answer', { status: out.status, detail: String(out.detail || '').slice(0, 240) });
        return out;
      }
      default:
        return { ok: false, detail: `unknown request ${msg?.type}` };
    }
  };

  run().then(respond).catch(e => {
    dbg('error', 'the gemini relay threw', { request: msg?.type, message: String(e && (e.message || e)), stack: String(e && e.stack || '').slice(0, 600) });
    respond({ ok: false, detail: String(e?.message || e) });
  });
  return true;   // the reply comes later
});

// Tell the worker this tab is ready to be used, so a tab opened for the job is not polled for.
chrome.runtime.sendMessage({ type: 'gw-ready' }).catch(() => { /* no worker listening yet */ });

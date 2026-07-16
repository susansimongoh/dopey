// Shared logic for the SPS Media Monitor cloud backend (Netlify Functions).
// Mirrors launch_server.py but uses Supabase for storage instead of local disk.

const SUPA_URL = () => Netlify.env.get('SUPABASE_URL');
const SUPA_KEY = () => Netlify.env.get('SUPABASE_ANON_KEY');
// Per-project API keys: each listening project (sps, toteboard, …) can have its own
// Gemini/Apify credentials for separate billing, quota and blast radius, all on one
// deployment. Look up <BASE>_<PROJECT> first (e.g. GEMINI_API_KEY_TOTEBOARD), fall
// back to the shared <BASE> so existing single-key setups (SPS) keep working.
const envSuffix = (project) => String(project || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
const projEnv = (base, project) => {
  const s = envSuffix(project);
  return (s && Netlify.env.get(`${base}_${s}`)) || Netlify.env.get(base);
};
const APIFY_TOKEN = (project) => projEnv('APIFY_TOKEN', project);
const GEMINI_KEY = (project) => projEnv('GEMINI_API_KEY', project);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Supabase REST helpers ────────────────────────────────────────────────
// Strip lone UTF-16 surrogates (e.g. an emoji cut in half by a slice). Postgres
// jsonb rejects \uXXXX lone-surrogate escapes with PGRST102 "invalid json", so we
// clean every string value DURING serialization (a JSON replacer sees raw code
// units before they're escaped — a post-stringify regex can't, they're text by then).
const stripSurrogates = (v) =>
  typeof v === 'string' ? v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') : v;
// safe-serialize any value for a Supabase write
export const sjson = (o) => JSON.stringify(o, (k, v) => stripSurrogates(v));

// supa(path, opts) — pass opts.json (an object/array) for writes and it's
// ALWAYS serialized safely; this is the single choke point so no write path can
// re-introduce the lone-surrogate bug.
async function supa(path, opts = {}) {
  const { json, ...rest } = opts;
  const body = json !== undefined ? sjson(json) : opts.body;
  const r = await fetch(SUPA_URL() + '/rest/v1/' + path, {
    ...rest,
    body,
    headers: {
      apikey: SUPA_KEY(), Authorization: 'Bearer ' + SUPA_KEY(),
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

// All storage is namespaced by project (default 'sps' = legacy SPS data).
const PROJ = (p) => (p || 'sps');

export async function getDay(project, date) {
  const rows = await supa(`monitor_days?project=eq.${PROJ(project)}&date=eq.${date}&select=payload`);
  return rows && rows[0] ? rows[0].payload : null;
}

export async function putDay(project, day) {
  await supa('monitor_days', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    json: [{ project: PROJ(project), date: day.date, payload: day, updated_at: new Date().toISOString() }],
  });
}

export async function listDays(project) {
  const rows = await supa(`monitor_days?project=eq.${PROJ(project)}&select=date,payload&order=date.desc`);
  return (rows || []).map((r) => {
    const d = r.payload || {};
    return {
      date: r.date,
      clips: (d.clips || []).length,
      stories: (d.stories || []).length,
      fetched_at: d.fetched_at || null,
      social_fetched_at: d.social_fetched_at || null,
    };
  });
}

export async function listProjects() {
  const rows = await supa(`monitor_config?key=eq.projects&select=value`);
  return (rows && rows[0] && rows[0].value) || [{ id: 'sps', name: 'Singapore Prison Service', logo: null }];
}
export async function putProjects(list) {
  await supa('monitor_config', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    json: [{ key: 'projects', value: list, updated_at: new Date().toISOString() }] });
}

export async function getWatchlist(project) {
  const p = PROJ(project);
  const rows = await supa(`monitor_config?key=eq.watchlist:${p}&select=value`);
  // Stamp the project onto cfg so any function holding cfg can resolve per-project
  // keys / prompts without threading `project` through every call site.
  if (rows && rows[0] && rows[0].value) return { ...rows[0].value, project: p };
  // legacy fallback: the original single-project key
  const old = await supa(`monitor_config?key=eq.watchlist&select=value`);
  return { ...((old && old[0] && old[0].value) || { lookback_days: 2, posts_per_account: 3, keywords: [], accounts: {} }), project: p };
}

export async function putWatchlist(project, cfg) {
  await supa('monitor_config', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    json: [{ key: `watchlist:${PROJ(project)}`, value: cfg, updated_at: new Date().toISOString() }],
  });
}

// ── Auth: users + roles ──────────────────────────────────────────────────
// Roles: 'tmg_admin' (everything incl. user management), 'tmg_user' (edit
// sources/keywords/clips/stories, no user mgmt), 'client' (view only).
// Users live in monitor_config key='users' as [{email,name,role,hash}]. The
// password hash is sha256(email:password:PEPPER) where PEPPER = ADMIN_TOKEN
// (server-only) — so even if the hash list leaks via the anon key it can't be
// brute-forced without the pepper. Session tokens are HMAC-signed (same secret).
const PEPPER = () => Netlify.env.get('ADMIN_TOKEN') || 'tmg-pepper';
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function hashPassword(email, password) {
  const d = await crypto.subtle.digest('SHA-256', enc(`${(email || '').toLowerCase()}:${password}:${PEPPER()}`));
  return hex(d);
}
async function hmacHex(payload) {
  const key = await crypto.subtle.importKey('raw', enc(PEPPER()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc(payload)));
}
export async function makeToken(email, role) {
  const payload = `${(email || '').toLowerCase()}|${role}`;
  return Buffer.from(payload).toString('base64url') + '.' + (await hmacHex(payload));
}
export async function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  let payload; try { payload = Buffer.from(b64, 'base64url').toString(); } catch { return null; }
  if ((await hmacHex(payload)) !== sig) return null;
  const [email, role] = payload.split('|');
  return { email, role };
}
export async function getUsers() {
  const rows = await supa(`monitor_config?key=eq.users&select=value`);
  return (rows && rows[0] && rows[0].value) || [];
}
export async function putUsers(list) {
  await supa('monitor_config', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    json: [{ key: 'users', value: list, updated_at: new Date().toISOString() }],
  });
}
export async function findUser(email) {
  return (await getUsers()).find((x) => x.email.toLowerCase() === (email || '').toLowerCase()) || null;
}

// ── Story generation (server-side mirror of the client's generateStories) ──
// Kept in sync with sps-monitor.html so /api/regen rebuilds days atomically in
// the backend (no browser, no page-state races).
const _normHandle = (s) => (s || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Per-project categorisation, driven by the project's watchlist:
//   cfg.own_accounts = { handle: subOrg }  → those posts go to Social Media Updates
//   cfg.care_partners = [handle, ...]      → those posts go to the partner/CARE section
const ownOrg = (cfg, h) => ((cfg && cfg.own_accounts) || {})[_normHandle(h)] || null;
const isCarePartner = (cfg, h) => (((cfg && cfg.care_partners) || []).includes(_normHandle(h)));
const CAT_KEYS = ['issues', 'daily_news', 'yellow_ribbon', 'care_network', 'social_updates', 'fyi'];
const _uniq = (a) => [...new Set(a.filter(Boolean))];
const _tokens = (c) => new Set(String(c.subject || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const _jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i); };
const PHRASE_STOP = new Set(['yellow ribbon', 'yellow ribbon singapore', 'yellow ribbon project', 'yellow ribbon community', 'singapore prison', 'prison service', 'singapore prison service', 'home team', 'ministry of home affairs', 'captains of lives', 'second chances', 'changi prison', 'changi prison complex']);
const _phrases = (c) => { const m = String(c.subject || '').match(/\b([A-Z][A-Za-z]+(?:\s+(?:of\s+|the\s+)?[A-Z][A-Za-z]+)+)\b/g) || []; const out = new Set(); m.forEach((p) => { const k = p.toLowerCase().replace(/\s+/g, ' ').trim(); if (k.split(' ').length >= 2 && !PHRASE_STOP.has(k)) out.add(k); }); return out; };
const _share = (a, b) => { for (const p of a) if (b.has(p)) return true; return false; };
function _cluster(clips) {
  const toks = clips.map(_tokens), phr = clips.map(_phrases);
  const parent = clips.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
    const sameLink = clips[i].link && clips[i].link === clips[j].link;
    if (sameLink || _jaccard(toks[i], toks[j]) >= 0.5 || _share(phr[i], phr[j])) union(i, j);
  }
  const g = {}; clips.forEach((c, i) => { const r = find(i); (g[r] = g[r] || []).push(c); });
  return Object.values(g);
}

// Rebuild day.stories from day.clips. Preserves hand-edited/manual stories and
// reuses prior auto drafts that already have a real LLM summary (by clip overlap);
// only genuinely-new clusters hit Gemini. Caption fallbacks are tagged llm:false
// so they self-heal on a later run. Mutates and returns `day`.
export async function rebuildStories(day, cfg) {
  cfg = cfg || {};
  const clips = day.clips || [];
  day.stories = day.stories || [];
  const kept = day.stories.filter((s) => !s.auto || s.edited);
  const keptIds = new Set(kept.flatMap((s) => s.clipIds || []));
  const norm = (t) => String(t || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  const isDraft = (s) => s.llm === false || (s.llm === undefined && norm(s.hl) === norm(s.summary));
  const prevReal = day.stories.filter((s) => s.auto && !s.edited && !isDraft(s));
  const pool = clips.filter((c) => !keptIds.has(c.id));
  const clusters = _cluster(pool);
  const matchPrev = (g) => { const ids = new Set(g.map((c) => c.id)); return prevReal.find((s) => (s.clipIds || []).some((id) => ids.has(id))); };
  const fresh = clusters.filter((g) => !matchPrev(g));

  const byIdx = {};
  if (fresh.length) {
    try {
      const items = fresh.map((g, i) => ({ key: String(i), pub: _uniq(g.map((c) => c.pub)).join(', '), platforms: _uniq(g.map((c) => c.plat).filter(Boolean)).join(', '), texts: g.map((c) => (c.subject || '') + (c.extra ? ` [text read from image/video: ${c.extra}]` : '')).filter(Boolean) }));
      (await summarizeItems(items, cfg && cfg.project) || []).forEach((r, i) => { byIdx[i] = r; });
    } catch (e) { /* caption fallback below */ }
  }

  const built = []; let made = 0;
  clusters.forEach((group) => {
    const reported = _uniq(group.filter((c) => !c.plat).map((c) => c.pub)).join(', ');
    const published = _uniq(group.filter((c) => c.plat).map((c) => `${c.pub} (${c.plat})`)).join(', ');
    const clipIds = group.map((c) => c.id);
    const prev = matchPrev(group);
    if (prev) { built.push({ ...prev, reported, published, clipIds }); return; }
    const i = fresh.indexOf(group);
    const sum = byIdx[i];
    const llm = !!(sum && sum.summary);
    const rep = group.slice().sort((a, b) => (b.subject || '').length - (a.subject || '').length)[0];
    const capt = (rep.subject || '').trim();
    const cp = [...capt];
    const hl = (sum && sum.headline) ? sum.headline : (cp.length > 130 ? cp.slice(0, 130).join('') + '…' : capt);
    const summary = (sum && sum.summary) ? sum.summary : capt;
    if (!hl) return;
    let cat, subOrg = '';
    const org = group.map((c) => ownOrg(cfg, c.kw) || ownOrg(cfg, c.pub)).find(Boolean);
    if (org) { cat = 'social_updates'; subOrg = org; }
    else if (group.some((c) => isCarePartner(cfg, c.kw) || isCarePartner(cfg, c.pub))) { cat = 'care_network'; }
    else { cat = (sum && CAT_KEYS.includes(sum.category)) ? sum.category : 'daily_news'; if (cat === 'social_updates') cat = 'daily_news'; }
    built.push({ id: 's' + Date.now().toString(36) + made, clipIds, cat, subOrg, hl, summary, reported, syndicated: '', published, llm, trInt: '', trCom: '', trNote: '', auto: true });
    made++;
  });
  day.stories = [...kept, ...built];
  return day;
}

export function freshDay(date) {
  return {
    date, fetched_at: null, social_fetched_at: null,
    cfg: { num: '', date: '', highlights: '1. XXX', issues: '1. XXX', fyi: '1. XXX' },
    clips: [], stories: [], dismissed: [],
  };
}

// ── tiny helpers ─────────────────────────────────────────────────────────
async function httpText(url, timeout = 12000) {
  const ctrl = AbortSignal.timeout(timeout);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function httpJson(url, timeout = 12000) {
  return JSON.parse(await httpText(url, timeout));
}
async function sha1_12(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
const decode = (s) => (s || '')
  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };
const blocks = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>[\\s\\S]*?</${name}>`, 'g')) || [];

// ── relevance ────────────────────────────────────────────────────────────
const SPS_CORE_TERMS = [
  // 'changi prison' not bare 'changi' — broad outlet feeds otherwise match Changi
  // Airport / Pasir Ris-Changi / Changi General Hospital (the area, not the prison).
  'prison', 'sps', 'changi prison', 'death penalt', 'death row', 'capital punishment',
  'execution', 'executed', 'gallows', 'hanged', 'hanging', 'noose', 'clemency',
  'death sentence', 'sentenced to death', 'mandatory death', 'drug mule', 'caning',
  'yellow ribbon', 'rehabilitat', 'ex-offender', 'reintegrat', 'inmate', 'remand',
  'parole', 'incarcerat', 'correctional', 'captain of lives', 'drug traffick',
  'cnb', 'narcotics', 'anti-death', 'second chance', 'halfway house', 'desistor',
  'maximum security', 'prisoner', 'yrsg',
];
function topicTerms(cfg) {
  const t = new Set((cfg.topic_terms || SPS_CORE_TERMS).map((x) => x.toLowerCase()));
  for (const kw of cfg.keywords || []) t.add(kw.q.toLowerCase());
  return t;
}
// Word-boundary match: a Latin term must START at a word boundary (it may still be
// a prefix of a longer word, e.g. 'rehabilitat' → 'rehabilitation', 'death penalt'
// → 'death penalty'). This stops substring false positives like 'hanging' inside
// "changing" or 'hanged' inside "changed". CJK/non-Latin terms (e.g. Chinese
// '监狱', Malay terms behave like Latin) have NO \b boundary between ideographs, so
// `\b监狱` never matches — for any term without a Latin letter we match as a plain
// substring instead.
const relevant = (text, terms) => {
  const low = (text || '').toLowerCase();
  for (const t of terms) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = /[a-z]/i.test(t) ? new RegExp('\\b' + esc) : new RegExp(esc);
    if (re.test(low)) return true;
  }
  return false;
};

// Per-project relevance with a localisation gate. An item is relevant if it
// matches an ANCHOR (a self-localising term that passes alone, e.g. "Changi
// Prison", "SPS", "Yellow Ribbon"), OR it matches a generic TOPIC term
// (e.g. "prison", "death penalty") AND ALSO carries a LOCALE signal in the same
// text (e.g. "Singapore", "Changi", "MHA"). This keeps foreign/global prison &
// death-penalty content out (which generic terms alone would let in). If a
// project has no `locale` list configured, topics pass alone (legacy behaviour,
// so non-localised projects keep working until they're set up).
// Singapore vernacular outlets (Chinese / Malay). SG vernacular court headlines
// rarely write the country name (it's implied), so a locale-WORD gate drops them;
// and a "skip locale" gate lets in Malaysian/Indonesian vernacular news from the
// same query. The reliable Singapore signal for vernacular items is therefore the
// OUTLET: trust SG vernacular mastheads, drop Malaysian (Astro Awani, Harian
// Metro, FMT) and other foreign ones. Matched as a lowercased substring of source.
const SG_VERN_OUTLETS = [
  'berita mediacorp', 'beritamediacorp', 'beritaharian', 'berita harian', 'bharian',
  '8world', '8视界', '8 world', 'shin min', '新明日报', '新明', 'zaobao', '联合早报',
  'lianhe zaobao', 'tabla', 'tamil murasu', 'tamilmurasu',
];
const isSgVernOutlet = (pub) => { const p = (pub || '').toLowerCase(); return SG_VERN_OUTLETS.some((o) => p.includes(o)); };
// English SG news mastheads. Their social posts must be gated like NEWS (topic +
// Singapore signal), NOT like a curated activist account — these outlets run large
// WORLD desks, so a topic-only gate would let their foreign court/prison posts in.
// Handles vary per platform (FB=display name, IG/X=username), so list both forms.
const EN_OUTLETS = [
  'channel newsasia', 'channelnewsasia', 'cna', 'straits times', 'straitstimes', 'stcom',
  'todayonline', 'today', 'business times', 'businesstimes', 'biztimes',
  'mothership', 'asiaone',
];
// True when a source name is any SG news outlet (English or vernacular).
const isNewsOutlet = (pub) => { const p = (pub || '').toLowerCase(); return EN_OUTLETS.some((o) => p.includes(o)) || isSgVernOutlet(pub); };

function makeRelevance(cfg) {
  const lc = (a) => (a || []).filter(Boolean).map((s) => String(s).toLowerCase());
  const anchors = lc([...(cfg.anchors || []), ...((cfg.keywords || []).map((k) => k.q))]);
  const topics = lc(cfg.topics || cfg.topic_terms || SPS_CORE_TERMS);
  const locale = lc(cfg.locale);
  // (text, pub, skipLocale, vern) → relevant?
  //   text       = caption/headline + any OCR/subtitle text
  //   pub        = source name — the locale signal for vernacular items
  //   skipLocale = item already known SG-scoped, topic alone suffices. True for
  //                (a) social posts from curated SG accounts and (b) news from an
  //                SG-scoped English keyword (localTrust, e.g. "Singapore jailed").
  //   vern       = Chinese/Malay item — gate on topic + SG vernacular OUTLET
  //                (a locale word won't appear; "skip locale" would admit Malaysia).
  return (text, pub, skipLocale, vern) => {
    if (anchors.length && relevant(text, anchors)) return true;
    if (!relevant(text, topics)) return false;
    // Vernacular: must be an SG masthead AND contain a Singapore locale word.
    // SG mastheads also cover international news in Malay/Chinese (e.g. Berita
    // Harian reporting Korean/Saudi/Myanmar stories), so masthead trust alone leaks
    // foreign content. Requiring a locale co-signal drops those while keeping SG
    // stories (which almost always contain "Singapura", "Changi", "SPS", etc.).
    if (vern) return isSgVernOutlet(pub) && (!locale.length || relevant(text, locale));
    if (!locale.length) return true;       // project not localised → legacy behaviour
    if (skipLocale) return true;           // already SG-scoped → topic suffices
    return relevant(text, locale);         // else news → needs a Singapore locale word
  };
}

// A post self-passes the keyword-relevance gate ONLY when it's an actual SOCIAL post
// from an SPS/YRSG OWN account (everything they publish is in scope by definition).
// News items must NOT qualify — their `kw` is a search phrase like "Singapore Prison
// Service" that would otherwise look like an own-account handle.
// CARE partners (Prison Fellowship, SANA, SACA, …) are NOT self-passed: their SPS-
// relevant work hits a topic term and passes normally, but their internal staff /
// devotional / appreciation posts (e.g. "celebrate Jensen") should not clip. They
// still route to the care_network section (categorisation) when they do pass.
const SOCIAL_PLATS = new Set(['Facebook', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn', 'X']);
const ownPost = (cfg, it) => SOCIAL_PLATS.has(it.plat) &&
  !!(ownOrg(cfg, it.kw) || ownOrg(cfg, it.pub));

// Convert a fetched item to a clip (the evidence-log shape used everywhere).
function itemToClip(it) {
  return {
    id: it.id, date: (it.published || '').slice(0, 10) || null,
    pub: it.pub, plat: it.plat || (it.src === 'Reddit' ? 'Reddit' : ''),
    subject: it.title, link: it.link, cat: it.cat || 'daily_news',
    src: it.src, kw: it.kw, eng: it.eng || null, traction: it.traction || null,
    shot: it.img || null, published: it.published || null,
    extra: it.extra || '',   // OCR / subtitle text read out of the image/video
    ...(it.newsOutlet ? { newsOutlet: true } : {}),   // news-outlet social post (gated as news)
    ...(it.discovered ? { discovered: true } : {}),  // found via keyword search, not account sweep
    ...(it.audioUrl ? { audioUrl: it.audioUrl } : {}),  // transient: reel audio for post-gate Gemini transcription (stripped after)
  };
}

// Merge fetched results straight into day.clips: keep only on-watchlist,
// SPS-relevant items; skip ones already clipped or previously deleted.
export function mergeClips(day, results, cfg) {
  const valid = new Set((cfg.keywords || []).map((k) => k.q));
  for (const hs of Object.values(cfg.accounts || {})) for (const h of hs) valid.add('@' + h);
  // Keywords flagged localTrust are SG-scoped queries ("Singapore jailed", a
  // vernacular SG outlet, …) — their results are Singapore by construction, so
  // they skip the locale co-signal (a topic match is enough).
  const trustKw = new Set((cfg.keywords || []).filter((k) => k.localTrust).map((k) => k.q));
  // `locale_strict` accounts are curated handles that ALSO post regional/foreign news
  // (Plan_B, Wake Up SG, TOC…). They must carry a Singapore locale word to pass, so
  // their foreign court/jail posts (e.g. "Indonesian minister jailed") don't clip.
  const localeStrict = new Set((cfg.locale_strict || []).map(_normHandle));
  const isStrict = (it) => localeStrict.has(_normHandle(it.kw)) || localeStrict.has(_normHandle(it.pub));
  // A social post skips the locale co-signal ONLY if it's from a curated activist/
  // org account (locale implied). A NEWS-OUTLET social post is gated like news
  // (its masthead runs a world desk), a vernacular outlet uses the masthead path,
  // and a locale_strict account never skips.
  const skipLocaleFor = (it) => !isStrict(it) && ((SOCIAL_PLATS.has(it.plat) && !it.newsOutlet && !isNewsOutlet(it.pub)) || !!it.localTrust || trustKw.has(it.kw));
  const vernFor = (it) => !!it.vern || isSgVernOutlet(it.pub) || /[㐀-鿿]/.test(it.title || '');
  const isRelevant = makeRelevance(cfg);
  day.clips = day.clips || [];
  day.dismissed = day.dismissed || [];
  const have = new Set(day.clips.map((c) => c.id));
  const haveLinks = new Set(day.clips.map((c) => c.link).filter(Boolean));
  const gone = new Set(day.dismissed);
  for (const it of results) {
    if (have.has(it.id) || gone.has(it.id)) continue;
    if (it.link && haveLinks.has(it.link)) continue;          // same URL = true duplicate
    // Social posts come ONLY from configured accounts (we scrape the watchlist
    // handles), so they're on-watchlist by construction — skip the keyword
    // membership check (FB/X return display names, not the config slug, so an
    // exact-match check wrongly drops every one of them). Outlet RSS items are
    // trusted by source. Everything else (news) must hit a configured keyword.
    if (!it.outlet && !SOCIAL_PLATS.has(it.plat) && !valid.has(it.kw)) continue;
    // SPS/YRSG own posts and CARE-partner posts are intrinsically in scope (their
    // own activity); everyone else (other accounts + news) must be SPS-relevant
    // — checked against caption PLUS any OCR/subtitle text read from the media.
    if (!ownPost(cfg, it) && !isRelevant((it.title || '') + ' ' + (it.extra || ''), it.pub, skipLocaleFor(it), vernFor(it))) continue;
    have.add(it.id); if (it.link) haveLinks.add(it.link);
    day.clips.push(itemToClip(it));
  }
  day.clips.sort((a, b) => (b.published || b.date || '').localeCompare(a.published || a.date || ''));
}

// Remove already-stored AUTO-fetched clips that no longer pass the gate (used to
// clean up clips added before a relevance fix). Manually-added clips (no `src`)
// are always kept. Own/CARE posts are exempt, same as mergeClips.
export function pruneClips(day, cfg) {
  const isRelevant = makeRelevance(cfg);
  const trustKw = new Set((cfg.keywords || []).filter((k) => k.localTrust).map((k) => k.q));
  const localeStrict = new Set((cfg.locale_strict || []).map(_normHandle));
  const isStrict = (c) => localeStrict.has(_normHandle(c.kw)) || localeStrict.has(_normHandle(c.pub));
  const before = (day.clips || []).length;
  day.clips = (day.clips || []).filter((c) => {
    if (!c.src) return true;          // manually added → keep
    if (ownPost(cfg, c)) return true; // own SPS/YRSG social post → in scope (CARE partners gated)
    const skipLocale = !isStrict(c) && ((SOCIAL_PLATS.has(c.plat) && !c.newsOutlet && !isNewsOutlet(c.pub)) || trustKw.has(c.kw));
    // vernacular item: has CJK text, or came from an SG vernacular masthead
    const vern = /[㐀-鿿]/.test(c.subject || '') || isSgVernOutlet(c.pub);
    return isRelevant((c.subject || '') + ' ' + (c.extra || ''), c.pub, skipLocale, vern);
  });
  return before - (day.clips || []).length;
}

// ── news / reddit / youtube fetchers ─────────────────────────────────────
async function googleNews(kw, lookback, cutoff) {
  // NOT quoted: an exact-phrase query ("Changi Prison") matches almost nothing
  // (Google returns bus stops / rugby / foreign noise and ~0 real SG prison
  // stories). An unquoted AND-query ("Changi Prison") recalls the actual SG court/
  // prison coverage; the localisation gate in mergeClips then drops the foreign
  // results (it strips Google's " - Source" title suffix first, so a story from a
  // Singapore-NAMED outlet doesn't pass on the source name alone).
  // kw.lang selects the Google News edition: default English (en-SG); 'ms' pulls
  // the Malay edition (ms-SG), which surfaces Berita Mediacorp / Berita Harian
  // court coverage. (A Chinese zh-SG edition is not served by Google News, so
  // Shin Min / 8World are reached via their RSS feeds instead.) Items from a
  // non-English edition are flagged `vern` → gated on topic + SG vernacular outlet.
  const ED = { ms: { hl: 'ms-SG', ceid: 'SG:ms' } };
  const ed = ED[kw.lang] || { hl: 'en-SG', ceid: 'SG:en' };
  const vern = !!kw.lang && kw.lang !== 'en';
  const q = encodeURIComponent(`${kw.q} when:${lookback}d`);
  const xml = await httpText(`https://news.google.com/rss/search?q=${q}&hl=${ed.hl}&gl=SG&ceid=${ed.ceid}`);
  const out = [];
  for (const it of blocks(xml, 'item')) {
    const title0 = tag(it, 'title'); const link = tag(it, 'link');
    const pub = tag(it, 'source'); const pd = tag(it, 'pubDate');
    const dt = pd ? new Date(pd) : null;
    if (!title0 || !link || !dt || dt < cutoff) continue;
    let title = title0;
    if (pub && title.endsWith(' - ' + pub)) title = title.slice(0, -(' - ' + pub).length);
    out.push({ id: await sha1_12(link), src: 'Google News', kw: kw.q, cat: kw.cat || 'daily_news',
      title, link, pub: pub || 'Unknown', plat: '', published: dt.toISOString(), eng: null, vern, status: 'new' });
  }
  return out;
}

async function bingNews(kw, cutoff) {
  const q = encodeURIComponent(kw.q);   // unquoted — see googleNews note
  const xml = await httpText(`https://www.bing.com/news/search?q=${q}&format=rss`);
  const out = [];
  for (const it of blocks(xml, 'item')) {
    const title = tag(it, 'title'); const link = tag(it, 'link'); const pd = tag(it, 'pubDate');
    const dt = pd ? new Date(pd) : null;
    if (!title || !link || !dt || dt < cutoff) continue;
    let host = 'news'; try { host = new URL(link).hostname.replace('www.', ''); } catch {}
    out.push({ id: await sha1_12(link), src: 'Bing News', kw: kw.q, cat: kw.cat || 'daily_news',
      title, link, pub: host, plat: '', published: dt.toISOString(), eng: null, status: 'new' });
  }
  return out;
}

async function redditCombined(keywords, cutoff) {
  const q = encodeURIComponent(keywords.map((k) => `"${k.q}"`).join(' OR '));
  const xml = await httpText(`https://www.reddit.com/search.rss?q=${q}&sort=new&t=week&limit=25`);
  const out = [];
  for (const e of blocks(xml, 'entry')) {
    const title = tag(e, 'title'); const content = tag(e, 'content');
    const lm = e.match(/<link[^>]*href="([^"]+)"/); const link = lm ? decode(lm[1]) : '';
    const updated = tag(e, 'updated'); const dt = updated ? new Date(updated) : null;
    if (!title || !link || !dt || dt < cutoff) continue;
    const hay = (title + ' ' + content).toLowerCase();
    const matched = keywords.find((k) => hay.includes(k.q.toLowerCase()));
    if (!matched) continue;
    const cm = e.match(/<category[^>]*label="([^"]+)"/);
    out.push({ id: await sha1_12(link), src: 'Reddit', kw: matched.q, cat: matched.cat || 'daily_news',
      title, link, pub: 'reddit', plat: cm ? decode(cm[1]) : 'Reddit', published: dt.toISOString(), eng: null, status: 'new' });
  }
  return out;
}

const ytCache = {};
async function ytChannelId(handle) {
  if (ytCache[handle]) return ytCache[handle];
  const html = await httpText(`https://www.youtube.com/@${handle}`, 15000);
  const m = html.match(/(?:"channelId":"|"browseId":"|channel\/)(UC[0-9A-Za-z_-]{20,})/);
  if (!m) throw new Error('channelId not found');
  ytCache[handle] = m[1];
  return m[1];
}
async function youtube(handles, cutoff, errors) {
  const out = [];
  for (const h of handles) {
    try {
      const cid = await ytChannelId(h);
      const xml = await httpText(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`);
      for (const e of blocks(xml, 'entry')) {
        const title = tag(e, 'title');
        const lm = e.match(/<link[^>]*href="([^"]+)"/); const link = lm ? decode(lm[1]) : '';
        const pub = tag(e, 'published'); const dt = pub ? new Date(pub) : null;
        if (!title || !link || !dt || dt < cutoff) continue;
        const vm = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
        const views = (e.match(/views="(\d+)"/) || [])[1];
        const yeng = { plays: views ? +views : 0, likes: 0, comments: 0, shares: 0 };
        out.push({ id: await sha1_12(link), src: 'YouTube', kw: '@' + h, cat: 'daily_news',
          title, link, pub: h, plat: 'YouTube', published: dt.toISOString(),
          eng: yeng, traction: traction('YouTube', yeng),
          img: vm ? vm[1] : null, status: 'new' });
      }
    } catch (e) { errors.push(`YouTube @${h}: ${String(e).slice(0, 60)}`); }
  }
  return out;
}

// Named SG/MY news outlets from the MM Search Guide that publish a usable RSS
// feed. These are FULL feeds (all sections) — every item is filtered by the SPS
// relevance gate in mergeClips, so only SPS-relevant articles become clips.
// (AsiaOne, TODAY, Yahoo SG and Zaobao have no usable native RSS; they're already
// covered by the keyword-scoped Google News fetch.)
const OUTLET_FEEDS = [
  { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
  { name: 'The Straits Times', url: 'https://www.straitstimes.com/news/singapore/rss.xml' },
  { name: 'The Business Times', url: 'https://www.businesstimes.com.sg/rss/singapore' },
  { name: 'Mothership', url: 'https://mothership.sg/feed/' },
  { name: 'Must Share News', url: 'https://mustsharenews.com/feed/' },
  { name: 'Rice Media', url: 'https://www.ricemedia.co/feed/' },
  { name: 'Berita Harian', url: 'https://www.beritaharian.sg/rss.xml' },
  // Mediacorp vernacular desks (Chinese / Malay) — the SPS daily report draws
  // most of its court/sentencing items from these. Same Drupal RSS endpoint as
  // CNA. Items are Chinese/Malay, so the relevance gate matches them via the
  // vernacular topic+locale terms in the project config, and Gemini translates
  // them into the English report summary.
  { name: '8World', url: 'https://www.8world.com/api/v1/rss-outbound-feed?_format=xml', vern: true },
  { name: 'Berita Mediacorp', url: 'https://berita.mediacorp.sg/api/v1/rss-outbound-feed?_format=xml', vern: true },
];
async function outletFeeds(cutoff, errors) {
  const out = [];
  for (const f of OUTLET_FEEDS) {
    try {
      const xml = await httpText(f.url, 15000);
      for (const it of blocks(xml, 'item')) {
        let link = tag(it, 'link');
        if (!link) { const lm = it.match(/<link[^>]*href="([^"]+)"/); link = lm ? decode(lm[1]) : ''; }
        const title = tag(it, 'title');
        const pd = tag(it, 'pubDate') || tag(it, 'dc:date');
        const dt = pd ? new Date(pd) : null;
        if (!title || !link || !dt || isNaN(dt) || dt < cutoff) continue;
        const im = it.match(/<enclosure[^>]*url="([^"]+)"/) || it.match(/<media:content[^>]*url="([^"]+)"/) || it.match(/<media:thumbnail[^>]*url="([^"]+)"/);
        out.push({ id: await sha1_12(link), src: f.name, kw: f.name, cat: 'daily_news',
          title, link, pub: f.name, plat: '', published: dt.toISOString(),
          eng: null, img: im ? decode(im[1]) : null, outlet: true, vern: !!f.vern, status: 'new' });
      }
    } catch (e) { errors.push(`${f.name}: ${String(e).slice(0, 50)}`); }
  }
  return out;
}

// Gather + dedupe news within `lookback` days. Google/Bing keyword search were
// REMOVED (22 Jun) — the report is built from the outlets' and orgs' own feeds,
// not topic-search aggregation. News now comes from the named SG outlets' direct
// RSS (free, no engagement) PLUS their social accounts (swept in runSocialFetch,
// which carry engagement/traction). Reddit + YouTube channel RSS still run here.
async function gatherNews(cfg, lookback, errors) {
  const cutoff = new Date(Date.now() - lookback * 864e5);
  const kws = cfg.keywords || [];
  const tasks = [];
  tasks.push(redditCombined(kws, cutoff).catch((e) => { errors.push(`Reddit: ${String(e).slice(0, 50)}`); return []; }));
  tasks.push(outletFeeds(cutoff, errors).catch((e) => { errors.push(`Outlets: ${String(e).slice(0, 50)}`); return []; }));
  const ytH = (cfg.accounts && cfg.accounts.youtube) || [];
  if (ytH.length) tasks.push(youtube(ytH, cutoff, errors));
  let results = (await Promise.all(tasks)).flat();
  const seenT = new Set(); const uniq = [];
  for (const it of results) { const k = it.title.toLowerCase().replace(/\W+/g, '').slice(0, 80); if (k && seenT.has(k)) continue; seenT.add(k); uniq.push(it); }
  return uniq;
}

export async function runNewsFetch(project, date) {
  const cfg = await getWatchlist(project);
  const errors = [];
  const uniq = await gatherNews(cfg, cfg.lookback_days || 2, errors);
  // Bucket each item into its REPORT day (10:45 SGT cutoff — see reportDay) instead
  // of dumping everything onto the fetch day, so a story published yesterday after
  // 10:45 lands on today's report page and one from yesterday morning lands on
  // yesterday's. Items without a parseable publish time fall back to the fetch day.
  const byDate = {};
  for (const it of uniq) {
    const d = reportDay(it.published) || date;
    (byDate[d] = byDate[d] || []).push(it);
  }
  const touched = new Set([date, ...Object.keys(byDate)]);
  let out = null;
  for (const d of touched) {
    let day = (await getDay(project, d)) || freshDay(d);
    if (byDate[d] && byDate[d].length) mergeClips(day, byDate[d], cfg);
    if (d === date) { day.fetched_at = new Date().toISOString(); day.fetch_errors = errors; out = day; }
    await putDay(project, day);
  }
  return out || ((await getDay(project, date)) || freshDay(date));
}

// One-off catch-up: fetch a wide window and bucket each relevant item into the
// day it was PUBLISHED (not the fetch day), then regenerate stories per day. Used
// by /api/backfill to fill in history (e.g. "from the 4th").
export async function runBackfill(project, fromDate) {
  const cfg = await getWatchlist(project);
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);
  const lookback = Math.min(45, Math.ceil((Date.now() - new Date(fromDate + 'T00:00:00Z').getTime()) / 864e5) + 1);
  const uniq = await gatherNews(cfg, lookback, errors);
  // bucket by report day (10:45 SGT cutoff), within [fromDate, today]
  const byDate = {};
  for (const it of uniq) {
    const d = reportDay(it.published);
    if (!d || d < fromDate || d > today) continue;
    (byDate[d] = byDate[d] || []).push(it);
  }
  const summary = [];
  for (const d of Object.keys(byDate).sort()) {
    let day = (await getDay(project, d)) || freshDay(d);
    const before = (day.clips || []).length;
    mergeClips(day, byDate[d], cfg);
    day.fetched_at = new Date().toISOString();
    day.fetch_errors = errors;
    day = await rebuildStories(day, cfg);   // generate stories for the newly-added clips
    await putDay(project, day);
    summary.push({ date: d, added: (day.clips || []).length - before, clips: (day.clips || []).length, stories: (day.stories || []).length });
  }
  return { ok: true, from: fromDate, lookback, days: summary, errors };
}

// ── Apify social sweep ───────────────────────────────────────────────────
const APIFY = 'https://api.apify.com/v2';
async function apifyRun(actor, input, maxWait = 600000, project) {
  const token = APIFY_TOKEN(project);
  const start = await httpPostJson(`${APIFY}/acts/${actor}/runs?token=${token}`, input);
  const runId = start.data.id, dsId = start.data.defaultDatasetId;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = (await httpJson(`${APIFY}/actor-runs/${runId}?token=${token}`, 30000)).data.status;
    if (st === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(st)) throw new Error(`${actor} ${st}`);
  }
  return httpJson(`${APIFY}/datasets/${dsId}/items?format=json&clean=1&token=${token}`, 60000);
}
async function httpPostJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    // Surface the API's error reason, not just the status. A bare "HTTP 403" from
    // Apify hid a 3-day outage whose body said "usage-limit-exceeded" ($100 monthly
    // cap hit, Jul 2026) — with the type in social_errors the diagnosis is instant.
    let detail = '';
    try {
      const t = await r.text();
      try { const j = JSON.parse(t); detail = (j.error && (j.error.type || j.error.message)) || ''; } catch { detail = t; }
    } catch { /* body unreadable */ }
    throw new Error('HTTP ' + r.status + (detail ? ' ' + String(detail).slice(0, 120) : ''));
  }
  return r.json();
}
function traction(plat, eng) {
  const plays = eng.plays || 0, c = (eng.likes || 0) + (eng.comments || 0) + (eng.shares || 0);
  if (plat === 'TikTok' || plat === 'YouTube') { if (plays >= 4e5 || c >= 14000) return 'very_high'; if (plays >= 1e5 || c >= 3000) return 'high'; if (plays >= 4e4 || c >= 850) return 'moderate'; if (plays >= 2e4 || c >= 350) return 'low'; return 'very_low'; }
  if (c > 300) return 'high'; if (c >= 100) return 'moderate'; return 'low';
}
async function socialItem(plat, handle, title, link, dt, eng, img, extra) {
  return { id: await sha1_12(link), src: plat, kw: '@' + handle,
    cat: handle.toLowerCase().includes('prison') ? 'social_updates' : 'daily_news',
    title: (title || '(no caption)').trim().slice(0, 300), link, pub: handle, plat,
    published: dt.toISOString(), eng, traction: traction(plat, eng), img: img || null,
    extra: (extra || '').trim().slice(0, 1000), status: 'new' };
}

// Fetch an image, falling back to a hotlink-bypass proxy. IG/FB CDN URLs 403
// when fetched server-side, so we retry through images.weserv.nl (a free image
// proxy that re-fetches and re-serves), which recovers most of them.
async function fetchImage(imgUrl) {
  const tryFetch = async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    if (!/^image\//.test(ct)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 4 * 1024 * 1024) return null;
    return { ct, data: Buffer.from(buf).toString('base64') };
  };
  try { const a = await tryFetch(imgUrl); if (a) return a; } catch {}
  try {
    const proxied = 'https://images.weserv.nl/?url=' + encodeURIComponent(imgUrl.replace(/^https?:\/\//, '')) + '&output=jpg';
    const b = await tryFetch(proxied); if (b) return { ct: 'image/jpeg', data: b.data };
  } catch {}
  return null;
}

// Read text OUT of a post's image via Gemini vision (posters/graphics/title cards).
async function imageText(imgUrl, diag, project) {
  const key = GEMINI_KEY(project);
  if (!key || !imgUrl) return '';
  try {
    const got = await fetchImage(imgUrl);
    if (!got) { if (diag) diag.o = 'fetch_fail'; return null; }
    const { ct, data } = got;
    const body = { contents: [{ parts: [
      { inlineData: { mimeType: ct, data } },
      { text: 'Transcribe ALL text visible in this image verbatim (captions, posters, on-screen graphics, title cards). If there is no text, reply with nothing. Output only the transcribed text.' },
    ] }], generationConfig: { temperature: 0 } };
    // Each model sits in its own free-tier quota bucket, so cycling models already
    // spreads load. On a 429/503 (per-minute rate limit) do one short backoff-retry
    // before giving up on that model — recovers calls that would otherwise return ''.
    for (const model of GEMINI_MODELS) {   // gemini-2.0-flash retired — use the shared current list
      for (let attempt = 0; attempt < 2; attempt++) {
        const rr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
        if (rr.ok) {
          const d = await rr.json(); const cand = d?.candidates?.[0];
          const txt = ((cand?.content?.parts || []).map((p) => p.text || '').join('') || '').trim();
          if (diag) diag.o = txt ? 'text' : ('empty:' + (cand?.finishReason || '?'));
          return txt.slice(0, 600);
        }
        if (diag) diag.o = 'http_' + rr.status;
        if (![429, 503].includes(rr.status)) { attempt = 2; break; }   // hard error → next model
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));  // rate-limited → back off once
      }
    }
  } catch (e) { if (diag) diag.o = 'exc:' + String(e).slice(0, 40); /* best-effort */ }
  return '';
}

// TikTok auto-subtitles (spoken words) from the actor's subtitleLinks → plain text.
async function tiktokSubs(v) {
  try {
    const links = (v.videoMeta && v.videoMeta.subtitleLinks) || v.subtitleLinks || [];
    if (!links.length) return '';
    const pick = links.find((l) => /eng|en-|^en/i.test(l.language || l.lang || '')) || links[0];
    const url = pick.downloadLink || pick.link || pick.url;
    if (!url) return '';
    const vtt = await httpText(url, 10000);
    return vtt.replace(/^WEBVTT[\s\S]*?\n\n/, '')
      .replace(/^\d+\s*$/gm, '')
      .replace(/\d\d?:\d\d:\d\d[.,]\d+\s*-->.*$/gm, '')
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
  } catch { return ''; }
}
const when = (v) => { if (!v) return null; try { const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v); return isNaN(d.getTime()) ? null : d; } catch { return null; } };
// Report-day bucketing: the SPS reporting "day" closes at 10:45 SGT — anything
// published after 10:45 belongs to the NEXT day's report (e.g. the 16 Jul report
// covers 15 Jul 10:45 → 16 Jul 10:45). Equivalent to shifting the timestamp
// forward by 24h − 10:45 = 13h15m SGT; SGT = UTC+8, so UTC + 21h15m, take date.
// The clip's own `date` field keeps the REAL publish date (the team's clips log
// shows e.g. "29 June" inside the 30 June report) — only the day PAGE shifts.
const reportDay = (published) => {
  const t = when(published); if (!t) return '';
  return new Date(t.getTime() + (21 * 60 + 15) * 60000).toISOString().slice(0, 10);
};

async function sweepTiktok(handles, cutoff, limit, project) {
  // downloadSubtitlesOptions: DOWNLOAD_SUBTITLES pulls TikTok's OWN existing
  // captions (populates subtitleLinks) — NOT charged. The AI-transcription modes
  // (DOWNLOAD_AND_TRANSCRIBE_*/TRANSCRIBE_ALL_VIDEOS) bill the Transcript add-on at
  // ~$0.041/min/video and are NOT used. This replaces the deprecated boolean
  // `shouldDownloadSubtitles: true`, which the actor still honours today but could
  // drop anytime — silently defaulting to NEVER_DOWNLOAD_SUBTITLES and killing subs.
  const items = await apifyRun('clockworks~tiktok-scraper', { profiles: handles, resultsPerPage: limit, profileScrapeSections: ['videos'], profileSorting: 'latest', excludePinnedPosts: true, shouldDownloadVideos: false, shouldDownloadCovers: false, downloadSubtitlesOptions: 'DOWNLOAD_SUBTITLES', shouldDownloadSlideshowImages: false }, undefined, project);
  const out = [];
  for (const v of items) {
    const dt = when(v.createTimeISO || v.createTime); const link = v.webVideoUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (v.authorMeta && v.authorMeta.name) || 'unknown';
    const subs = await tiktokSubs(v);   // spoken words from the video
    out.push(await socialItem('TikTok', h, v.text, link, dt,
      { plays: v.playCount || 0, likes: v.diggCount || 0, comments: v.commentCount || 0, shares: v.shareCount || 0 },
      (v.videoMeta && v.videoMeta.coverUrl) || v.coverUrl, subs));
  }
  return out;
}
async function sweepInstagram(handles, cutoff, limit, project) {
  const items = await apifyRun('apify~instagram-scraper', { directUrls: handles.map((h) => `https://www.instagram.com/${h}/`), resultsType: 'posts', resultsLimit: limit }, undefined, project);
  const out = [];
  for (const p of items) {
    const dt = when(p.timestamp); const link = p.url;
    if (!dt || !link || dt < cutoff) continue;
    const it = await socialItem('Instagram', p.ownerUsername || 'unknown', p.caption, link, dt,
      { plays: p.videoPlayCount || 0, likes: p.likesCount || 0, comments: p.commentsCount || 0, shares: 0 }, p.displayUrl);
    // Reel audio track (small, ~1-2MB) → fed to Gemini for a spoken transcript POST-GATE.
    if (p.audioUrl || p.videoUrl) it.audioUrl = p.audioUrl || p.videoUrl;
    out.push(it);
  }
  return out;
}
// Shortcode from any IG post/reel URL — the stable key shared by both scrapers.
// Gemini transcribes a reel's spoken audio. The reel `audioUrl` (from the IG scraper)
// is a small ~1-2MB AAC/mp4 track that — unlike IG image CDN URLs — fetches fine
// server-side, so we send it inline to Gemini (reusing the paid key) instead of paying
// Apify's per-minute ASR add-on. Best-effort; skips empty or oversized (>18MB) audio.
async function transcribeAudio(audioUrl, project) {
  const key = GEMINI_KEY(project);
  if (!key || !audioUrl) return '';
  try {
    const r = await fetch(audioUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return '';
    const buf = await r.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 18 * 1024 * 1024) return '';
    const data = Buffer.from(buf).toString('base64');
    // IG serves the audio-only track with a misleading `video/mp4` content-type; sent as
    // video Gemini errors "0 Frames found", so we force an AUDIO mime (the URL we pass is
    // p.audioUrl — the extracted AAC-in-mp4 track). Verified against ground-truth transcript.
    const body = { contents: [{ parts: [
      { inlineData: { mimeType: 'audio/mp4', data } },
      { text: 'Transcribe the spoken words in this audio verbatim, in the original language. Output only the transcript; if there is no speech, output nothing.' },
    ] }], generationConfig: { temperature: 0 } };
    for (const model of GEMINI_MODELS) {
      const rr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (rr.ok) {
        const d = await rr.json();
        return ((d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '').trim().slice(0, 1000);
      }
      if (rr.status === 404) continue;                    // retired model → next
      if (![429, 500, 503].includes(rr.status)) break;    // hard error → stop
    }
  } catch { /* best-effort */ }
  return '';
}
// POST-GATE reel transcription: for IG clips that PASSED the gate this run and carry a
// fresh `audioUrl`, transcribe via Gemini and fold into `extra`. Each reel is done once
// (`reelTx` flag); the transient audioUrl is stripped after (short-lived signed URL).
// Capped per run so a backlog can't blow Netlify's time budget. Returns count transcribed.
async function transcribeKeptReels(day, project) {
  const todo = (day.clips || []).filter((c) => c.plat === 'Instagram' && c.audioUrl && !c.reelTx).slice(0, 12);
  let n = 0;
  // Small parallel batches so a handful of ~60s Gemini calls can't blow the 15-min cap.
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (c) => {
      try { const tx = await transcribeAudio(c.audioUrl, project); if (tx) { c.extra = ((c.extra || '') + ' ' + tx).trim().slice(0, 1000); n++; } }
      catch { /* best-effort */ }
      c.reelTx = true; delete c.audioUrl;   // done once; drop the expiring URL
    }));
  }
  for (const c of (day.clips || [])) if (c.audioUrl) { delete c.audioUrl; c.reelTx = true; }  // never persist expiring URLs
  return n;
}
async function sweepFacebook(handles, cutoff, limit, project) {
  // captionText: true → include video transcripts (spoken words) for FB video posts.
  // The FB scraper has NO transcript add-on (unlike TikTok/IG reels), so this is
  // free beyond the flat per-post + start fee. Output field name varies by actor
  // version — read it defensively and fold it into `extra` like TikTok subtitles.
  const items = await apifyRun('apify~facebook-posts-scraper', { startUrls: handles.map((h) => ({ url: `https://www.facebook.com/${h}` })), resultsLimit: limit, captionText: true }, undefined, project);
  const out = [];
  for (const p of items) {
    const dt = when(p.time || p.timestamp); const link = p.url || p.topLevelUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (p.user && p.user.name) || p.pageName || 'unknown';
    let img = null;
    if (Array.isArray(p.media) && p.media[0]) img = (p.media[0].photo_image && p.media[0].photo_image.uri) || p.media[0].thumbnail || null;
    const tx = p.captionText || p.transcript || p.videoTranscript || p.video_transcript || '';
    out.push(await socialItem('Facebook', h, p.text, link, dt,
      { plays: 0, likes: p.likes || 0, comments: p.comments || 0, shares: p.shares || 0 }, img,
      typeof tx === 'string' ? tx : ''));
  }
  return out;
}

async function sweepTwitter(handles, cutoff, limit, project) {
  // apidojo/tweet-scraper: pay-per-result X/Twitter scraper. The most reliable
  // way to pull a user's timeline is the `from:` search operator (twitterHandles
  // + start returned 0). `since:` bounds the window server-side; we still filter
  // by cutoff in code. maxItems is a global cap, so scale by handle count.
  const since = cutoff.toISOString().slice(0, 10);
  const items = await apifyRun('apidojo~tweet-scraper', {
    searchTerms: handles.map((h) => `from:${h} since:${since}`),
    maxItems: Math.max(limit * handles.length, handles.length * 2),
    sort: 'Latest', includeSearchTerms: false, onlyVerifiedUsers: false,
  }, undefined, project);
  const out = [];
  for (const t of items) {
    const dt = when(t.createdAt || t.created_at); const link = t.url || t.twitterUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (t.author && (t.author.userName || t.author.screen_name)) || t.username || 'unknown';
    let img = null;
    const media = (t.extendedEntities && t.extendedEntities.media) || t.media || [];
    if (Array.isArray(media) && media[0]) img = media[0].media_url_https || media[0].media_url || (typeof media[0] === 'string' ? media[0] : null);
    out.push(await socialItem('X', h, t.fullText || t.text, link, dt,
      { plays: t.viewCount || 0, likes: t.likeCount || 0, comments: t.replyCount || 0, shares: (t.retweetCount || 0) + (t.quoteCount || 0) }, img));
  }
  return out;
}

// ── Keyword-first social search (discovery layer) ─────────────────────────
// These mirror the account sweep functions but take search queries instead of
// handle lists, so any public account whose content matches surfaces — not just
// the pre-configured watchlist. Results carry discovered:true and go through
// the full gate (topic + locale checks); no own/CARE exemption applies.

async function searchTiktok(queries, cutoff, limit) {
  const items = await apifyRun('clockworks~tiktok-scraper', {
    searchQueries: queries, resultsPerPage: limit, searchSection: 'top',
    shouldDownloadVideos: false, shouldDownloadCovers: false,
    shouldDownloadSubtitles: true, shouldDownloadSlideshowImages: false,
  });
  const out = [];
  for (const v of items) {
    const dt = when(v.createTimeISO || v.createTime); const link = v.webVideoUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (v.authorMeta && v.authorMeta.name) || 'unknown';
    const subs = await tiktokSubs(v);
    const it = await socialItem('TikTok', h, v.text, link, dt,
      { plays: v.playCount||0, likes: v.diggCount||0, comments: v.commentCount||0, shares: v.shareCount||0 },
      (v.videoMeta && v.videoMeta.coverUrl) || v.coverUrl, subs);
    it.discovered = true; out.push(it);
  }
  return out;
}

async function searchInstagram(queries, cutoff, limit) {
  // Instagram discovery is hashtag-based: convert search queries to hashtags.
  // Best recall for terms like "yellowribbonsingapore", "changiprison" etc.
  const hashtags = queries.map((q) => q.replace(/\s+/g, '').toLowerCase());
  const items = await apifyRun('apify~instagram-scraper', {
    hashtags, resultsType: 'posts', resultsLimit: limit,
  });
  const out = [];
  for (const p of items) {
    const dt = when(p.timestamp); const link = p.url;
    if (!dt || !link || dt < cutoff) continue;
    const it = await socialItem('Instagram', p.ownerUsername || 'unknown', p.caption, link, dt,
      { plays: p.videoPlayCount||0, likes: p.likesCount||0, comments: p.commentsCount||0, shares: 0 },
      p.displayUrl);
    it.discovered = true; out.push(it);
  }
  return out;
}

async function searchFacebook(queries, cutoff, limit) {
  // Facebook public search via search page URLs — same actor, different startUrls.
  const items = await apifyRun('apify~facebook-posts-scraper', {
    startUrls: queries.map((q) => ({ url: `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}` })),
    resultsLimit: limit,
  });
  const out = [];
  for (const p of items) {
    const dt = when(p.time || p.timestamp); const link = p.url || p.topLevelUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (p.user && p.user.name) || p.pageName || 'unknown';
    let img = null;
    if (Array.isArray(p.media) && p.media[0]) img = (p.media[0].photo_image && p.media[0].photo_image.uri) || p.media[0].thumbnail || null;
    const it = await socialItem('Facebook', h, p.text, link, dt,
      { plays: 0, likes: p.likes||0, comments: p.comments||0, shares: p.shares||0 }, img);
    it.discovered = true; out.push(it);
  }
  return out;
}

async function searchTwitter(queries, cutoff, limit) {
  // Same actor as sweepTwitter but without the `from:handle` constraint —
  // searches all of X for the query terms, surfacing any matching public account.
  const since = cutoff.toISOString().slice(0, 10);
  const items = await apifyRun('apidojo~tweet-scraper', {
    searchTerms: queries.map((q) => `${q} since:${since}`),
    maxItems: limit * queries.length,
    sort: 'Latest', includeSearchTerms: false, onlyVerifiedUsers: false,
  });
  const out = [];
  for (const t of items) {
    const dt = when(t.createdAt || t.created_at); const link = t.url || t.twitterUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (t.author && (t.author.userName || t.author.screen_name)) || t.username || 'unknown';
    let img = null;
    const media = (t.extendedEntities && t.extendedEntities.media) || t.media || [];
    if (Array.isArray(media) && media[0]) img = media[0].media_url_https || media[0].media_url || (typeof media[0] === 'string' ? media[0] : null);
    const it = await socialItem('X', h, t.fullText || t.text, link, dt,
      { plays: t.viewCount||0, likes: t.likeCount||0, comments: t.replyCount||0, shares: (t.retweetCount||0)+(t.quoteCount||0) }, img);
    it.discovered = true; out.push(it);
  }
  return out;
}

export async function runSocialFetch(project, date) {
  if (!APIFY_TOKEN(project)) throw new Error('APIFY_TOKEN not set');
  const cfg = await getWatchlist(project);
  // Social accounts (activists, orgs, ministers) post SPS-relevant content
  // weekly, not daily — use a wider window than the news fetch.
  const cutoff = new Date(Date.now() - (cfg.social_lookback_days || 7) * 864e5);
  const limit = cfg.posts_per_account || 3;
  const newsLimit = cfg.news_posts_per_account || 12;   // outlets post a lot → pull deeper
  const acc = cfg.accounts || {};
  const news = cfg.news_accounts || {};                 // SG news outlets (separate group)
  const errors = []; let results = [];
  const rawCounts = {};   // posts each platform returned (pre-gate) — diagnostics for thin days
  const FN = { TikTok: sweepTiktok, Instagram: sweepInstagram, Facebook: sweepFacebook, X: sweepTwitter };
  const KEY = { TikTok: 'tiktok', Instagram: 'instagram', Facebook: 'facebook', X: 'twitter' };
  const sweeps = [];
  // Two groups: curated accounts (activists/orgs/own/CARE) at the normal limit,
  // and news outlets at a deeper limit so their court/SPS stories surface.
  for (const name of ['TikTok', 'Instagram', 'Facebook', 'X']) {
    const a = acc[KEY[name]]; if (a && a.length) sweeps.push([name, FN[name], a, limit, false]);
    const n = news[KEY[name]]; if (n && n.length) sweeps.push([name, FN[name], n, newsLimit, true]);
  }
  // Run all platform sweeps CONCURRENTLY. Sequentially, each apifyRun can wait up
  // to 10 min (maxWait), so a couple of slow actors blow past Netlify's 15-min
  // background cap and the function is killed before it writes anything. Concurrent
  // wall-time = the slowest single actor, not the sum. Each keeps its own try/catch
  // so one failed/slow actor can't sink the batch.
  const swept = await Promise.all(sweeps.map(async ([name, fn, handles, lim, isNews]) => {
    try {
      const r = await fn(handles, cutoff, lim, project);
      if (isNews) r.forEach((it) => { it.newsOutlet = true; });   // gate as news, not curated-social
      return { name, r };
    } catch (e) { errors.push(`${name}: ${String(e).slice(0, 90)}`); return { name, r: null }; }
  }));
  for (const { name, r } of swept) {
    if (r) { rawCounts[name] = (rawCounts[name] || 0) + r.length; results = results.concat(r); }
    else rawCounts[name] = rawCounts[name] || 'ERR';
  }
  // Instagram reel transcripts are done POST-GATE via Gemini (see transcribeKeptReels
  // in the bucketing loop below) — we transcribe only reels that actually pass the gate
  // (~a handful/day) using the reel's audioUrl + our existing paid Gemini key, instead
  // of the Apify per-minute ASR add-on on all ~60-70 recent reels. ~free vs ~$30-90/mo.
  let igReelCount = 0;
  // Keyword-first discovery is DISABLED on all four platforms. TikTok search 400s
  // (actor schema changed), Instagram hashtag search returns 0 (multi-word queries
  // don't map to real hashtags), Facebook search-page scraping is login-gated, and
  // X search — the last one standing — surfaced ~11 false positives/day: random
  // tweets self-passing on a bare anchor mention ("drove past Changi prison once",
  // Indonesian "selarang" slang, death-penalty chatter). Curated-account + news-
  // outlet sweeps above cover the watchlist cleanly; off-watchlist discovery isn't
  // worth the noise. Re-enable per-platform only once its precision is fixed.
  const searchRaw = {};
  // Read text OUT of each post's image (vision OCR) and merge it into `extra`
  // alongside any TikTok subtitles, so on-image/spoken content feeds the relevance
  // gate + summary. Best-effort, in small concurrent batches: fully sequential over
  // ~200 images at ~2s each alone approaches the 15-min background cap; batching
  // keeps it well under while staying gentle on the Gemini quota.
  // OCR is one Gemini vision call per image. Free-tier rate limits CANNOT absorb
  // ~350 calls/sweep (diagnostic proved gotText≈0, fetchFail=0 = requests rejected,
  // not fetch failures), so we OCR only the posts that actually NEED it:
  //   • skip X (tweet media ~never carries SPS text)
  //   • skip posts already in scope (own/CARE) or already passing on caption+subtitle
  //     — OCR wouldn't change the gate decision, only enrich the summary
  //   • what's left are watchlist posts that currently FAIL; on-image text (posters,
  //     infographics, quote cards) may rescue them. Cap + throttle to stay under RPM.
  const isRelOcr = makeRelevance(cfg);
  const needsOcr = (it) => {
    if (it.plat === 'X' || !it.img) return false;
    if (ownPost(cfg, it)) return false;   // own SPS/YRSG posts already in scope; CARE + others get OCR'd
    const strict = (cfg.locale_strict || []).map(_normHandle);
    const isStrict = strict.includes(_normHandle(it.kw)) || strict.includes(_normHandle(it.pub));
    const skipLocale = !isStrict && ((SOCIAL_PLATS.has(it.plat) && !it.newsOutlet && !isNewsOutlet(it.pub)) || !!it.localTrust);
    const vern = !!it.vern || isSgVernOutlet(it.pub) || /[㐀-鿿]/.test(it.title || '');
    return !isRelOcr((it.title || '') + ' ' + (it.extra || ''), it.pub, skipLocale, vern);
  };
  // Prioritise news-outlet + curated posts; hard-cap so a news-heavy sweep can't
  // flood the quota. Beyond the cap, posts keep their caption-only relevance.
  const OCR_CAP = 60, OCR_BATCH = 3;
  const candidates = results.filter(needsOcr)
    .sort((a, b) => (b.newsOutlet ? 1 : 0) - (a.newsOutlet ? 1 : 0))
    .slice(0, OCR_CAP);
  const ocrStats = { cap: OCR_CAP, candidates: results.filter(needsOcr).length, outcomes: {} };
  const bumpOut = (o) => { ocrStats.outcomes[o] = (ocrStats.outcomes[o] || 0) + 1; };
  for (let i = 0; i < candidates.length; i += OCR_BATCH) {
    await Promise.all(candidates.slice(i, i + OCR_BATCH).map(async (it) => {
      try {
        const diag = {};
        const ocr = await imageText(it.img, diag, project);
        bumpOut(diag.o || 'unknown');
        if (ocr && ocr !== null) it.extra = ((it.extra || '') + ' ' + ocr).trim().slice(0, 1000);
      } catch { /* best-effort */ }
    }));
    if (i + OCR_BATCH < candidates.length) await new Promise((r) => setTimeout(r, 1500));  // throttle: stay under Gemini RPM
  }
  // Bucket each post into its REPORT day (10:45 SGT cutoff — see reportDay), so a
  // sweep distributes its window across the right report pages and never piles last
  // week's posts onto today / duplicates the archive. Stored posts dedupe by link.
  const byDate = {};
  for (const it of results) {
    const d = reportDay(it.published);
    if (d) (byDate[d] = byDate[d] || []).push(it);
  }
  const touched = new Set([date, ...Object.keys(byDate)]);
  for (const d of touched) {
    let day = (await getDay(project, d)) || freshDay(d);
    if (byDate[d] && byDate[d].length) { mergeClips(day, byDate[d], cfg); igReelCount += await transcribeKeptReels(day, project); day = await rebuildStories(day, cfg); }
    if (d === date) { day.social_fetched_at = new Date().toISOString(); day.social_errors = errors; day.social_raw = rawCounts; day.social_search_raw = searchRaw; day.ocr_stats = ocrStats; day.ig_reels = igReelCount; }
    await putDay(project, day);
  }
  return (await getDay(project, date)) || freshDay(date);
}

// ── og:image for news clips (cloud "snap") ───────────────────────────────
export async function ogImage(link) {
  if (/tiktok\.com/.test(link)) {
    try { const j = await httpJson('https://www.tiktok.com/oembed?url=' + encodeURIComponent(link)); if (j.thumbnail_url) return j.thumbnail_url; } catch {}
  }
  if (/youtube\.com|youtu\.be/.test(link)) {
    try { const j = await httpJson('https://www.youtube.com/oembed?url=' + encodeURIComponent(link)); if (j.thumbnail_url) return j.thumbnail_url; } catch {}
  }
  const html = await httpText(link, 15000);
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i);
  if (!m) throw new Error('no og:image');
  return decode(m[1]);
}

// ── Gemini: rewrite clip clusters into journalist-style summaries ─────────
// Tried in order; on a 429 (free-tier quota exhausted) we fall through to the
// next model, which sits in a separate quota bucket. 2.0-flash has the most
// generous free daily limit, so it leads.
// gemini-2.0-flash was RETIRED by Google (404) — dropped. `gemini-flash-latest` is
// an alias that tracks the current flash model, so it survives future renames.
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];

export async function summarizeItems(items, project) {
  const key = GEMINI_KEY(project);
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const prompt = `You are a media-monitoring analyst preparing the Singapore Prison Service (SPS) daily media monitoring report. Write each entry to the house style below. If an item is in Chinese or Malay, translate it; the output must be in English.

STYLE RULES (follow exactly):
- Past tense throughout ("published", "shared", "highlighted", "advertised", "said").
- Neutral and factual. NEVER use promotional or interpretive words like heartwarming, powerful, successful, engaging, viral, funny, inspiring, compelling. Use plain verbs: published, shared, used, highlighted, featured, encouraged, advertised, explained, reflected on.
- Purpose-led: explain not just what was posted but what it was trying to do.
- Low interpretation: do not analyse audience sentiment or add opinion. No creative flourish.
- Strip emoji, hashtags, internet slang and quotation marks from the headline.

For each item below (a social media post or news article, sometimes several related clips of the same story), produce:
- "headline": one line, sentence case, in the form "[Organisation/person] [published/shared/used/highlighted/etc.] [content type / topic / angle]". It must answer: who did what, and what was the main angle. Examples: "Singapore Prison Service published a Father's Day video featuring a prison officer"; "Alliance Against Death Penalty published a post promoting its upcoming workshop on drug policy and harm reduction".
- "summary": 2 to 4 sentences following this structure. Sentence 1 — what the post/article was about (open with "In the post...", "SPS shared...", "The article highlighted...", "The post advertised..." as appropriate). Sentence 2 — what it aimed to communicate ("It highlighted...", "The initiative aimed to...", "The post encouraged...", "The video used..."). Sentence 3 (only if it adds value) — one key supporting detail: a named person, a quote, a programme detail, a date, or an outcome. Do NOT copy the caption verbatim. Do NOT mention engagement, likes or comments (a separate traction line handles that).
- "category": classify into EXACTLY ONE of these values:
   "issues" = executions, the death penalty, death row, court cases or controversies that directly affect or criticise SPS, custody/treatment complaints, anti-death-penalty activism.
   "daily_news" = general news about SPS, Changi Prison, the Ministry of Home Affairs prison matters, sentencing/court news involving imprisonment, operational prison news.
   "yellow_ribbon" = anything by or about Yellow Ribbon Singapore (YRSG), the Yellow Ribbon Project, or its reintegration / second-chances programmes.
   "care_network" = CARE Network partners and their activities (SANA, SACA, Prison Fellowship Singapore, Yellow Ribbon Fund, ISCOS, NeuGen, community partners). A post BY Prison Fellowship Singapore about its own events belongs here, NOT in social_updates.
   "social_updates" = ONLY posts published by the Singapore Prison Service's or Yellow Ribbon Singapore's OWN official accounts. Never use this for any other organisation.
   "fyi" = minor or tangential mentions that do not fit the above.
Return ONLY a JSON array, one object per item, each with keys "key", "headline", "summary", "category". Use the exact "key" given for each item.

Items:
${JSON.stringify(items)}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } };
  // Transient: 429 (quota), 500/503 (overload) → retry with backoff, then fall to
  // the next model. Anything else is a real error and stops immediately.
  const TRANSIENT = new Set([429, 500, 503]);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastErr = 'no models tried';
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        let txt = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '[]';
        txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        return JSON.parse(txt);
      }
      lastErr = 'Gemini ' + r.status + ' ' + (await r.text()).slice(0, 160);
      if (r.status === 404) break;                             // model retired/unavailable → try next model
      if (!TRANSIENT.has(r.status)) throw new Error(lastErr);   // real error (400/401/403) → surface it
      if (attempt < 2) await sleep(700 * (attempt + 1));   // backoff before retrying same model
    }
    // exhausted retries on this model → next model (fresh quota / capacity)
  }
  throw new Error(lastErr);
}

// Shared logic for the SPS Media Monitor cloud backend (Netlify Functions).
// Mirrors launch_server.py but uses Supabase for storage instead of local disk.

const SUPA_URL = () => Netlify.env.get('SUPABASE_URL');
const SUPA_KEY = () => Netlify.env.get('SUPABASE_ANON_KEY');
const APIFY_TOKEN = () => Netlify.env.get('APIFY_TOKEN');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Supabase REST helpers ────────────────────────────────────────────────
async function supa(path, opts = {}) {
  const r = await fetch(SUPA_URL() + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: SUPA_KEY(), Authorization: 'Bearer ' + SUPA_KEY(),
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

export async function getDay(date) {
  const rows = await supa(`monitor_days?date=eq.${date}&select=payload`);
  return rows && rows[0] ? rows[0].payload : null;
}

export async function putDay(day) {
  await supa('monitor_days', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ date: day.date, payload: day, updated_at: new Date().toISOString() }]),
  });
}

export async function listDays() {
  const rows = await supa('monitor_days?select=date,payload&order=date.desc');
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

export async function getWatchlist() {
  const rows = await supa(`monitor_config?key=eq.watchlist&select=value`);
  return (rows && rows[0] && rows[0].value) || { lookback_days: 2, posts_per_account: 3, keywords: [], accounts: {} };
}

export async function putWatchlist(cfg) {
  await supa('monitor_config', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ key: 'watchlist', value: cfg, updated_at: new Date().toISOString() }]),
  });
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
  'prison', 'sps', 'changi', 'death penalt', 'death row', 'capital punishment',
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
const relevant = (text, terms) => { const low = (text || '').toLowerCase(); for (const t of terms) if (low.includes(t)) return true; return false; };

// Convert a fetched item to a clip (the evidence-log shape used everywhere).
function itemToClip(it) {
  return {
    id: it.id, date: (it.published || '').slice(0, 10) || null,
    pub: it.pub, plat: it.plat || (it.src === 'Reddit' ? 'Reddit' : ''),
    subject: it.title, link: it.link, cat: it.cat || 'daily_news',
    src: it.src, kw: it.kw, eng: it.eng || null, traction: it.traction || null,
    shot: it.img || null, published: it.published || null,
  };
}

// Merge fetched results straight into day.clips: keep only on-watchlist,
// SPS-relevant items; skip ones already clipped or previously deleted.
export function mergeClips(day, results, cfg) {
  const valid = new Set((cfg.keywords || []).map((k) => k.q));
  for (const hs of Object.values(cfg.accounts || {})) for (const h of hs) valid.add('@' + h);
  const terms = topicTerms(cfg);
  day.clips = day.clips || [];
  day.dismissed = day.dismissed || [];
  const have = new Set(day.clips.map((c) => c.id));
  const gone = new Set(day.dismissed);
  for (const it of results) {
    if (have.has(it.id) || gone.has(it.id)) continue;
    if (!valid.has(it.kw)) continue;
    if (!relevant(it.title, terms)) continue;
    have.add(it.id);
    day.clips.push(itemToClip(it));
  }
  day.clips.sort((a, b) => (b.published || b.date || '').localeCompare(a.published || a.date || ''));
}

// ── news / reddit / youtube fetchers ─────────────────────────────────────
async function googleNews(kw, lookback, cutoff) {
  const q = encodeURIComponent(`"${kw.q}" when:${lookback}d`);
  const xml = await httpText(`https://news.google.com/rss/search?q=${q}&hl=en-SG&gl=SG&ceid=SG:en`);
  const out = [];
  for (const it of blocks(xml, 'item')) {
    const title0 = tag(it, 'title'); const link = tag(it, 'link');
    const pub = tag(it, 'source'); const pd = tag(it, 'pubDate');
    const dt = pd ? new Date(pd) : null;
    if (!title0 || !link || !dt || dt < cutoff) continue;
    let title = title0;
    if (pub && title.endsWith(' - ' + pub)) title = title.slice(0, -(' - ' + pub).length);
    out.push({ id: await sha1_12(link), src: 'Google News', kw: kw.q, cat: kw.cat || 'daily_news',
      title, link, pub: pub || 'Unknown', plat: '', published: dt.toISOString(), eng: null, status: 'new' });
  }
  return out;
}

async function bingNews(kw, cutoff) {
  const q = encodeURIComponent(`"${kw.q}"`);
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
        out.push({ id: await sha1_12(link), src: 'YouTube', kw: '@' + h, cat: 'daily_news',
          title, link, pub: h, plat: 'YouTube', published: dt.toISOString(),
          eng: { plays: views ? +views : 0, likes: 0, comments: 0, shares: 0 },
          img: vm ? vm[1] : null, status: 'new' });
      }
    } catch (e) { errors.push(`YouTube @${h}: ${String(e).slice(0, 60)}`); }
  }
  return out;
}

export async function runNewsFetch(date) {
  const cfg = await getWatchlist();
  let day = (await getDay(date)) || freshDay(date);
  const lookback = cfg.lookback_days || 2;
  const cutoff = new Date(Date.now() - lookback * 864e5);
  const kws = cfg.keywords || [];
  const errors = [];
  const tasks = [];
  for (const kw of kws) {
    tasks.push(googleNews(kw, lookback, cutoff).catch((e) => { errors.push(`Google ${kw.q}: ${String(e).slice(0, 50)}`); return []; }));
    tasks.push(bingNews(kw, cutoff).catch((e) => { errors.push(`Bing ${kw.q}: ${String(e).slice(0, 50)}`); return []; }));
  }
  tasks.push(redditCombined(kws, cutoff).catch((e) => { errors.push(`Reddit: ${String(e).slice(0, 50)}`); return []; }));
  const ytH = (cfg.accounts && cfg.accounts.youtube) || [];
  if (ytH.length) tasks.push(youtube(ytH, cutoff, errors));
  let results = (await Promise.all(tasks)).flat();
  // dedupe Google/Bing same-story by normalised title (prefer Google)
  results.sort((a, b) => (a.src === 'Google News' ? 0 : 1) - (b.src === 'Google News' ? 0 : 1));
  const seenT = new Set(); const uniq = [];
  for (const it of results) { const k = it.title.toLowerCase().replace(/\W+/g, '').slice(0, 80); if (k && seenT.has(k)) continue; seenT.add(k); uniq.push(it); }
  // re-read latest day in case a social sweep wrote concurrently
  day = (await getDay(date)) || day;
  mergeClips(day, uniq, cfg);
  day.fetched_at = new Date().toISOString();
  day.fetch_errors = errors;
  await putDay(day);
  return day;
}

// ── Apify social sweep ───────────────────────────────────────────────────
const APIFY = 'https://api.apify.com/v2';
async function apifyRun(actor, input, maxWait = 600000) {
  const token = APIFY_TOKEN();
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
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function traction(plat, eng) {
  const plays = eng.plays || 0, c = (eng.likes || 0) + (eng.comments || 0) + (eng.shares || 0);
  if (plat === 'TikTok') { if (plays >= 4e5 || c >= 14000) return 'very_high'; if (plays >= 1e5 || c >= 3000) return 'high'; if (plays >= 4e4 || c >= 850) return 'moderate'; if (plays >= 2e4 || c >= 350) return 'low'; return 'very_low'; }
  if (c > 300) return 'high'; if (c >= 100) return 'moderate'; return 'low';
}
async function socialItem(plat, handle, title, link, dt, eng, img) {
  return { id: await sha1_12(link), src: plat, kw: '@' + handle,
    cat: handle.toLowerCase().includes('prison') ? 'social_updates' : 'daily_news',
    title: (title || '(no caption)').trim().slice(0, 300), link, pub: handle, plat,
    published: dt.toISOString(), eng, traction: traction(plat, eng), img: img || null, status: 'new' };
}
const when = (v) => { if (!v) return null; try { return typeof v === 'number' ? new Date(v * 1000) : new Date(v); } catch { return null; } };

async function sweepTiktok(handles, cutoff, limit) {
  const items = await apifyRun('clockworks~tiktok-scraper', { profiles: handles, resultsPerPage: limit, profileScrapeSections: ['videos'], profileSorting: 'latest', excludePinnedPosts: true, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false });
  const out = [];
  for (const v of items) {
    const dt = when(v.createTimeISO || v.createTime); const link = v.webVideoUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (v.authorMeta && v.authorMeta.name) || 'unknown';
    out.push(await socialItem('TikTok', h, v.text, link, dt,
      { plays: v.playCount || 0, likes: v.diggCount || 0, comments: v.commentCount || 0, shares: v.shareCount || 0 },
      (v.videoMeta && v.videoMeta.coverUrl) || v.coverUrl));
  }
  return out;
}
async function sweepInstagram(handles, cutoff, limit) {
  const items = await apifyRun('apify~instagram-scraper', { directUrls: handles.map((h) => `https://www.instagram.com/${h}/`), resultsType: 'posts', resultsLimit: limit });
  const out = [];
  for (const p of items) {
    const dt = when(p.timestamp); const link = p.url;
    if (!dt || !link || dt < cutoff) continue;
    out.push(await socialItem('Instagram', p.ownerUsername || 'unknown', p.caption, link, dt,
      { plays: p.videoPlayCount || 0, likes: p.likesCount || 0, comments: p.commentsCount || 0, shares: 0 }, p.displayUrl));
  }
  return out;
}
async function sweepFacebook(handles, cutoff, limit) {
  const items = await apifyRun('apify~facebook-posts-scraper', { startUrls: handles.map((h) => ({ url: `https://www.facebook.com/${h}` })), resultsLimit: limit });
  const out = [];
  for (const p of items) {
    const dt = when(p.time || p.timestamp); const link = p.url || p.topLevelUrl;
    if (!dt || !link || dt < cutoff) continue;
    const h = (p.user && p.user.name) || p.pageName || 'unknown';
    let img = null;
    if (Array.isArray(p.media) && p.media[0]) img = (p.media[0].photo_image && p.media[0].photo_image.uri) || p.media[0].thumbnail || null;
    out.push(await socialItem('Facebook', h, p.text, link, dt,
      { plays: 0, likes: p.likes || 0, comments: p.comments || 0, shares: p.shares || 0 }, img));
  }
  return out;
}

export async function runSocialFetch(date) {
  if (!APIFY_TOKEN()) throw new Error('APIFY_TOKEN not set');
  const cfg = await getWatchlist();
  let day = (await getDay(date)) || freshDay(date);
  // Social accounts (activists, orgs, ministers) post SPS-relevant content
  // weekly, not daily — use a wider window than the news fetch.
  const cutoff = new Date(Date.now() - (cfg.social_lookback_days || 7) * 864e5);
  const limit = cfg.posts_per_account || 3;
  const acc = cfg.accounts || {};
  const errors = []; let results = [];
  const sweeps = [];
  if (acc.tiktok && acc.tiktok.length) sweeps.push(['TikTok', sweepTiktok, acc.tiktok]);
  if (acc.instagram && acc.instagram.length) sweeps.push(['Instagram', sweepInstagram, acc.instagram]);
  if (acc.facebook && acc.facebook.length) sweeps.push(['Facebook', sweepFacebook, acc.facebook]);
  for (const [name, fn, handles] of sweeps) {
    try { results = results.concat(await fn(handles, cutoff, limit)); }
    catch (e) { errors.push(`${name}: ${String(e).slice(0, 90)}`); }
  }
  day = (await getDay(date)) || day;
  mergeClips(day, results, cfg);
  day.social_fetched_at = new Date().toISOString();
  day.social_errors = errors;
  await putDay(day);
  return day;
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

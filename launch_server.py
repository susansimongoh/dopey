#!/usr/bin/env python3
"""
SPS Media Monitor – local server + fetch engine
Serves the dashboard at http://localhost:8765 and provides a REST API for
saving/loading daily sessions and fetching fresh mentions.

Endpoints:
  GET  /api/days            → [{date, clips, stories, inbox_new, fetched_at}] newest first
  GET  /api/day/DATE        → full JSON for a date
  POST /api/save            → save day (body = day JSON, date field used as filename)
  POST /api/fetch           → {date, force?} fetch mentions (Google News + Reddit).
                              Cached: if the day was already fetched and force is not
                              set, returns the saved day without hitting the network.
  GET  /api/keywords        → keyword config
  POST /api/keywords        → save keyword config

Fetch sources (no API keys needed):
  - Google News RSS (covers ST, CNA, Mothership, AsiaOne, TODAY, Stomp...)
  - Bing News RSS (second net for outlet coverage)
  - Reddit search RSS (the JSON API is blocked for scripts; RSS works)
"""
import http.server, json, os, re, socketserver, hashlib, subprocess, threading, time, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

DIR       = os.path.dirname(os.path.abspath(__file__))
DATA_DIR  = os.path.join(DIR, 'data')
SHOTS_DIR = os.path.join(DATA_DIR, 'shots')
KW_FILE   = os.path.join(DATA_DIR, 'keywords.json')
SECRETS   = os.path.join(DATA_DIR, 'secrets.json')
PAGE      = 'sps-monitor.html'
CHROME    = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
os.makedirs(SHOTS_DIR, exist_ok=True)


def load_secrets():
    try:
        with open(SECRETS) as f:
            return json.load(f)
    except Exception:
        return {}

# Default search config — from the MM Search Guide
DEFAULT_KEYWORDS = {
    "lookback_days": 2,
    "social_lookback_days": 7,
    "posts_per_account": 5,
    "keywords": [
        {"q": "Singapore Prison Service",  "cat": "daily_news"},
        {"q": "Changi Prison",             "cat": "daily_news"},
        {"q": "Singapore prison inmate",   "cat": "daily_news"},
        {"q": "death penalty Singapore",   "cat": "issues"},
        {"q": "death row Singapore",       "cat": "issues"},
        {"q": "Yellow Ribbon Singapore",   "cat": "yellow_ribbon"},
        {"q": "Inside Maximum Security",   "cat": "daily_news"}
    ],
    # Social accounts swept via Apify (edit handles in the dashboard).
    # data/keywords.json carries the full MM Search Guide lists.
    "accounts": {
        "tiktok":    ["theonlinecitizenasia"],
        "instagram": ["kixes", "jwham", "theonlinecitizen", "wakeupsingapore"],
        "facebook":  ["theonlinecitizen", "wakeupSG"],
        "youtube":   ["theonlinecitizenasia", "wakeupsingapore7744"]
    }
}

# Browser-like UA — Reddit and Bing reject obvious scripts
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'


# ── helpers ──────────────────────────────────────────────────────────────
def load_keywords():
    # Overlay the saved file on the defaults so new config keys
    # (accounts, posts_per_account, …) appear even in older files
    cfg = json.loads(json.dumps(DEFAULT_KEYWORDS))
    try:
        with open(KW_FILE) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def safe_date(raw):
    return ''.join(c for c in str(raw) if c.isalnum() or c in '-_')[:20]


def day_path(date):
    return os.path.join(DATA_DIR, f'{safe_date(date)}.json')


def load_day(date):
    path = day_path(date)
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


def save_day(day):
    # Local launcher is fully local: writes to data/<date>.json only.
    # It deliberately does NOT sync to Supabase — the cloud site (spsmedia.netlify.app)
    # owns the Supabase archive, so local testing can't overwrite cloud days.
    with open(day_path(day['date']), 'w') as f:
        json.dump(day, f, ensure_ascii=False, indent=1)


def item_id(link):
    return hashlib.sha1(link.encode()).hexdigest()[:12]


def http_get(url, timeout=12):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ── fetchers ─────────────────────────────────────────────────────────────
def fetch_google_news(kw, cutoff, lookback):
    """Google News RSS search — covers all major SG outlets."""
    q = urllib.parse.quote(f'"{kw["q"]}" when:{lookback}d')
    url = f'https://news.google.com/rss/search?q={q}&hl=en-SG&gl=SG&ceid=SG:en'
    items = []
    root = ET.fromstring(http_get(url))
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        link  = (it.findtext('link') or '').strip()
        pub   = (it.findtext('source') or '').strip()
        try:
            dt = parsedate_to_datetime(it.findtext('pubDate'))
        except Exception:
            continue
        if not title or not link or dt < cutoff:
            continue
        # Google appends " - Source" to titles; strip it
        if pub and title.endswith(' - ' + pub):
            title = title[: -len(' - ' + pub)]
        items.append({
            'id': item_id(link), 'src': 'Google News', 'kw': kw['q'],
            'cat': kw.get('cat', 'daily_news'), 'title': title, 'link': link,
            'pub': pub or 'Unknown', 'plat': '', 'published': dt.isoformat(),
            'eng': None, 'status': 'new'
        })
    return items


def fetch_bing_news(kw, cutoff):
    """Bing News RSS — second net, catches outlets Google misses."""
    q = urllib.parse.quote(f'"{kw["q"]}"')
    url = f'https://www.bing.com/news/search?q={q}&format=rss'
    items = []
    root = ET.fromstring(http_get(url))
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        link  = (it.findtext('link') or '').strip()
        try:
            dt = parsedate_to_datetime(it.findtext('pubDate'))
        except Exception:
            continue
        if not title or not link or dt < cutoff:
            continue
        host = urllib.parse.urlparse(link).netloc.replace('www.', '')
        items.append({
            'id': item_id(link), 'src': 'Bing News', 'kw': kw['q'],
            'cat': kw.get('cat', 'daily_news'), 'title': title, 'link': link,
            'pub': host, 'plat': '', 'published': dt.isoformat(),
            'eng': None, 'status': 'new'
        })
    return items


ATOM = '{http://www.w3.org/2005/Atom}'

def fetch_reddit_combined(keywords, cutoff):
    """Reddit search via RSS (Atom), ONE combined OR request — the JSON API
    403s scripts and per-keyword requests get rate-limited (429).
    Reddit's OR search is loose, so results are re-filtered locally: an entry
    only survives if its title/body actually contains a keyword phrase."""
    q = urllib.parse.quote(' OR '.join(f'"{kw["q"]}"' for kw in keywords))
    url = f'https://www.reddit.com/search.rss?q={q}&sort=new&t=week&limit=25'
    items = []
    root = ET.fromstring(http_get(url))
    for e in root.iter(ATOM + 'entry'):
        title = (e.findtext(ATOM + 'title') or '').strip()
        content = e.findtext(ATOM + 'content') or ''
        link_el = e.find(ATOM + 'link')
        link = link_el.get('href') if link_el is not None else ''
        updated = e.findtext(ATOM + 'updated') or ''
        author = e.find(ATOM + 'author')
        author_name = author.findtext(ATOM + 'name') if author is not None else 'unknown'
        cat_el = e.find(ATOM + 'category')
        subreddit = cat_el.get('label') if cat_el is not None else 'Reddit'
        try:
            dt = datetime.fromisoformat(updated.replace('Z', '+00:00'))
        except Exception:
            continue
        if not title or not link or dt < cutoff:
            continue
        haystack = (title + ' ' + content).lower()
        matched = next((kw for kw in keywords if kw['q'].lower() in haystack), None)
        if not matched:
            continue
        items.append({
            'id': item_id(link), 'src': 'Reddit', 'kw': matched['q'],
            'cat': matched.get('cat', 'daily_news'), 'title': title, 'link': link,
            'pub': (author_name or 'unknown').replace('/u/', ''),
            'plat': subreddit or 'Reddit', 'published': dt.isoformat(),
            'eng': None, 'status': 'new'
        })
    return items


# ── Apify social sweep ───────────────────────────────────────────────────
APIFY_BASE = 'https://api.apify.com/v2'

def apify_run(token, actor, run_input, max_wait=300):
    """Start an actor run, poll until it finishes, return dataset items."""
    body = json.dumps(run_input).encode()
    req = urllib.request.Request(
        f'{APIFY_BASE}/acts/{actor}/runs?token={token}', data=body,
        headers={'Content-Type': 'application/json'})
    run = json.load(urllib.request.urlopen(req, timeout=30))['data']
    run_id, ds_id = run['id'], run['defaultDatasetId']
    start = time.time()
    while time.time() - start < max_wait:
        time.sleep(6)
        st = json.load(urllib.request.urlopen(
            urllib.request.Request(f'{APIFY_BASE}/actor-runs/{run_id}?token={token}'),
            timeout=30))['data']['status']
        if st == 'SUCCEEDED':
            break
        if st in ('FAILED', 'ABORTED', 'TIMED-OUT'):
            raise RuntimeError(f'{actor} run {st}')
    else:
        raise RuntimeError(f'{actor} did not finish within {max_wait}s')
    items = json.load(urllib.request.urlopen(
        urllib.request.Request(f'{APIFY_BASE}/datasets/{ds_id}/items?format=json&clean=1&token={token}'),
        timeout=60))
    return items


def parse_when(v):
    """Best-effort timestamp from the various actor output formats."""
    if not v:
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v, tz=timezone.utc)
        return datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    except Exception:
        return None


def social_traction(plat, eng):
    """Traction per the MM Search Guide thresholds."""
    plays = eng.get('plays') or 0
    combined = (eng.get('likes') or 0) + (eng.get('comments') or 0) + (eng.get('shares') or 0)
    if plat == 'TikTok':
        if plays >= 400000 or combined >= 14000: return 'very_high'
        if plays >= 100000 or combined >= 3000:  return 'high'
        if plays >= 40000  or combined >= 850:   return 'moderate'
        if plays >= 20000  or combined >= 350:   return 'low'
        return 'very_low'
    if combined > 300: return 'high'
    if combined >= 100: return 'moderate'
    return 'low'


def social_item(plat, handle, title, link, dt, eng):
    it = {
        'id': item_id(link), 'src': plat, 'kw': '@' + handle,
        'cat': 'social_updates' if 'prison' in handle.lower() else 'daily_news',
        'title': (title or '(no caption)').strip()[:300], 'link': link,
        'pub': handle, 'plat': plat, 'published': dt.isoformat(),
        'eng': eng, 'traction': social_traction(plat, eng), 'status': 'new'
    }
    return it


def fetch_tiktok(token, handles, cutoff, limit):
    items = apify_run(token, 'clockworks~tiktok-scraper', {
        'profiles': handles, 'resultsPerPage': limit,
        'profileScrapeSections': ['videos'], 'profileSorting': 'latest',
        'excludePinnedPosts': True, 'shouldDownloadVideos': False,
        'shouldDownloadCovers': False, 'shouldDownloadSubtitles': False,
        'shouldDownloadSlideshowImages': False})
    out = []
    for v in items:
        dt = parse_when(v.get('createTimeISO') or v.get('createTime'))
        link = v.get('webVideoUrl')
        if not dt or not link or dt < cutoff:
            continue
        handle = (v.get('authorMeta') or {}).get('name') or 'unknown'
        eng = {'plays': v.get('playCount', 0), 'likes': v.get('diggCount', 0),
               'comments': v.get('commentCount', 0), 'shares': v.get('shareCount', 0)}
        out.append(social_item('TikTok', handle, v.get('text'), link, dt, eng))
    return out


def fetch_instagram(token, handles, cutoff, limit):
    items = apify_run(token, 'apify~instagram-scraper', {
        'directUrls': [f'https://www.instagram.com/{h}/' for h in handles],
        'resultsType': 'posts', 'resultsLimit': limit})
    out = []
    for p in items:
        dt = parse_when(p.get('timestamp'))
        link = p.get('url')
        if not dt or not link or dt < cutoff:
            continue
        handle = p.get('ownerUsername') or 'unknown'
        eng = {'plays': p.get('videoPlayCount', 0) or 0, 'likes': p.get('likesCount', 0) or 0,
               'comments': p.get('commentsCount', 0) or 0, 'shares': 0}
        out.append(social_item('Instagram', handle, p.get('caption'), link, dt, eng))
    return out


def fetch_facebook(token, handles, cutoff, limit):
    items = apify_run(token, 'apify~facebook-posts-scraper', {
        'startUrls': [{'url': f'https://www.facebook.com/{h}'} for h in handles],
        'resultsLimit': limit})
    out = []
    for p in items:
        dt = parse_when(p.get('time') or p.get('timestamp'))
        link = p.get('url') or p.get('topLevelUrl')
        if not dt or not link or dt < cutoff:
            continue
        handle = (p.get('user') or {}).get('name') or p.get('pageName') or 'unknown'
        eng = {'plays': 0, 'likes': p.get('likes', 0) or 0,
               'comments': p.get('comments', 0) or 0, 'shares': p.get('shares', 0) or 0}
        out.append(social_item('Facebook', handle, p.get('text'), link, dt, eng))
    return out


# ── YouTube (free channel RSS — part of the news fetch, no Apify) ───────
YT_CACHE = os.path.join(DATA_DIR, 'yt-channels.json')
MEDIA = '{http://search.yahoo.com/mrss/}'

def yt_channel_id(handle):
    try:
        cache = json.load(open(YT_CACHE))
    except Exception:
        cache = {}
    if handle in cache:
        return cache[handle]
    html = http_get(f'https://www.youtube.com/@{handle}', timeout=15).decode('utf-8', 'ignore')
    # channel id appears in different shapes depending on the served markup
    m = re.search(r'(?:"channelId":"|"browseId":"|channel/)(UC[0-9A-Za-z_-]{20,})', html)
    if not m:
        raise RuntimeError(f'channelId not found for @{handle}')
    cache[handle] = m.group(1)
    with open(YT_CACHE, 'w') as f:
        json.dump(cache, f)
    return cache[handle]


def fetch_youtube(handles, cutoff, errors):
    items = []
    for h in handles:
        try:
            cid = yt_channel_id(h)
            root = ET.fromstring(http_get(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}'))
            for e in root.iter(ATOM + 'entry'):
                title = (e.findtext(ATOM + 'title') or '').strip()
                link_el = e.find(ATOM + 'link')
                link = link_el.get('href') if link_el is not None else ''
                dt = parse_when(e.findtext(ATOM + 'published'))
                if not title or not link or not dt or dt < cutoff:
                    continue
                stats = e.find(f'{MEDIA}group/{MEDIA}community/{MEDIA}statistics')
                views = int(stats.get('views', 0)) if stats is not None else 0
                items.append({
                    'id': item_id(link), 'src': 'YouTube', 'kw': '@' + h,
                    'cat': 'daily_news', 'title': title, 'link': link,
                    'pub': h, 'plat': 'YouTube', 'published': dt.isoformat(),
                    'eng': {'plays': views, 'likes': 0, 'comments': 0, 'shares': 0},
                    'status': 'new'
                })
        except Exception as e:
            errors.append(f'YouTube · @{h}: {str(e)[:70]}')
    return items


# SPS-relevance lexicon. Watchlist accounts (TOC, Wake Up SG, ministers…)
# post lots of general news, so account posts are kept only when the text
# actually mentions something in the SPS / prison / death-penalty domain.
# Editable per-project via "topic_terms" in data/keywords.json.
SPS_CORE_TERMS = [
    'prison', 'sps', 'changi', 'death penalt', 'death row', 'capital punishment',
    'execution', 'executed', 'gallows', 'hanged', 'hanging', 'noose', 'clemency',
    'death sentence', 'sentenced to death', 'mandatory death', 'drug mule', 'caning',
    'yellow ribbon', 'rehabilitat', 'ex-offender', 'reintegrat', 'inmate', 'remand',
    'parole', 'incarcerat', 'correctional', 'captain of lives', 'drug traffick',
    'cnb', 'narcotics', 'anti-death', 'second chance', 'halfway house', 'desistor',
    'maximum security', 'prisoner', 'yrsg',
]


def sps_topic_terms(cfg):
    terms = set(t.lower() for t in (cfg.get('topic_terms') or SPS_CORE_TERMS))
    for kw in cfg.get('keywords', []):           # full keyword phrases too
        terms.add(kw['q'].lower())
    return terms


def is_relevant(text, terms):
    low = (text or '').lower()
    return any(t in low for t in terms)


def item_to_clip(it):
    """Convert a fetched item into a clip (the evidence-log shape)."""
    return {
        'id': it['id'], 'date': (it.get('published') or '')[:10] or None,
        'pub': it.get('pub'), 'plat': it.get('plat') or ('Reddit' if it.get('src') == 'Reddit' else ''),
        'subject': it.get('title'), 'link': it.get('link'), 'cat': it.get('cat', 'daily_news'),
        'src': it.get('src'), 'kw': it.get('kw'), 'eng': it.get('eng'),
        'traction': it.get('traction'), 'shot': it.get('img'), 'published': it.get('published'),
    }


def merge_clips(day, results, cfg):
    """Merge fetched results straight into day['clips']: keep only on-watchlist,
    SPS-relevant items; skip ones already clipped or previously deleted."""
    valid = {kw['q'] for kw in cfg.get('keywords', [])}
    for handles in cfg.get('accounts', {}).values():
        valid.update('@' + h for h in handles)
    terms = sps_topic_terms(cfg)

    def title_key(s):
        return ' '.join(''.join(ch if ch.isalnum() else ' ' for ch in (s or '').lower()).split())[:90]

    day.setdefault('clips', [])
    day.setdefault('dismissed', [])
    have = {c.get('id') for c in day['clips']}
    have_links = {c.get('link') for c in day['clips'] if c.get('link')}
    have_titles = {title_key(c.get('subject')) for c in day['clips'] if c.get('subject')}
    gone = set(day['dismissed'])
    for it in results:
        if it['id'] in have or it['id'] in gone:
            continue
        if it.get('link') and it['link'] in have_links:          # same URL = dupe
            continue
        tk = title_key(it.get('title'))
        if tk and tk in have_titles:                             # same headline = dupe
            continue
        if it.get('kw') not in valid:
            continue
        if not is_relevant(it.get('title', ''), terms):
            continue
        have.add(it['id'])
        if it.get('link'):
            have_links.add(it['link'])
        if tk:
            have_titles.add(tk)
        day['clips'].append(item_to_clip(it))
    day['clips'].sort(key=lambda c: (c.get('published') or c.get('date') or ''), reverse=True)


def run_social_fetch(date, force=False):
    """Apify sweep of the configured social accounts. Cached per day."""
    token = load_secrets().get('apify_token')
    if not token:
        raise RuntimeError('No Apify token in data/secrets.json')
    day = load_day(date) or freshest_day(date)
    if day.get('social_fetched_at') and not force:
        return day, 'cached'

    cfg = load_keywords()
    # Social accounts post SPS-relevant content weekly, not daily — wider window
    cutoff = datetime.now(timezone.utc) - timedelta(days=cfg.get('social_lookback_days', 7))
    limit = cfg.get('posts_per_account', 5)
    acc = cfg.get('accounts', {})

    results, errors = [], []
    # Sequential, NOT parallel: the Apify free plan caps concurrent actor
    # memory at 8 GB — three 4 GB actors at once gets a 402 Payment Required.
    sweeps = []
    if acc.get('tiktok'):    sweeps.append(('TikTok', fetch_tiktok, acc['tiktok']))
    if acc.get('instagram'): sweeps.append(('Instagram', fetch_instagram, acc['instagram']))
    if acc.get('facebook'):  sweeps.append(('Facebook', fetch_facebook, acc['facebook']))
    for name, fn, handles in sweeps:
        try:
            results.extend(fn(token, handles, cutoff, limit))
        except Exception as e:
            errors.append(f'{name}: {str(e)[:100]}')

    merge_clips(day, results, cfg)
    day['social_fetched_at'] = datetime.now().astimezone().isoformat()
    day['social_errors'] = errors
    save_day(day)
    return day, 'fetched'


def freshest_day(date):
    return {'date': date, 'fetched_at': None, 'social_fetched_at': None,
            'cfg': {'num': '', 'date': '', 'highlights': '1. XXX', 'issues': '1. XXX', 'fyi': '1. XXX'},
            'clips': [], 'stories': [], 'dismissed': []}


def run_fetch(date, force=False):
    """Fetch news/Reddit mentions for a date. Cached per day unless force=True."""
    day = load_day(date) or freshest_day(date)

    if day.get('fetched_at') and not force:
        return day, 'cached'

    cfg = load_keywords()
    lookback = cfg.get('lookback_days', 2)
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback)
    keywords = cfg.get('keywords', [])

    results, errors = [], []
    jobs = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for kw in keywords:
            jobs[ex.submit(fetch_google_news, kw, cutoff, lookback)] = ('Google News', kw['q'])
            jobs[ex.submit(fetch_bing_news, kw, cutoff)] = ('Bing News', kw['q'])
        jobs[ex.submit(fetch_reddit_combined, keywords, cutoff)] = ('Reddit', 'combined sweep')
        yt_handles = cfg.get('accounts', {}).get('youtube', [])
        if yt_handles:
            jobs[ex.submit(fetch_youtube, yt_handles, cutoff, errors)] = ('YouTube', 'channels')
        for fut in as_completed(jobs):
            src, q = jobs[fut]
            try:
                results.extend(fut.result())
            except Exception as e:
                errors.append(f'{src} · {q}: {str(e)[:80]}')

    # Same story often appears on Google News AND Bing News — dedupe by
    # normalised title, preferring Google News (cleaner source names)
    results.sort(key=lambda x: 0 if x['src'] == 'Google News' else 1)
    seen_titles = set()
    unique = []
    for it in results:
        tkey = re.sub(r'\W+', '', it['title'].lower())[:80]
        if tkey and tkey in seen_titles:
            continue
        seen_titles.add(tkey)
        unique.append(it)
    results = unique

    merge_clips(day, results, cfg)
    day['fetched_at'] = datetime.now().astimezone().isoformat()
    day['fetch_errors'] = errors
    save_day(day)
    return day, 'fetched'


# ── Hero screenshots ─────────────────────────────────────────────────────
# Each clip gets a "hero shot" for the clips log, captured login-free:
#   TikTok    → oembed API thumbnail (direct image download, no browser)
#   Instagram → /embed/captioned/ rendered in headless Chrome
#   Facebook  → plugins/post.php embed rendered in headless Chrome
#   News/other→ the article itself in headless Chrome (Google News JS
#               redirects resolve correctly inside a real browser)
snap_lock = threading.Lock()   # one Chrome at a time


def chrome_shot(url, out_path, width, height):
    if not os.path.exists(CHROME):
        raise RuntimeError('Google Chrome not found — needed for screenshots')
    cmd = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
           '--no-first-run', '--disable-extensions', '--mute-audio',
           f'--window-size={width},{height}', '--virtual-time-budget=12000',
           f'--screenshot={out_path}', url]
    subprocess.run(cmd, capture_output=True, timeout=60)
    if not os.path.exists(out_path) or os.path.getsize(out_path) < 4000:
        raise RuntimeError('screenshot came back empty')


def snap_clip(clip):
    """Capture the hero image for a clip; returns the path relative to DIR."""
    link = clip.get('link') or ''
    if not link:
        raise RuntimeError('clip has no link')
    out = os.path.join(SHOTS_DIR, f"{clip['id']}.png")
    rel = os.path.relpath(out, DIR)

    oembed = None
    if 'tiktok.com' in link:
        oembed = 'https://www.tiktok.com/oembed?url=' + urllib.parse.quote(link, safe='')
    elif 'youtube.com' in link or 'youtu.be' in link:
        oembed = 'https://www.youtube.com/oembed?url=' + urllib.parse.quote(link, safe='')
    if oembed:
        try:
            thumb = json.loads(http_get(oembed)).get('thumbnail_url')
            if thumb:
                with open(out, 'wb') as f:
                    f.write(http_get(thumb, timeout=20))
                if os.path.getsize(out) > 4000:
                    return rel
        except Exception:
            pass   # fall through to Chrome

    with snap_lock:
        if 'instagram.com/p/' in link or 'instagram.com/reel/' in link:
            chrome_shot(link.rstrip('/') + '/embed/captioned/', out, 550, 900)
        elif 'facebook.com' in link:
            embed = ('https://www.facebook.com/plugins/post.php?href='
                     + urllib.parse.quote(link, safe='') + '&width=500&show_text=true')
            chrome_shot(embed, out, 550, 900)
        else:
            chrome_shot(link, out, 900, 1000)
    return rel


# ── HTTP handler ─────────────────────────────────────────────────────────
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/days':
            days = []
            for f in sorted(os.listdir(DATA_DIR), reverse=True):
                # day files only — config/cache JSONs (keywords, secrets,
                # yt-channels…) live in the same folder
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json', f):
                    continue
                try:
                    with open(os.path.join(DATA_DIR, f)) as fh:
                        d = json.load(fh)
                    days.append({
                        'date': d.get('date', f[:-5]),
                        'clips': len(d.get('clips', [])),
                        'stories': len(d.get('stories', [])),
                        'fetched_at': d.get('fetched_at'),
                        'social_fetched_at': d.get('social_fetched_at')
                    })
                except Exception:
                    pass
            self._json(days)

        elif self.path.startswith('/api/day/'):
            raw = self.path.split('/')[-1].removesuffix('.json')
            day = load_day(raw)
            if day is not None:
                self._json(day)
            else:
                self.send_error(404)

        elif self.path == '/api/keywords':
            self._json(load_keywords())

        elif self.path == '/api/status':
            s = load_secrets()
            # supabase:false — local launcher saves to disk only, never to the cloud DB
            self._json({'apify': bool(s.get('apify_token')),
                        'supabase': False,
                        'mode': 'local'})

        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception:
            self._json({'ok': False, 'error': 'bad json'}); return

        if self.path == '/api/save':
            try:
                body['date'] = body.get('date') or datetime.now().strftime('%Y-%m-%d')
                save_day(body)
                self._json({'ok': True, 'saved': body['date']})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)})

        elif self.path == '/api/fetch':
            date = safe_date(body.get('date') or datetime.now().strftime('%Y-%m-%d'))
            try:
                day, mode = run_fetch(date, force=bool(body.get('force')))
                self._json({'ok': True, 'mode': mode, 'day': day})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)})

        elif self.path == '/api/snap':
            # Stateless: takes the link directly, returns the shot path.
            # The client stores it on the clip and persists — avoids racing
            # the debounced autosave.
            clip_id = re.sub(r'[^A-Za-z0-9_-]', '', str(body.get('clip_id', '')))[:40]
            link = body.get('link', '')
            if not clip_id or not link:
                self._json({'ok': False, 'error': 'clip_id and link required'}); return
            try:
                shot = snap_clip({'id': clip_id, 'link': link})
                self._json({'ok': True, 'shot': shot})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)[:160]})

        elif self.path == '/api/fetch-social':
            date = safe_date(body.get('date') or datetime.now().strftime('%Y-%m-%d'))
            try:
                day, mode = run_social_fetch(date, force=bool(body.get('force')))
                self._json({'ok': True, 'mode': mode, 'day': day})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)})

        elif self.path == '/api/keywords':
            try:
                with open(KW_FILE, 'w') as f:
                    json.dump(body, f, ensure_ascii=False, indent=1)
                self._json({'ok': True})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)})

        else:
            self.send_error(404)

    # ── helpers ──────────────────────────────────────────────────────────
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


# ── entry point ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    PORT = 8765
    os.chdir(DIR)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as srv:
        url = f'http://localhost:{PORT}/{PAGE}'
        print(f'\n  ✅  SPS Media Monitor  →  {url}')
        print(f'       Data saved to:      {DATA_DIR}')
        print(f'       Press Ctrl+C to stop\n')
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print('\n  Server stopped.')

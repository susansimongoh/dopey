// Synchronous API: fast Supabase-backed operations.
// Heavy fetching lives in the *-background functions.
import { getDay, putDay, listDays, getWatchlist, putWatchlist, ogImage, summarizeItems } from '../lib/sps.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && path === '/api/status') {
      return json({ apify: !!Netlify.env.get('APIFY_TOKEN'), supabase: !!Netlify.env.get('SUPABASE_URL'), mode: 'cloud' });
    }
    if (req.method === 'POST' && path === '/api/login') {
      const { email, password } = await req.json();
      const okEmail = (Netlify.env.get('ADMIN_EMAIL') || '').trim().toLowerCase();
      const okPass = Netlify.env.get('ADMIN_PASSWORD') || '';
      const token = Netlify.env.get('ADMIN_TOKEN') || okPass;
      if (!okPass) return json({ ok: false, error: 'Admin login not configured.' }, 503);
      const emailOk = !okEmail || (email || '').trim().toLowerCase() === okEmail;
      if (emailOk && password === okPass) return json({ ok: true, token });
      return json({ ok: false, error: 'Invalid email or password.' }, 401);
    }
    if (req.method === 'GET' && path === '/api/days') {
      return json(await listDays());
    }
    if (req.method === 'GET' && path.startsWith('/api/day/')) {
      const date = path.split('/').pop().replace(/\.json$/, '');
      const day = await getDay(date);
      return day ? json(day) : json({ error: 'not found' }, 404);
    }
    if (req.method === 'GET' && path === '/api/keywords') {
      return json(await getWatchlist());
    }
    if (req.method === 'POST' && path === '/api/keywords') {
      await putWatchlist(await req.json());
      return json({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/save') {
      const day = await req.json();
      if (!day.date) return json({ ok: false, error: 'no date' }, 400);
      await putDay(day);
      return json({ ok: true, saved: day.date });
    }
    if (req.method === 'POST' && path === '/api/summarize') {
      const { items } = await req.json();
      if (!items || !items.length) return json({ ok: true, results: [] });
      try { return json({ ok: true, results: await summarizeItems(items) }); }
      catch (e) { return json({ ok: false, error: String(e).slice(0, 200) }); }
    }
    if (req.method === 'POST' && path === '/api/snap') {
      // Cloud "snap" = resolve a hero image URL (no Chrome). Stateless:
      // the client stores the returned URL on the clip and persists.
      const { link } = await req.json();
      if (!link) return json({ ok: false, error: 'no link' }, 400);
      try { return json({ ok: true, shot: await ogImage(link) }); }
      catch (e) { return json({ ok: false, error: String(e).slice(0, 120) }); }
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
};

export const config = {
  path: ['/api/status', '/api/login', '/api/days', '/api/day/*', '/api/keywords', '/api/save', '/api/snap', '/api/summarize'],
};

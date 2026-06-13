// Synchronous API: fast Supabase-backed operations.
// Heavy fetching lives in the *-background functions.
import { getDay, putDay, listDays, getWatchlist, putWatchlist, ogImage, summarizeItems,
  hashPassword, makeToken, verifyToken, getUsers, putUsers, findUser } from '../lib/sps.mjs';

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
      const u = await findUser(email);
      if (!u || !u.hash) return json({ ok: false, error: 'Invalid email or password.' }, 401);
      if ((await hashPassword(email, password)) !== u.hash) return json({ ok: false, error: 'Invalid email or password.' }, 401);
      const token = await makeToken(u.email, u.role);
      return json({ ok: true, token, role: u.role, email: u.email, name: u.name || '' });
    }
    if (path === '/api/users') {
      // user management — TMG admin only
      const auth = await verifyToken(req.headers.get('x-admin-token'));
      if (!auth || auth.role !== 'tmg_admin') return json({ ok: false, error: 'Forbidden' }, 403);
      if (req.method === 'GET') {
        const list = await getUsers();
        return json({ ok: true, users: list.map((x) => ({ email: x.email, name: x.name || '', role: x.role })) });
      }
      if (req.method === 'POST') {
        const { action, email, name, role, password } = await req.json();
        const list = await getUsers();
        const i = list.findIndex((x) => x.email.toLowerCase() === (email || '').toLowerCase());
        if (action === 'delete') {
          if (email.toLowerCase() === auth.email.toLowerCase()) return json({ ok: false, error: "You can't delete your own account." }, 400);
          await putUsers(list.filter((x) => x.email.toLowerCase() !== (email || '').toLowerCase()));
          return json({ ok: true });
        }
        if (!email || !role) return json({ ok: false, error: 'Email and role are required.' }, 400);
        if (!['tmg_admin', 'tmg_user', 'client'].includes(role)) return json({ ok: false, error: 'Invalid role.' }, 400);
        const rec = i >= 0 ? { ...list[i] } : { email: email.toLowerCase() };
        rec.name = (name ?? rec.name) || '';
        rec.role = role;
        if (password) rec.hash = await hashPassword(email, password);
        if (i < 0 && !rec.hash) return json({ ok: false, error: 'A password is required for a new user.' }, 400);
        if (i >= 0) list[i] = rec; else list.push(rec);
        await putUsers(list);
        return json({ ok: true });
      }
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
  path: ['/api/status', '/api/login', '/api/users', '/api/days', '/api/day/*', '/api/keywords', '/api/save', '/api/snap', '/api/summarize'],
};

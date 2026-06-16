// Synchronous API: fast Supabase-backed operations.
// Heavy fetching lives in the *-background functions.
import { getDay, putDay, listDays, getWatchlist, putWatchlist, ogImage, summarizeItems,
  hashPassword, makeToken, verifyToken, getUsers, putUsers, findUser, rebuildStories, pruneClips,
  listProjects, putProjects } from '../lib/sps.mjs';

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
      if (!u || !u.hash) return json({ ok: false, error: u && u.invite ? 'Set your password first using the invite code from your admin.' : 'Invalid email or password.' }, 401);
      if ((await hashPassword(email, password)) !== u.hash) return json({ ok: false, error: 'Invalid email or password.' }, 401);
      const token = await makeToken(u.email, u.role);
      return json({ ok: true, token, role: u.role, email: u.email, name: u.name || '', projects: u.projects || [] });
    }
    // User redeems an invite code to set their OWN password, then is signed in.
    if (req.method === 'POST' && path === '/api/set-password') {
      const { email, code, password } = await req.json();
      if (!password || String(password).length < 6) return json({ ok: false, error: 'Password must be at least 6 characters.' }, 400);
      const list = await getUsers();
      const i = list.findIndex((x) => x.email.toLowerCase() === (email || '').toLowerCase());
      const u = i >= 0 ? list[i] : null;
      if (!u || !u.invite) return json({ ok: false, error: 'No pending invite for that email. Ask your admin for a code.' }, 400);
      if ((await hashPassword(u.email, (code || '').trim().toUpperCase())) !== u.invite) return json({ ok: false, error: 'That invite code is not valid.' }, 401);
      u.hash = await hashPassword(u.email, password);
      delete u.invite;
      list[i] = u;
      await putUsers(list);
      return json({ ok: true, token: await makeToken(u.email, u.role), role: u.role, email: u.email, name: u.name || '', projects: u.projects || [] });
    }
    if (path === '/api/users') {
      // user management — TMG admin only
      const auth = await verifyToken(req.headers.get('x-admin-token'));
      if (!auth || auth.role !== 'tmg_admin') return json({ ok: false, error: 'Forbidden' }, 403);
      if (req.method === 'GET') {
        const list = await getUsers();
        return json({ ok: true, users: list.map((x) => ({ email: x.email, name: x.name || '', role: x.role, pending: !x.hash, projects: x.projects || [] })) });
      }
      if (req.method === 'POST') {
        const { action, email, name, role, password, projects } = await req.json();
        const list = await getUsers();
        const i = list.findIndex((x) => x.email.toLowerCase() === (email || '').toLowerCase());
        // 6-char human-friendly one-time code (no ambiguous chars)
        const genCode = () => { const b = new Uint8Array(6); crypto.getRandomValues(b); return [...b].map((x) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[x % 31]).join(''); };
        if (action === 'delete') {
          if (email.toLowerCase() === auth.email.toLowerCase()) return json({ ok: false, error: "You can't delete your own account." }, 400);
          await putUsers(list.filter((x) => x.email.toLowerCase() !== (email || '').toLowerCase()));
          return json({ ok: true });
        }
        // Issue/re-issue an invite code so the user sets their own password.
        if (action === 'invite') {
          if (i < 0) return json({ ok: false, error: 'No such user.' }, 400);
          const code = genCode();
          list[i] = { ...list[i], invite: await hashPassword(list[i].email, code) };
          await putUsers(list);
          return json({ ok: true, inviteCode: code, email: list[i].email });
        }
        if (!email || !role) return json({ ok: false, error: 'Email and role are required.' }, 400);
        if (!['tmg_admin', 'tmg_user', 'client'].includes(role)) return json({ ok: false, error: 'Invalid role.' }, 400);
        const rec = i >= 0 ? { ...list[i] } : { email: email.toLowerCase() };
        rec.name = (name ?? rec.name) || '';
        rec.role = role;
        if (Array.isArray(projects)) rec.projects = projects;   // which projects this user can see (admins ignore it)
        let inviteCode = null;
        if (password) {
          rec.hash = await hashPassword(email, password);   // admin set it directly (optional)
          delete rec.invite;
        } else if (!rec.hash) {
          // No password yet → issue an invite code so the user sets their own.
          inviteCode = genCode();
          rec.invite = await hashPassword(rec.email, inviteCode);
        }
        if (i >= 0) list[i] = rec; else list.push(rec);
        await putUsers(list);
        return json({ ok: true, inviteCode, email: rec.email });
      }
    }
    // Project registry. GET returns the projects this signed-in user may see
    // (admins: all; others: only those in their assignment). POST is admin-only.
    if (path === '/api/projects') {
      const auth = await verifyToken(req.headers.get('x-admin-token'));
      const all = await listProjects();
      if (req.method === 'GET') {
        if (!auth) return json({ ok: false, error: 'Sign in.' }, 401);
        let visible = all;
        if (auth.role !== 'tmg_admin') {
          const u = await findUser(auth.email);
          const assigned = new Set((u && u.projects) || []);
          visible = all.filter((p) => assigned.has(p.id));
        }
        return json({ ok: true, projects: visible, role: auth.role });
      }
      if (req.method === 'POST') {
        if (!auth || auth.role !== 'tmg_admin') return json({ ok: false, error: 'Forbidden' }, 403);
        const { action, project } = await req.json();
        let list = all;
        if (action === 'delete') list = list.filter((p) => p.id !== project.id);
        else { const i = list.findIndex((p) => p.id === project.id); if (i >= 0) list[i] = { ...list[i], ...project }; else list.push(project); }
        await putProjects(list);
        return json({ ok: true, projects: list });
      }
    }
    const proj = url.searchParams.get('project') || 'sps';
    if (req.method === 'GET' && path === '/api/days') {
      return json(await listDays(proj));
    }
    if (req.method === 'GET' && path.startsWith('/api/day/')) {
      const date = path.split('/').pop().replace(/\.json$/, '');
      const day = await getDay(proj, date);
      return day ? json(day) : json({ error: 'not found' }, 404);
    }
    if (req.method === 'GET' && path === '/api/keywords') {
      return json(await getWatchlist(proj));
    }
    if (req.method === 'POST' && path === '/api/keywords') {
      const { project, ...cfg } = await req.json();
      await putWatchlist(project || proj, cfg);
      return json({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/save') {
      const day = await req.json();
      if (!day.date) return json({ ok: false, error: 'no date' }, 400);
      await putDay(day.project || proj, day);
      return json({ ok: true, saved: day.date });
    }
    if (req.method === 'POST' && path === '/api/regen') {
      // Atomic server-side story rebuild for one day (no browser, no race). Open
      // like /api/save — it only regenerates stories from a day's existing clips.
      const { date, project } = await req.json();
      if (!date) return json({ ok: false, error: 'date required' }, 400);
      const p = project || proj;
      const day = await getDay(p, date);
      if (!day || !(day.clips || []).length) return json({ ok: true, date, stories: 0, note: 'no clips' });
      const cfg = await getWatchlist(p);
      const pruned = pruneClips(day, cfg);   // drop clips that no longer pass the relevance gate
      const updated = await rebuildStories(day, cfg);
      await putDay(p, updated);
      const stories = (updated.stories || []);
      return json({ ok: true, date, pruned, clips: (updated.clips || []).length, stories: stories.length, fallbacks: stories.filter((s) => s.llm === false).length });
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
  path: ['/api/status', '/api/login', '/api/set-password', '/api/users', '/api/projects', '/api/days', '/api/day/*', '/api/keywords', '/api/save', '/api/regen', '/api/snap', '/api/summarize'],
};

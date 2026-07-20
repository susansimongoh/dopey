// Scheduled function: every morning at 09:45 Singapore time (01:45 UTC), kick off
// the day's news fetch + social sweep for EVERY project, so each dashboard is
// populated before anyone opens it. Only triggers the background functions
// (which return 202 and do the long-running work), so this returns quickly.
import { listProjects } from '../lib/sps.mjs';

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL || 'https://spsmedia.netlify.app';
  const today = new Date().toISOString().slice(0, 10);   // at 01:45 UTC the SGT date matches
  const post = (path, project) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today, project }),
  }).then((r) => r.status).catch((e) => 'ERR ' + e.message);

  let projects = [{ id: 'sps' }];
  try { projects = await listProjects(); } catch (e) { console.error('cron list projects failed', e); }
  for (const p of projects) {
    if (p.paused) { console.log(`cron-daily ${today} [${p.id}]: paused, skipped`); continue; }
    const news = await post('/api/fetch', p.id);
    const social = await post('/api/fetch-social', p.id);
    console.log(`cron-daily ${today} [${p.id}]: fetch=${news} social=${social}`);
  }
};

// Cron is UTC. 09:45 Asia/Singapore (UTC+8) = 01:45 UTC, weekdays only (Mon–Fri;
// at 01:45 UTC the UTC weekday == SGT weekday). NOTE (user directive, 20 Jul): the
// sweep runs at 09:45 but the REPORT-day cutoff is 10:45 (see reportDay in sps.mjs)
// — anything published after 10:45 belongs to the NEXT day's report. Posts published
// 09:45–10:45 miss their same-morning sweep; the next weekday's sweep (7-day social
// lookback / outlet RSS) captures them and reportDay buckets them back onto the
// correct day's page, so they land a day late in the archive but on the right page.
export const config = { schedule: '45 1 * * 1-5' };

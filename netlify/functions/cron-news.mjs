// Scheduled function: NEWS-ONLY top-up fetches, three times daily, SEVEN days a
// week (11:00 / 15:00 / 19:00 SGT). Exists because outlet RSS feeds rotate fast —
// CNA's outbound feed holds only ~20 items (hours of output), so the single 09:45
// full sweep samples a fraction of the day's stories, and anything published in
// the 09:45→10:45 window on a Friday used to be unrecoverable by Monday.
// News fetching is FREE (RSS + capped article fetches; no Apify), and reportDay
// bucketing files each item onto the correct report page automatically — including
// weekend items that would otherwise age out of the feeds before Monday's sweep.
// Stories for new clips are rebuilt by the next full sweep / dashboard open, same
// as always. The 09:45 weekday full sweep (cron-daily) is unchanged.
import { listProjects } from '../lib/sps.mjs';

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL || 'https://spsmedia.netlify.app';
  const today = new Date().toISOString().slice(0, 10);   // 03:00/07:00/11:00 UTC → UTC date == SGT date
  let projects = [{ id: 'sps' }];
  try { projects = await listProjects(); } catch (e) { console.error('cron-news list projects failed', e); }
  for (const p of projects) {
    if (p.paused) { console.log(`cron-news ${today} [${p.id}]: paused, skipped`); continue; }
    const status = await fetch(`${base}/api/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today, project: p.id }),
    }).then((r) => r.status).catch((e) => 'ERR ' + e.message);
    console.log(`cron-news ${today} [${p.id}]: fetch=${status}`);
  }
};

// Cron is UTC. 03:00/07:00/11:00 UTC = 11:00/15:00/19:00 SGT, every day incl.
// weekends (weekend stories rotate out of the 20-item feeds before Monday).
export const config = { schedule: '0 3,7,11 * * *' };

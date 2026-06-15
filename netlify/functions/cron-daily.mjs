// Scheduled function: every morning at 09:45 Singapore time (01:45 UTC), kick off
// the day's news fetch + social sweep so the dashboard is populated before anyone
// opens it. It only TRIGGERS the existing background functions (which return 202
// and do the long-running work), so this returns quickly.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL || 'https://spsmedia.netlify.app';
  const today = new Date().toISOString().slice(0, 10);   // at 01:45 UTC the SGT date matches
  const post = (path) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today }),
  }).then((r) => r.status).catch((e) => 'ERR ' + e.message);

  const news = await post('/api/fetch');          // free RSS sweep
  const social = await post('/api/fetch-social');  // Apify sweep (~$0.85)
  console.log(`cron-daily ${today}: fetch=${news} social=${social}`);
};

// Cron is UTC. 09:45 Asia/Singapore (UTC+8) = 01:45 UTC, daily.
export const config = { schedule: '45 1 * * *' };

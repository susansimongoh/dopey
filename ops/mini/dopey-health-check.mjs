#!/usr/bin/env node
// Dopey daily health check — runs on the always-on Mac mini via launchd
// (sg.tmg.dopey-health.plist), weekday mornings after the 09:45 SGT sweep.
//
// Reads today's monitor_days row from Supabase (read-only, anon key) and alerts
// Slack when the sweep didn't run or recorded errors — the check that would have
// caught the Jul-2026 Apify usage-cap outage on day 1 instead of day 3.
// Silent on success (zero-noise): one log line, no Slack message.
//
// Config JSON (default ~/.dopey-health.json, override with --config <path>):
//   {
//     "supabase_url": "https://<project-ref>.supabase.co",
//     "supabase_anon_key": "<anon key>",
//     "slack_webhook_url": "https://hooks.slack.com/services/…",   // optional
//     "project": "sps"
//   }
// --date YYYY-MM-DD overrides "today" (for testing).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const cfgPath = arg('--config') || `${homedir()}/.dopey-health.json`;
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
catch (e) { console.error(`[dopey-health] cannot read config ${cfgPath}: ${e.message}`); process.exit(1); }
const project = cfg.project || 'sps';

// "Today" in SGT (UTC+8) — the mini may or may not be set to SGT, so don't trust local time.
const sgtNow = new Date(Date.now() + 8 * 3600e3);
const date = arg('--date') || sgtNow.toISOString().slice(0, 10);
const weekday = new Date(date + 'T00:00:00Z').getUTCDay();   // date is an SGT calendar day
if (weekday === 0 || weekday === 6) { console.log(`[dopey-health] ${date} is a weekend (no sweep scheduled) — OK`); process.exit(0); }

const alert = async (lines) => {
  const text = `:rotating_light: *Dopey health check — ${date}*\n` + lines.map((l) => `• ${l}`).join('\n')
    + `\nDashboard: https://spsmedia.netlify.app`;
  console.error(`[dopey-health] ALERT\n${text}`);
  if (cfg.slack_webhook_url) {
    try {
      const r = await fetch(cfg.slack_webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) console.error(`[dopey-health] slack post failed: HTTP ${r.status}`);
    } catch (e) { console.error(`[dopey-health] slack post failed: ${e.message}`); }
  }
  process.exit(1);
};

try {
  const r = await fetch(`${cfg.supabase_url}/rest/v1/monitor_days?project=eq.${project}&date=eq.${date}&select=payload`, {
    headers: { apikey: cfg.supabase_anon_key, Authorization: `Bearer ${cfg.supabase_anon_key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) await alert([`Supabase query failed: HTTP ${r.status}`]);
  const rows = await r.json();
  const p = rows[0] && rows[0].payload;
  const problems = [];
  if (!p) problems.push(`no day record for ${date} — the 09:45 sweep did not run at all`);
  else {
    if (!p.fetched_at) problems.push('news fetch missing (fetched_at empty)');
    if (!p.social_fetched_at) problems.push('social sweep missing (social_fetched_at empty) — check Netlify cron + Apify');
    const errs = [...(p.fetch_errors || []), ...(p.social_errors || [])];
    if (errs.length) problems.push(`errors recorded: ${errs.slice(0, 3).join(' | ')}${errs.length > 3 ? ` (+${errs.length - 3} more)` : ''}`);
    const clips = (p.clips || []).length;
    if (!problems.length && clips === 0) problems.push('sweep ran but 0 clips passed the gate — possibly fine (quiet day), worth a glance');
  }
  if (problems.length) await alert(problems);
  console.log(`[dopey-health] ${date} OK — clips=${(p.clips || []).length}, news=${p.fetched_at}, social=${p.social_fetched_at}`);
} catch (e) {
  await alert([`health check crashed: ${String(e).slice(0, 200)}`]);
}

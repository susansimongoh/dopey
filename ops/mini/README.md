# Dopey ops on the Mac mini

Dopey's production pipeline (daily sweeps, gate, dashboard) is fully cloud-based —
Netlify + Supabase — and needs no local machine. This folder holds the small ops
layer that DOES belong on the always-on mini: the daily health check that alerts
Slack when a morning sweep fails (missing cron run, Apify errors, empty day).

## One-time setup

1. **Clone the repo OUTSIDE `~/Documents`** (macOS TCC blocks launchd jobs from
   reading Documents):
   ```
   git clone git@github.com:susansimongoh/dopey.git ~/Projects/Dopey
   ```

2. **Create the config** at `~/.dopey-health.json` (chmod 600):
   ```json
   {
     "supabase_url": "https://<project-ref>.supabase.co",
     "supabase_anon_key": "<anon key — Supabase dashboard → Settings → API>",
     "slack_webhook_url": "<optional — Slack incoming webhook for alerts>",
     "project": "sps"
   }
   ```
   Without `slack_webhook_url`, alerts only go to the log file.

3. **Test it by hand** (needs node ≥ 18):
   ```
   node ~/Projects/Dopey/ops/mini/dopey-health-check.mjs            # today
   node ~/Projects/Dopey/ops/mini/dopey-health-check.mjs --date 2026-07-20   # known-bad day → alert
   ```

4. **Install the launchd job** — edit the plist's two placeholders first
   (`__NODE__` = `which node`, `__REPO__` = the clone path):
   ```
   sed -e "s|__NODE__|$(which node)|" -e "s|__REPO__|$HOME/Projects/Dopey|" \
     ~/Projects/Dopey/ops/mini/sg.tmg.dopey-health.plist \
     > ~/Library/LaunchAgents/sg.tmg.dopey-health.plist
   launchctl load ~/Library/LaunchAgents/sg.tmg.dopey-health.plist
   ```
   Runs weekdays 10:15 (mini local time — set the mini to SGT). Logs: `/tmp/dopey-health.log`.

## What it checks (weekdays only)

- day record exists for today (else: the 09:45 cron didn't fire)
- `fetched_at` + `social_fetched_at` present (news + social sweeps completed)
- `fetch_errors` / `social_errors` empty (else lists them — e.g. Apify
  `usage-limit-exceeded`)
- clips > 0 (soft warning — a quiet day can legitimately be 0)

Silent when healthy; Slack alert + exit 1 when not.

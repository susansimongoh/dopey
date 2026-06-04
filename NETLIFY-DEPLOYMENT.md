# Netlify + Supabase Deployment Guide

## Quick Start (10 minutes)

### 1. Set up Supabase

- Go to https://supabase.com → create a new project
- Wait for it to initialize
- Go to **SQL Editor** and run the SQL from `SUPABASE-SETUP.md`
- Go to **Settings → API** and copy:
  - `Project URL` (e.g., `https://xxxx.supabase.co`)
  - `anon public` key

### 2. Deploy to Netlify

```bash
cd /path/to/sps-media-monitor-project

# Install Netlify CLI
npm install -g netlify-cli

# Connect your project to Netlify
netlify init

# Set environment variables
netlify env:set APIFY_TOKEN "apify_api_GSPIERMUCKGeEl1QqQrZSYShnzUdN30EGLFr"
netlify env:set SUPABASE_URL "https://your-project.supabase.co"
netlify env:set SUPABASE_ANON_KEY "your-anon-key"

# Deploy
netlify deploy --prod
```

### 3. Update dashboard HTML

Replace the old integration includes with:

```html
<!-- Remove these old lines: -->
<!-- <script src="apify-data-transformer.js"></script> -->
<!-- <script src="apify-tier3-keyword-search.js"></script> -->
<!-- <script src="sps-media-monitor-apify-integration.js"></script> -->

<!-- Add this new line instead: -->
<script src="sps-media-monitor-supabase-integration.js"></script>

<!-- Add a button to trigger monitoring (optional, insert near top of dashboard) -->
<button id="fetch-live-data-btn" style="position: fixed; top: 10px; right: 60px; z-index: 9999; padding: 8px 16px; background: #0070f3; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
  📡 Fetch Live Data
</button>

<script>
  // Add click handler when dashboard is ready
  setTimeout(() => {
    const btn = document.getElementById("fetch-live-data-btn");
    if (btn && window.SuperbaseIntegration) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "⏳ Fetching...";
        try {
          const clips = await window.SuperbaseIntegration.runFullMonitoring();
          if (clips.length > 0) {
            S.clips = [];
            clips.forEach(c => { c.id = cid++; S.clips.push(c); });
            renderDash();
            renderClips();
            badges();
          }
        } catch (e) {
          alert("Error: " + e.message);
        }
        btn.disabled = false;
        btn.textContent = "📡 Fetch Live Data";
      });
    }
  }, 500);
</script>
```

### 4. Test the setup

1. Open your deployed dashboard (e.g., `https://your-site.netlify.app`)
2. The dashboard will load any existing clips from Supabase
3. Click "Fetch Live Data" button
4. Check Netlify function logs:
   - In Netlify Dashboard → Functions tab
   - Should see `[Function] Starting Apify monitoring run...`
5. After 1-2 minutes, new clips will appear on the dashboard

## Architecture

```
Dashboard (HTML/JS)
    ↓
    ├─→ Netlify Function (/.netlify/functions/run-apify-monitoring)
    │       ↓
    │       └─→ Apify API (server-to-server, no CORS)
    │
    └─→ Supabase (stores clips)
            ↓
            └─→ Fetches clips for display
```

## Environment Variables

Set these in Netlify Dashboard → Site settings → Build & deploy → Environment:

| Variable | Value | Source |
|----------|-------|--------|
| `APIFY_TOKEN` | Your Apify API token | Apify dashboard |
| `SUPABASE_URL` | Project URL | Supabase API settings |
| `SUPABASE_ANON_KEY` | Anon public key | Supabase API settings |

## Monitoring Function Performance

In Netlify Dashboard:
1. **Functions** tab → `run-apify-monitoring`
2. Monitor:
   - Duration per run
   - Error rate
   - Success rate

## Scheduling (Optional)

To run monitoring automatically every morning at 9 AM:

**Option A: External Cron Service**
- Use EasyCron.com or similar
- Set cron job to POST to: `https://your-site.netlify.app/.netlify/functions/run-apify-monitoring`
- Runs every morning at 9 AM UTC

**Option B: Supabase pg_cron**
- Run this SQL in Supabase:
```sql
select cron.schedule('daily-apify-monitoring', '0 9 * * *', 
  'select http_post(''https://your-site.netlify.app/.netlify/functions/run-apify-monitoring'', null, null) as request_id'
);
```

**Option C: GitHub Actions**
- Create `.github/workflows/daily-monitoring.yml`:
```yaml
name: Daily Monitoring
on:
  schedule:
    - cron: '0 9 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Netlify Function
        run: |
          curl -X POST https://your-site.netlify.app/.netlify/functions/run-apify-monitoring
```

## Troubleshooting

**"Supabase error: 401"**
- Check `SUPABASE_ANON_KEY` is correct in Netlify environment
- Verify anon public key (not service role key)

**"APIFY_TOKEN not set"**
- Check `APIFY_TOKEN` in Netlify environment
- Redeploy after setting env variables

**"Monitoring completed with no clips"**
- Apify actors may have failed
- Check Apify dashboard to see actor run status
- Verify account has API credits

**Function times out (>10 seconds)**
- Apify runs take time
- Netlify functions have 10s limit by default
- Upgrade to Pro plan for longer timeouts, or increase polling delay in function

## Costs

**Apify:**
- Free tier: 25,000 API calls/month
- ~400-500 calls per 2x daily monitoring
- Within free tier ✓

**Netlify:**
- Free tier: 125,000 function invocations/month
- 2 runs/day = ~60/month
- Within free tier ✓

**Supabase:**
- Free tier: 500 MB database storage
- ~1-2 KB per clip × 100/day = ~50 KB/month
- Within free tier ✓

All three services stay on free tier with this setup.

## Next Steps

1. Deploy the Netlify function
2. Set up Supabase table
3. Update dashboard HTML with new integration script
4. Click "Fetch Live Data" button to test
5. (Optional) Set up automatic daily scheduling

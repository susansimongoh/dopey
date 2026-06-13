# SPS Media Monitor – Apify Integration Setup Guide

## Overview

This guide walks you through implementing the full Apify-powered monitoring system for the SPS Media Monitor dashboard, replacing the unpublished Apify Actors with maintained alternatives.

**Three-tier architecture:**
- **Tier 1:** High-priority monitoring (news outlets, government, activist accounts)
- **Tier 2:** Semi-automated CARE Network partner monitoring
- **Tier 3:** Keyword search automation across platforms

---

## Prerequisites

1. **Apify Account** – [Sign up at apify.com](https://apify.com)
2. **API Token** – Get from Account Settings → API tokens
3. **JavaScript files:**
   - `apify-tier1-config.json`
   - `apify-tier2-config.json`
   - `apify-tier3-keyword-search.js`
   - `apify-data-transformer.js`
   - `sps-media-monitor-apify-integration.js`
4. **Updated dashboard** – `sps-media-monitor.html` with integration script loaded

---

## Step 1: Get Your Apify API Token

1. Log into [apify.com](https://apify.com)
2. Click **Account** (top right) → **Integrations**
3. Copy your **API token**
4. Keep this private – don't commit it to git

---

## Step 2: Set Up the Dashboard

### Option A: Direct Script Injection (Simplest)

Edit `sps-media-monitor.html` and add these lines before the closing `</body>` tag:

```html
<!-- Apify Integration -->
<script src="apify-data-transformer.js"></script>
<script src="apify-tier3-keyword-search.js"></script>
<script src="sps-media-monitor-apify-integration.js"></script>

<script>
  // Set API token (from environment or user input)
  window.APIFY_TOKEN = localStorage.getItem("APIFY_TOKEN") || prompt("Enter Apify API token:");
</script>
```

### Option B: Environment Variable (Recommended for Production)

Set the token in your deployment environment:

```bash
export APIFY_TOKEN="your-api-token-here"
```

Then in HTML:

```html
<script>
  window.APIFY_TOKEN = process.env.APIFY_TOKEN || localStorage.getItem("APIFY_TOKEN");
</script>
```

---

## Step 3: Configure Data Sources

### Tier 1 Configuration

`apify-tier1-config.json` includes:

**News outlets:**
- Straits Times, CNA, Mothership, Rice Media, AsiaOne, TODAY Online

**Government accounts:**
- Ministry of Home Affairs, Central Narcotics Bureau

**High-priority activists (yellow-highlighted in MM Search Guide):**
- ADPAN, AADP, The Online Citizen, Human Rights Watch
- M Ravi, Kirsten Han, Jolovan Wham, PJ Thum, Andrew Loh, Elijah Tay
- Transformative Justice Collective, Wake Up Singapore, New Naratif

**Configuration is automatic** – no changes needed unless you want to add/remove accounts.

### Tier 2 Configuration

`apify-tier2-config.json` monitors CARE Network partners:
- Yellow Ribbon Singapore
- Singapore Anti-Narcotics Association (SANA)
- Singapore After-Care Association (SACA)
- Prison Fellowship Singapore
- The Common Folks

### Tier 3 Configuration

`apify-tier3-keyword-search.js` searches for:
- "Changi Prison"
- "Singapore Prison Service"
- "Inside Maximum security"
- "Death row Singapore"
- "Death penalty Singapore"
- "Yellow Ribbon Singapore"

Runs keyword searches on Facebook, TikTok, and X/Twitter.

---

## Step 4: Run Your First Monitoring Session

### From the Dashboard UI

1. Open `sps-media-monitor.html` in a browser
2. The dashboard will automatically run on load (if APIFY_TOKEN is set)
3. Check the green banner for "Live Apify scrape" status
4. Clips will populate the Dashboard and Clips views

### From Command Line (Node.js)

```javascript
const ApifyIntegration = require('./sps-media-monitor-apify-integration.js');

(async () => {
  // Run Tier 1 + Tier 2 monitoring
  const clips = await ApifyIntegration.runFullMonitoring({ 
    tier1: true, 
    tier2: true, 
    tier3: false 
  });

  console.log(`Collected ${clips.length} clips`);
  
  // Save to JSON
  const fs = require('fs');
  fs.writeFileSync('clips-output.json', JSON.stringify(clips, null, 2));
})();
```

---

## Step 5: Schedule Daily Runs

### Option A: Browser-Based (Cloud Functions)

Deploy as a Cloudflare Worker or AWS Lambda that hits the dashboard:

```javascript
// Runs monitoring on a schedule
export async function scheduled(event, env, ctx) {
  const response = await fetch('https://your-domain.com/sps-media-monitor.html', {
    method: 'POST',
    body: JSON.stringify({ action: 'run_monitoring' })
  });
  return response;
}
```

### Option B: Node.js Scheduler (Local/VPS)

Install `node-cron`:

```bash
npm install node-cron
```

Create `scheduler.js`:

```javascript
const cron = require('node-cron');
const ApifyIntegration = require('./sps-media-monitor-apify-integration.js');

// Run at 09:00 and 17:00 SGT every day
cron.schedule('0 9 * * *', async () => {
  console.log('Running morning monitoring...');
  const clips = await ApifyIntegration.runFullMonitoring({ 
    tier1: true, 
    tier2: true, 
    tier3: false 
  });
  console.log(`Morning: ${clips.length} clips collected`);
});

cron.schedule('0 17 * * *', async () => {
  console.log('Running evening monitoring...');
  const clips = await ApifyIntegration.runFullMonitoring({ 
    tier1: true, 
    tier2: true, 
    tier3: true  // Include keyword searches for evening
  });
  console.log(`Evening: ${clips.length} clips collected`);
});

console.log('Scheduler started');
```

Run with: `node scheduler.js`

### Option C: Cron (Linux/macOS)

Add to `crontab -e`:

```cron
# Morning monitoring at 09:00 SGT
0 1 * * * curl -X POST https://your-domain.com/api/monitoring/run?tiers=1,2

# Evening monitoring at 17:00 SGT
0 9 * * * curl -X POST https://your-domain.com/api/monitoring/run?tiers=1,2,3
```

---

## Step 6: Store Results in Supabase

The dashboard already has Supabase integration (`apiSave()`). Results are automatically saved after each run.

**Update the Supabase connection in the HTML:**

```javascript
const SUPABASE_URL = 'your-supabase-url';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

Get these from your Supabase project settings.

---

## Troubleshooting

### "APIFY_TOKEN not set"

**Fix:** Set the token in localStorage or as a window variable:

```javascript
localStorage.setItem("APIFY_TOKEN", "your-token-here");
location.reload();
```

### Actor runs timeout

**Reason:** Actors take time to complete (typically 30 seconds – 5 minutes depending on load)

**Fix:** Increase `maxWaitMs` in the integration script:

```javascript
APIFY_CONFIG.maxWaitMs = 600000; // 10 minutes
```

### Login-wall platforms (Instagram, Facebook) return no data

**Reason:** These platforms have stricter access controls

**Solutions:**

1. **Public accounts only** – Actors can only scrape public profiles
2. **Rate limiting** – Space requests 2-3 seconds apart
3. **Alternative:** Use Apify's first-party actors which have better auth support
4. **Fallback:** Show platform cards (branded thumbnails) when images can't be fetched

### Engagement metrics are 0

**Reason:** Platform-specific limitations:
- Facebook: Doesn't expose view counts publicly
- Instagram: Share counts not available
- TikTok: Should always have views/likes/comments

**Fix:** Check the data transformer is handling each platform correctly. Some metrics may not be available.

---

## Data Quality & Deduplication

The dashboard automatically:

1. **Deduplicates** posts by URL across sources (if same article appears on multiple outlets)
2. **Merges engagement metrics** (takes the highest count if post appears twice)
3. **Recalculates traction** based on merged engagement
4. **Validates** date format and required fields

See `apify-data-transformer.js` for the deduplication logic.

---

## Performance Notes

### API Costs

- Free tier: ~25,000 API calls/month
- Tier 1 run: ~50-100 API calls
- Tier 2 run: ~30-50 API calls
- Tier 3 run: ~150 API calls (three platforms × keyword searches)

**Daily monitoring (2x/day):** ~400-500 calls/day = **~12,000/month** (within free tier)

### Run Times

| Tier | Typical Duration | Actors |
|------|------------------|--------|
| 1 | 3–5 minutes | 3–5 runs in parallel |
| 2 | 2–4 minutes | 5–7 runs sequentially |
| 3 | 5–10 minutes | 3 keyword searches |
| Full | 10–15 minutes | All tiers |

---

## File Reference

| File | Purpose |
|------|---------|
| `apify-tier1-config.json` | News outlets, government, activists list |
| `apify-tier2-config.json` | CARE Network partners config |
| `apify-tier3-keyword-search.js` | Keyword search automation + Apify task submission |
| `apify-data-transformer.js` | Converts Actor outputs → dashboard format |
| `sps-media-monitor-apify-integration.js` | Main integration module |
| `sps-media-monitor.html` | Dashboard (updated with script includes) |

---

## Workarounds for Unpublished Actors

### Original Problem
Apify unpublished:
- Social Media Brand Monitor (Multi-Platform Mentions)
- Facebook Pages & Posts Scraper

### New Solution
Replaced with maintained Apify Actors:

| Function | Old Actor | New Actor |
|----------|-----------|-----------|
| Facebook monitoring | Facebook Pages & Posts Scraper | [facebook-comments-reactions](https://apify.com/apify/facebook-comments-reactions) ✅ |
| Instagram monitoring | Social Media Brand Monitor | [instagram-scraper](https://apify.com/bnkysz/instagram-scraper) ✅ |
| TikTok monitoring | Social Media Brand Monitor | [tiktok-video-scraper](https://apify.com/clockworks/tiktok-video-scraper) ✅ |
| YouTube monitoring | Social Media Brand Monitor | [youtube-scraper](https://apify.com/apify/youtube-scraper) ✅ |
| X/Twitter monitoring | – | [twitter-scraper](https://apify.com/apify/twitter-scraper) ✅ |

All replacement Actors are:
- ✅ Actively maintained
- ✅ Commonly used (100k+ usage)
- ✅ Recent updates
- ✅ Public documentation

---

## Next Steps

1. ✅ Set up Apify token
2. ✅ Add integration scripts to dashboard
3. ✅ Run first monitoring session
4. ✅ Schedule daily runs
5. ✅ Monitor performance & adjust as needed
6. Optional: Fine-tune account/keyword lists based on first week's results

---

## Support

- **Apify Issues** – [Apify Community Forum](https://apify.com/community)
- **Actor Documentation** – Check each Actor's README on apify.com
- **Dashboard Issues** – Review browser console for errors (F12 → Console)

---

Last Updated: June 2026
Version: 2.0 (Apify Integration)

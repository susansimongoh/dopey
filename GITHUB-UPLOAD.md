# Files to Upload to GitHub

## Folder Structure

Copy these files to your GitHub repository in this structure:

```
your-repo/
├── netlify/
│   └── functions/
│       └── run-apify-monitoring.js          ← NEW
├── sps-media-monitor.html                    ← UPDATED
├── sps-media-monitor-supabase-integration.js ← NEW
├── netlify.toml                              ← NEW (if not exists)
└── .gitignore                                ← NEW (if not exists)
```

## Files to Copy

### 1. Netlify Function
**File:** `netlify/functions/run-apify-monitoring.js`

Copy from: `/Documents/Claude/Projects/Dopey/netlify/functions/run-apify-monitoring.js`

This is the server-side code that calls Apify and stores clips in Supabase.

### 2. Supabase Integration Script
**File:** `sps-media-monitor-supabase-integration.js`

Copy from: `/Documents/Claude/Projects/Dopey/sps-media-monitor-supabase-integration.js`

This is the client-side script that reads from Supabase and triggers the Netlify function.

### 3. Update Dashboard HTML
**File:** `sps-media-monitor.html`

Find these lines and DELETE them:
```html
<script src="apify-data-transformer.js"></script>
<script src="apify-tier3-keyword-search.js"></script>
<script src="sps-media-monitor-apify-integration.js"></script>
```

Then ADD these lines before the closing `</body>` tag:
```html
<script src="sps-media-monitor-supabase-integration.js"></script>

<button id="fetch-live-data-btn" style="position: fixed; top: 10px; right: 60px; z-index: 9999; padding: 8px 16px; background: #0070f3; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
  📡 Fetch Live Data
</button>

<script>
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

### 4. netlify.toml
**File:** `netlify.toml`

Create with this content:
```toml
[build]
  command = "echo 'No build step needed'"
  functions = "netlify/functions"
  publish = "."

[dev]
  command = "echo 'Serving static files'"
  port = 8888
```

### 5. .gitignore
**File:** `.gitignore`

Create with this content:
```
node_modules/
.env
.env.local
.DS_Store
dist/
build/
*.log
```

## Steps to Upload

1. **Clone or open your GitHub repo locally**
   ```bash
   cd /path/to/your/repo
   ```

2. **Copy the Netlify function**
   ```bash
   mkdir -p netlify/functions
   cp /Documents/Claude/Projects/Dopey/netlify/functions/run-apify-monitoring.js netlify/functions/
   ```

3. **Copy the Supabase integration script**
   ```bash
   cp /Documents/Claude/Projects/Dopey/sps-media-monitor-supabase-integration.js .
   ```

4. **Update sps-media-monitor.html** (manually edit)
   - Remove old Apify script tags
   - Add new script tag + button code above

5. **Create netlify.toml** (if not exists)
   - Copy content from section 4 above

6. **Create .gitignore** (if not exists)
   - Copy content from section 5 above

7. **Commit and push**
   ```bash
   git add -A
   git commit -m "Add Netlify + Supabase integration for Apify monitoring"
   git push origin main
   ```

## Verify on GitHub

After pushing, your repo should have:
- ✓ `netlify/functions/run-apify-monitoring.js`
- ✓ `sps-media-monitor-supabase-integration.js`
- ✓ Updated `sps-media-monitor.html`
- ✓ `netlify.toml`
- ✓ `.gitignore`

## Next Steps

1. Connect repo to Netlify (https://app.netlify.com → Import project)
2. Add environment variables in Netlify Dashboard
3. Deploy and test

See `NETLIFY-DEPLOYMENT.md` for complete setup.

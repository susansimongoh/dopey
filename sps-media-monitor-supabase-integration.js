/**
 * SPS Media Monitor - Supabase + Netlify Integration
 *
 * Replaces direct Apify calls with:
 * 1. Netlify function (handles Apify API calls server-side)
 * 2. Supabase (stores and retrieves clips)
 *
 * No CORS issues, fully serverless.
 */

const SUPABASE_CONFIG = {
  url: localStorage.getItem("SUPABASE_URL") || prompt("Enter Supabase Project URL (https://xxx.supabase.co):"),
  anonKey: localStorage.getItem("SUPABASE_ANON_KEY") || prompt("Enter Supabase anon public key:"),
  table: "monitoring_clips"
};

const NETLIFY_CONFIG = {
  functionUrl: window.location.origin + "/.netlify/functions/run-apify-monitoring"
};

// Store credentials for next session
if (SUPABASE_CONFIG.url) localStorage.setItem("SUPABASE_URL", SUPABASE_CONFIG.url);
if (SUPABASE_CONFIG.anonKey) localStorage.setItem("SUPABASE_ANON_KEY", SUPABASE_CONFIG.anonKey);

/**
 * Fetch clips from Supabase
 * @param {Object} options - { limit, offset, orderBy, platform, category }
 * @returns {Promise<Array>} Array of clips
 */
async function fetchClipsFromSupabase(options = {}) {
  const { limit = 100, offset = 0, orderBy = "created_at.desc", platform = null, category = null } = options;

  if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
    console.error("[Supabase] Missing credentials");
    return [];
  }

  let url = new URL(`${SUPABASE_CONFIG.url}/rest/v1/${SUPABASE_CONFIG.table}`);
  url.searchParams.append("order", orderBy);
  url.searchParams.append("limit", limit);
  url.searchParams.append("offset", offset);

  if (platform) url.searchParams.append("platform", `eq.${platform}`);
  if (category) url.searchParams.append("category", `eq.${category}`);

  try {
    const response = await fetch(url, {
      headers: {
        "apikey": SUPABASE_CONFIG.anonKey,
        "Authorization": `Bearer ${SUPABASE_CONFIG.anonKey}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Supabase error: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[Supabase] Fetched ${data.length} clips`);
    return data;
  } catch (error) {
    console.error("[Supabase] Failed to fetch clips:", error);
    return [];
  }
}

/**
 * Transform Supabase row to dashboard clip format
 */
function transformSupabaseClip(row) {
  return {
    date: row.date,
    pub: row.publisher,
    plat: row.platform,
    subject: row.subject,
    link: row.link,
    cat: row.category,
    tier: row.tier,
    eng: row.engagement || {},
    trInt: row.raw_data?.trInt || "low",
    trCom: row.raw_data?.trCom || "low"
  };
}

/**
 * Trigger Netlify function to run Apify monitoring
 * @returns {Promise<Object>} Response from function
 */
async function triggerMonitoring() {
  console.log("[Netlify] Triggering monitoring run...");

  const bannerEl = document.getElementById("auto-banner-text");
  if (bannerEl) bannerEl.textContent = "Fetching live data from Apify...";

  try {
    const response = await fetch(NETLIFY_CONFIG.functionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Function error: ${response.status}`);
    }

    const result = await response.json();
    console.log("[Netlify] Monitoring complete:", result);

    if (bannerEl) {
      bannerEl.textContent = `Live Apify scrape: ${result.clipsCount} clips collected at ${new Date(result.timestamp).toLocaleTimeString()}`;
    }

    return result;
  } catch (error) {
    console.error("[Netlify] Monitoring failed:", error);
    if (bannerEl) bannerEl.textContent = `Error: ${error.message}`;
    throw error;
  }
}

/**
 * Full workflow: trigger monitoring, then load clips from Supabase
 */
async function runFullMonitoring() {
  try {
    // Trigger Netlify function (returns immediately)
    await triggerMonitoring();

    // Wait a moment for clips to be stored in Supabase
    console.log("[Monitor] Waiting for clips to be stored...");
    await new Promise(r => setTimeout(r, 2000));

    // Fetch fresh clips from Supabase
    const rows = await fetchClipsFromSupabase({ limit: 100, orderBy: "created_at.desc" });

    if (rows.length === 0) {
      console.warn("[Monitor] No clips returned from Supabase");
      return [];
    }

    // Transform to dashboard format
    const clips = rows.map((row, idx) => {
      const clip = transformSupabaseClip(row);
      clip.id = cid + idx; // Assign IDs
      return clip;
    });

    console.log(`[Monitor] Loaded ${clips.length} clips from Supabase`);
    return clips;
  } catch (error) {
    console.error("[Monitor] Full monitoring failed:", error);
    return [];
  }
}

/**
 * Load clips from Supabase on dashboard startup
 */
async function loadExistingClips() {
  console.log("[Startup] Loading existing clips from Supabase...");

  try {
    const rows = await fetchClipsFromSupabase({ limit: 50 });

    if (rows.length === 0) {
      console.log("[Startup] No clips found in Supabase, showing example data");
      return [];
    }

    // Transform and assign IDs
    const clips = rows.map((row, idx) => {
      const clip = transformSupabaseClip(row);
      clip.id = cid + idx;
      return clip;
    });

    console.log(`[Startup] Loaded ${clips.length} existing clips`);
    return clips;
  } catch (error) {
    console.error("[Startup] Failed to load clips:", error);
    return [];
  }
}

/**
 * Initialize on page load
 */
async function initSupabaseIntegration() {
  console.log("[Init] Supabase integration starting...");

  // Wait for dashboard to be ready
  const maxWait = 5000;
  const startTime = Date.now();
  while (!window.S || !window.renderDash) {
    if (Date.now() - startTime > maxWait) {
      console.error("[Init] Dashboard not ready after 5s");
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log("[Init] Dashboard ready, loading clips...");

  // Load existing clips from Supabase
  const clips = await loadExistingClips();

  if (clips.length > 0) {
    S.clips = clips;
    renderDash();
    renderClips();
    badges();
    console.log(`[Init] Dashboard updated with ${clips.length} clips`);
  }

  // Expose trigger function to window for manual button
  window.SuperbaseIntegration = {
    fetchClipsFromSupabase,
    triggerMonitoring,
    runFullMonitoring,
    loadExistingClips,
    SUPABASE_CONFIG,
    NETLIFY_CONFIG
  };

  console.log("[Init] Supabase integration ready. Call window.SuperbaseIntegration.runFullMonitoring() to fetch live data.");
}

// Start on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSupabaseIntegration);
} else {
  initSupabaseIntegration();
}

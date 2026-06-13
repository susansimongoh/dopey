/**
 * SPS Media Monitor - Apify Integration Module
 *
 * Extends sps-media-monitor.html with real-time Apify data sources
 * Replaces the hardcoded AUTO_CLIPS data with live-scraped content
 *
 * Include this module in the dashboard HTML before the closing </body> tag:
 * <script src="apify-data-transformer.js"></script>
 * <script src="sps-media-monitor-apify-integration.js"></script>
 */

// Configuration
const APIFY_CONFIG = {
  token: window.APIFY_TOKEN || localStorage.getItem("APIFY_TOKEN"), // Set via environment or localStorage
  baseUrl: "https://api.apify.com/v2",
  cacheExpiry: 3600000, // 1 hour in milliseconds
  maxRetries: 3,
  retryDelay: 2000
};

const ACTOR_IDS = {
  "facebook-comments-reactions": "apify/facebook-comments-reactions",
  "instagram-scraper": "bnkysz/instagram-scraper",
  "tiktok-video-scraper": "clockworks/tiktok-video-scraper",
  "youtube-scraper": "apify/youtube-scraper",
  "twitter-scraper": "apify/twitter-scraper"
};

/**
 * Fetch pre-built Tier 1 configuration
 */
async function loadTier1Config() {
  try {
    const response = await fetch("apify-tier1-config.json");
    if (!response.ok) throw new Error(`Failed to load Tier 1 config: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("[Apify] Failed to load Tier 1 config:", error);
    return null;
  }
}

/**
 * Submit a task to an Apify actor
 * @param {string} actorId - Actor ID (e.g., "apify/facebook-comments-reactions")
 * @param {Object} input - Actor input parameters
 * @returns {Promise<Object>} Run result with run_id and dataset_id
 */
async function submitApifyActor(actorId, input) {
  if (!APIFY_CONFIG.token) {
    throw new Error("APIFY_TOKEN not set. Set window.APIFY_TOKEN or localStorage.APIFY_TOKEN");
  }

  const url = `${APIFY_CONFIG.baseUrl}/acts/${actorId}/runs`;

  let lastError;
  for (let attempt = 0; attempt < APIFY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${APIFY_CONFIG.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ input })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Apify API error: ${response.status} - ${error.message}`);
      }

      const result = await response.json();
      return {
        run_id: result.data.id,
        dataset_id: result.data.defaultDatasetId,
        actor_id: actorId,
        submitted_at: new Date().toISOString()
      };
    } catch (error) {
      lastError = error;
      if (attempt < APIFY_CONFIG.maxRetries - 1) {
        console.log(`[Apify] Retry ${attempt + 1}/${APIFY_CONFIG.maxRetries} after ${APIFY_CONFIG.retryDelay}ms`);
        await new Promise(r => setTimeout(r, APIFY_CONFIG.retryDelay));
      }
    }
  }

  throw lastError;
}

/**
 * Poll for run completion and get results
 * @param {string} runId - Apify run ID
 * @param {number} maxWaitMs - Maximum time to wait (default 5 minutes)
 * @returns {Promise<Object>} Run data including dataset_id
 */
async function waitForRunCompletion(runId, maxWaitMs = 300000) {
  if (!APIFY_CONFIG.token) {
    throw new Error("APIFY_TOKEN not set");
  }

  const startTime = Date.now();
  const pollInterval = 5000; // Poll every 5 seconds

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(
        `${APIFY_CONFIG.baseUrl}/runs/${runId}`,
        { headers: { "Authorization": `Bearer ${APIFY_CONFIG.token}` } }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();
      const run = result.data;

      if (run.status === "SUCCEEDED") {
        return {
          status: "completed",
          dataset_id: run.defaultDatasetId,
          items_count: run.stats?.crawledItemsCount || 0
        };
      }

      if (run.status === "FAILED" || run.status === "ABORTED") {
        throw new Error(`Run ${runId} ${run.status}`);
      }

      // Still running, wait and retry
      await new Promise(r => setTimeout(r, pollInterval));
    } catch (error) {
      console.error(`[Apify] Error polling run ${runId}:`, error);
      throw error;
    }
  }

  throw new Error(`Run ${runId} did not complete within ${maxWaitMs}ms`);
}

/**
 * Fetch dataset items from Apify
 * @param {string} datasetId - Dataset ID
 * @param {Object} options - { limit, offset, format }
 * @returns {Promise<Array>} Array of items
 */
async function fetchDatasetItems(datasetId, options = {}) {
  const { limit = 1000, offset = 0, format = "json" } = options;

  if (!APIFY_CONFIG.token) {
    throw new Error("APIFY_TOKEN not set");
  }

  const url = new URL(`${APIFY_CONFIG.baseUrl}/datasets/${datasetId}/items`);
  url.searchParams.append("format", format);
  url.searchParams.append("limit", limit);
  url.searchParams.append("offset", offset);

  try {
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${APIFY_CONFIG.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`[Apify] Failed to fetch dataset ${datasetId}:`, error);
    throw error;
  }
}

/**
 * Build input config for monitoring a Facebook page
 */
function buildFacebookInput(pageId, keywords = []) {
  return {
    startUrls: [{ url: `https://www.facebook.com/${pageId}` }],
    deepPageOffset: 0,
    stopScrollTimeout: 5000,
    maxPostsPerPage: 50
  };
}

/**
 * Build input config for monitoring an Instagram account
 */
function buildInstagramInput(username) {
  return {
    searchType: "user",
    searchLimit: 1,
    resultsType: "posts",
    resultsLimit: 50
  };
}

/**
 * Build input config for TikTok keyword search
 */
function buildTikTokInput(keywords = []) {
  return {
    keywords: keywords,
    numberOfPostsPerKeyword: 50,
    searchType: "hashtag_and_search"
  };
}

/**
 * Run Tier 1 monitoring (news outlets + government + activists)
 * Runs several Apify actors in parallel, returns clips
 * @returns {Promise<Array>} Array of clips
 */
async function runTier1Monitoring() {
  console.log("[Apify] Starting Tier 1 monitoring...");

  const config = await loadTier1Config();
  if (!config) {
    console.error("[Apify] Could not load Tier 1 config");
    return [];
  }

  const allClips = [];
  const runPromises = [];

  // Submit Tier 1 actors (simplified example for major outlets + government)
  const tier1Actors = [
    {
      platform: "facebook",
      handle: "straitstimes",
      actor: "facebook-comments-reactions"
    },
    {
      platform: "facebook",
      handle: "channelnewsasia",
      actor: "facebook-comments-reactions"
    },
    {
      platform: "facebook",
      handle: "mhasingapore",
      actor: "facebook-comments-reactions"
    }
  ];

  for (const actor of tier1Actors) {
    try {
      const input = buildFacebookInput(actor.handle);
      const run = await submitApifyActor(ACTOR_IDS[actor.actor], input);

      runPromises.push({
        platform: actor.platform,
        handle: actor.handle,
        runId: run.run_id,
        datasetId: run.dataset_id
      });

      console.log(`[Apify] Submitted ${actor.handle} (${run.run_id})`);
    } catch (error) {
      console.error(`[Apify] Failed to submit ${actor.handle}:`, error);
    }
  }

  // Wait for all runs to complete and fetch results
  for (const runInfo of runPromises) {
    try {
      const completion = await waitForRunCompletion(runInfo.runId);
      const items = await fetchDatasetItems(runInfo.datasetId);

      // Transform items
      const clips = window.transformBatch(items, runInfo.platform, {
        category: "daily_news",
        tier: 1
      });

      allClips.push(...clips);
      console.log(`[Apify] Processed ${runInfo.handle}: ${clips.length} clips`);
    } catch (error) {
      console.error(`[Apify] Failed to process ${runInfo.handle}:`, error);
    }
  }

  return allClips;
}

/**
 * Run Tier 2 monitoring (CARE Network partners)
 * @returns {Promise<Array>} Array of clips
 */
async function runTier2Monitoring() {
  console.log("[Apify] Starting Tier 2 monitoring...");

  const tier2Sources = [
    { platform: "instagram", handle: "yellowribbonsg", category: "yellow_ribbon" },
    { platform: "instagram", handle: "sasingapore", category: "sana" },
    { platform: "facebook", handle: "prisfellowship", category: "prison_fellowship" }
  ];

  const allClips = [];

  for (const source of tier2Sources) {
    try {
      let input, actorId;

      if (source.platform === "instagram") {
        input = buildInstagramInput(source.handle);
        actorId = ACTOR_IDS["instagram-scraper"];
      } else if (source.platform === "facebook") {
        input = buildFacebookInput(source.handle);
        actorId = ACTOR_IDS["facebook-comments-reactions"];
      }

      const run = await submitApifyActor(actorId, input);
      const completion = await waitForRunCompletion(run.run_id);
      const items = await fetchDatasetItems(run.dataset_id);

      const clips = window.transformBatch(items, source.platform, {
        category: "care_network",
        tier: 2
      });

      allClips.push(...clips);
      console.log(`[Apify] Processed ${source.handle}: ${clips.length} clips`);
    } catch (error) {
      console.error(`[Apify] Failed to process Tier 2 ${source.handle}:`, error);
    }
  }

  return allClips;
}

/**
 * Run Tier 3 monitoring (keyword searches)
 * Uses the tier3-keyword-search module
 * @returns {Promise<Array>} Array of clips
 */
async function runTier3Monitoring() {
  if (!window.runAllKeywordSearches) {
    console.error("[Apify] Tier 3 module not loaded. Include apify-tier3-keyword-search.js");
    return [];
  }

  console.log("[Apify] Starting Tier 3 keyword searches...");

  try {
    const results = await window.runAllKeywordSearches(APIFY_CONFIG.token);

    const allClips = [];
    for (const [platform, result] of Object.entries(results)) {
      if (result.status === "completed") {
        try {
          const items = await fetchDatasetItems(result.dataset_id);
          const clips = window.transformBatch(items, platform, {
            category: "daily_news",
            tier: 3
          });
          allClips.push(...clips);
        } catch (error) {
          console.error(`[Apify] Failed to fetch Tier 3 results for ${platform}:`, error);
        }
      }
    }

    return allClips;
  } catch (error) {
    console.error("[Apify] Tier 3 monitoring failed:", error);
    return [];
  }
}

/**
 * Run all three tiers and merge results
 * Deduplicates and returns all clips for the dashboard
 * @param {Object} options - { tier1: true, tier2: true, tier3: false, ... }
 * @returns {Promise<Array>} All clips ready for dashboard
 */
async function runFullMonitoring(options = { tier1: true, tier2: true, tier3: false }) {
  console.log("[Apify] Starting full monitoring run...");

  const banner = document.getElementById("auto-banner-text");
  if (banner) banner.textContent = "Fetching media monitoring data from Apify...";

  const allClips = [];

  if (options.tier1) {
    const tier1Clips = await runTier1Monitoring();
    allClips.push(...tier1Clips);
  }

  if (options.tier2) {
    const tier2Clips = await runTier2Monitoring();
    allClips.push(...tier2Clips);
  }

  if (options.tier3) {
    const tier3Clips = await runTier3Monitoring();
    allClips.push(...tier3Clips);
  }

  // Deduplicate and merge
  const finalClips = window.deduplicateAndMerge(allClips);

  console.log(`[Apify] Monitoring complete: ${finalClips.length} unique clips`);

  if (banner) {
    banner.textContent = `Live Apify scrape: ${finalClips.length} clips collected from Tier 1, 2${options.tier3 ? ", 3" : ""} sources`;
  }

  return finalClips;
}

/**
 * Run Apify monitoring immediately and reload dashboard with live clips
 */
async function runApifyMonitoring() {
  if (!APIFY_CONFIG.token) {
    console.warn("[Apify] APIFY_TOKEN not set. Keeping example data.");
    return;
  }

  try {
    console.log("[Apify] Starting live monitoring...");
    const clips = await runFullMonitoring({ tier1: true, tier2: true, tier3: false });

    if (clips.length === 0) {
      console.warn("[Apify] No clips returned from monitoring");
      return;
    }

    // Replace dashboard clips with live data
    S.clips = [];
    clips.forEach((c) => {
      c.id = cid++;
      S.clips.push(c);
    });

    // Refresh the display
    renderDash();
    renderClips();
    badges();

    console.log(`[Apify] Successfully loaded ${clips.length} live clips`);
  } catch (error) {
    console.error("[Apify] Monitoring failed:", error.message);
  }
}

/**
 * Schedule daily monitoring runs
 * Integrate with your scheduler (cron, Lambda, etc.)
 */
const MONITORING_SCHEDULE = {
  frequency: "daily",
  runs: [
    { time: "09:00 SGT", tiers: [1, 2], label: "Morning briefing" },
    { time: "17:00 SGT", tiers: [1, 2, 3], label: "Evening round-up" }
  ]
};

// Export functions for external use
window.ApifyIntegration = {
  submitApifyActor,
  waitForRunCompletion,
  fetchDatasetItems,
  runTier1Monitoring,
  runTier2Monitoring,
  runTier3Monitoring,
  runFullMonitoring,
  runApifyMonitoring,
  APIFY_CONFIG,
  MONITORING_SCHEDULE
};

// Run monitoring after a short delay to ensure dashboard is initialized
setTimeout(() => {
  if (window.S && window.renderDash) {
    runApifyMonitoring();
  }
}, 1000);

/**
 * Netlify Function: run-apify-monitoring
 *
 * Orchestrates Apify monitoring and stores results in Supabase.
 * Triggered by: dashboard button OR scheduled cron
 *
 * Deploy to: ./netlify/functions/run-apify-monitoring.js
 * Endpoint: /.netlify/functions/run-apify-monitoring
 */

const APIFY_CONFIG = {
  token: process.env.APIFY_TOKEN,
  baseUrl: "https://api.apify.com/v2",
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
 * Submit a task to an Apify actor (server-to-server, no CORS)
 */
async function submitApifyActor(actorId, input) {
  if (!APIFY_CONFIG.token) {
    throw new Error("APIFY_TOKEN not set in environment");
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
        console.log(`[Apify] Retry ${attempt + 1}/${APIFY_CONFIG.maxRetries}`);
        await new Promise(r => setTimeout(r, APIFY_CONFIG.retryDelay));
      }
    }
  }

  throw lastError;
}

/**
 * Poll for run completion
 */
async function waitForRunCompletion(runId, maxWaitMs = 300000) {
  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(
        `${APIFY_CONFIG.baseUrl}/runs/${runId}`,
        { headers: { "Authorization": `Bearer ${APIFY_CONFIG.token}` } }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
 */
async function fetchDatasetItems(datasetId, options = {}) {
  const { limit = 1000, offset = 0, format = "json" } = options;

  if (!APIFY_CONFIG.token) throw new Error("APIFY_TOKEN not set");

  const url = new URL(`${APIFY_CONFIG.baseUrl}/datasets/${datasetId}/items`);
  url.searchParams.append("format", format);
  url.searchParams.append("limit", limit);
  url.searchParams.append("offset", offset);

  try {
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${APIFY_CONFIG.token}` }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[Apify] Failed to fetch dataset ${datasetId}:`, error);
    throw error;
  }
}

/**
 * Run Tier 1 monitoring (simplified version for demo)
 */
async function runTier1Monitoring() {
  console.log("[Apify] Starting Tier 1 monitoring...");

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
    }
  ];

  const allClips = [];

  for (const actor of tier1Actors) {
    try {
      const input = {
        startUrls: [{ url: `https://www.facebook.com/${actor.handle}` }],
        deepPageOffset: 0,
        stopScrollTimeout: 5000,
        maxPostsPerPage: 50
      };

      const run = await submitApifyActor(ACTOR_IDS[actor.actor], input);
      const completion = await waitForRunCompletion(run.run_id);
      const items = await fetchDatasetItems(run.dataset_id);

      // Transform items to clip format
      const clips = items.map(item => ({
        date: new Date(item.createdTime || Date.now()).toISOString().split('T')[0],
        pub: item.pageTitle || item.authorName || "Unknown",
        plat: "Facebook",
        subject: (item.message || item.description || "").substring(0, 500),
        link: item.url || item.permalinkUrl || null,
        cat: "daily_news",
        tier: 1,
        eng: {
          plays: 0,
          likes: item.likes || 0,
          comments: (item.commentsCount || 0) + (item.comments?.length || 0),
          shares: item.shares || 0
        }
      }));

      allClips.push(...clips);
      console.log(`[Apify] Processed ${actor.handle}: ${clips.length} clips`);
    } catch (error) {
      console.error(`[Apify] Failed to process ${actor.handle}:`, error.message);
    }
  }

  return allClips;
}

/**
 * Store clips in Supabase
 */
async function storeClipsInSupabase(clips) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY not set");
  }

  // Prepare clips for insertion
  const clipsForDb = clips.map(clip => ({
    date: clip.date,
    publisher: clip.pub,
    platform: clip.plat,
    subject: clip.subject,
    link: clip.link,
    category: clip.cat,
    tier: clip.tier,
    engagement: clip.eng,
    raw_data: clip,
    created_at: new Date().toISOString()
  }));

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/monitoring_clips`, {
      method: "POST",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(clipsForDb)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase error: ${response.status} - ${error}`);
    }

    console.log(`[Supabase] Stored ${clipsForDb.length} clips`);
    return clipsForDb.length;
  } catch (error) {
    console.error(`[Supabase] Failed to store clips:`, error);
    throw error;
  }
}

/**
 * Main handler
 */
exports.handler = async (event, context) => {
  console.log("[Function] Starting Apify monitoring run...");

  // Allow CORS for dashboard calls
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "OK"
    };
  }

  try {
    // Run monitoring
    const clips = await runTier1Monitoring();

    if (clips.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: "Monitoring completed with no clips",
          clipsCount: 0
        })
      };
    }

    // Store in Supabase
    const stored = await storeClipsInSupabase(clips);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Monitoring complete: ${stored} clips stored`,
        clipsCount: stored,
        timestamp: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error("[Function] Error:", error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

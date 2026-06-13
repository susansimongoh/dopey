/**
 * SPS Media Monitor - Tier 3: Keyword Search Automation
 *
 * Manual keyword searches across Facebook, TikTok, X/Twitter for public posts
 * matching SPS-related keywords. Uses platform search APIs and native search.
 *
 * Platform-specific notes:
 * - Facebook: Use Graph API with public_content permission
 * - TikTok: Use Research API (limited) or web scraping
 * - X/Twitter: Use API v2 (academic or paid tier)
 */

const TIER3_KEYWORDS = {
  primary: [
    "Changi Prison",
    "Singapore Prison",
    "Singapore Prison Service",
    "SPS"
  ],
  secondary: [
    "Inside Maximum security",
    "Death row Singapore",
    "Death penalty Singapore",
    "Yellow Ribbon Singapore"
  ],
  exclusions: [
    // Exclude daily crime reporting (focus on sensationalized news that impacts SPS)
    "theft Singapore",
    "robbery Singapore",
    "assault Singapore",
    "traffic accident"
  ]
};

const TIER3_PLATFORMS = {
  facebook: {
    name: "Facebook",
    actor: "facebook-graph-search",
    method: "Graph API search endpoint",
    required_permissions: ["public_content"],
    rate_limit: "10 requests/minute",
    collect: ["post_id", "message", "created_time", "likes.summary(total_count).limit(0)", "comments.summary(total_count).limit(10)", "shares"]
  },
  tiktok: {
    name: "TikTok",
    actor: "tiktok-research-api",
    method: "Research API (academic/enterprise tier) or web scraping",
    required_permissions: ["research_api_access"],
    rate_limit: "Platform varies",
    collect: ["video_id", "description", "view_count", "like_count", "comment_count", "share_count", "created_at"]
  },
  twitter: {
    name: "X/Twitter",
    actor: "twitter-v2-api",
    method: "API v2 (academic or paid tier)",
    required_permissions: ["twitter_api_v2_access"],
    rate_limit: "300 requests/15min (academic)",
    collect: ["id", "text", "created_at", "public_metrics"]
  }
};

/**
 * Apify Actor definitions for Tier 3 keyword searches
 */
const TIER3_ACTORS = {
  facebook: {
    actor_id: "apify/facebook-comments-reactions",
    documentation: "https://apify.com/apify/facebook-comments-reactions",
    input_schema: {
      startUrls: [
        {
          value: "https://www.facebook.com/search/posts/?q=Changi%20Prison&filters=eyJycf_bu\":[\"{\\\"name\\\":\\\"source\\\",\\\"args\\\":\\\"PUBLIC\\\"}\"]",
          userData: { keyword: "Changi Prison" }
        },
        {
          value: "https://www.facebook.com/search/posts/?q=Singapore%20Prison%20Service&filters=eyJycf_bu\":[\"{\\\"name\\\":\\\"source\\\",\\\"args\\\":\\\"PUBLIC\\\"}\"]",
          userData: { keyword: "Singapore Prison Service" }
        }
      ],
      onlyNewest: true,
      stopScrollTimeout: 5000,
      maxPostsPerPage: 50
    }
  },

  tiktok: {
    actor_id: "clockworks/tiktok-video-scraper",
    documentation: "https://apify.com/clockworks/tiktok-video-scraper",
    input_schema: {
      keywords: [
        "Changi Prison",
        "Singapore Prison",
        "death penalty Singapore",
        "Yellow Ribbon Singapore"
      ],
      numberOfPostsPerKeyword: 50,
      searchType: "hashtag_and_search",
      maxRetries: 3
    }
  },

  twitter: {
    actor_id: "apify/twitter-scraper",
    documentation: "https://apify.com/apify/twitter-scraper",
    input_schema: {
      queries: [
        "Changi Prison",
        "Singapore Prison Service",
        "death penalty Singapore",
        "Yellow Ribbon Singapore"
      ],
      sort: "Latest",
      maxTweets: 50,
      onlyTweets: true
    }
  }
};

/**
 * Build Apify task payload for keyword search
 * @param {string} platform - 'facebook', 'tiktok', or 'twitter'
 * @param {Date} runDate - When the search is running (used for metadata)
 * @returns {Object} Ready-to-submit Apify actor input
 */
function buildKeywordSearchPayload(platform, runDate = new Date()) {
  if (!TIER3_ACTORS[platform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const actor = TIER3_ACTORS[platform];
  const payload = JSON.parse(JSON.stringify(actor.input_schema)); // deep copy

  // Add metadata
  payload.metadata = {
    source: "sps-media-monitor-tier3",
    runDate: runDate.toISOString(),
    searchType: "keyword",
    purpose: "Monitor for SPS-related public posts across platforms"
  };

  // Add exclusion filters
  payload.excludeKeywords = TIER3_KEYWORDS.exclusions;

  return payload;
}

/**
 * Format the Apify API call for submitting a keyword search
 * @param {string} platform - 'facebook', 'tiktok', or 'twitter'
 * @param {string} apifyToken - Apify API token
 * @returns {Object} fetch() compatible request object
 */
function buildApifyRequest(platform, apifyToken) {
  const actor = TIER3_ACTORS[platform];
  const payload = buildKeywordSearchPayload(platform);

  return {
    method: "POST",
    url: `https://api.apify.com/v2/acts/${actor.actor_id}/runs`,
    headers: {
      "Authorization": `Bearer ${apifyToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: payload
    })
  };
}

/**
 * Run all Tier 3 keyword searches (serial, with rate limit delays)
 * @param {string} apifyToken - Apify API token
 * @param {Object} options - { delayBetweenRuns: 2000 }
 */
async function runAllKeywordSearches(apifyToken, options = {}) {
  const { delayBetweenRuns = 2000 } = options;

  const results = {};

  for (const platform of Object.keys(TIER3_ACTORS)) {
    console.log(`[Tier 3] Starting keyword search for ${platform}...`);

    try {
      const request = buildApifyRequest(platform, apifyToken);

      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });

      if (!response.ok) {
        throw new Error(`Apify API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      results[platform] = {
        status: "submitted",
        run_id: data.data.id,
        dataset_id: data.data.defaultDatasetId,
        actor_id: TIER3_ACTORS[platform].actor_id,
        submitted_at: new Date().toISOString()
      };

      console.log(`[Tier 3] ${platform}: Run ${data.data.id} submitted`);
    } catch (error) {
      results[platform] = {
        status: "failed",
        error: error.message
      };
      console.error(`[Tier 3] ${platform} failed:`, error);
    }

    // Rate limit between platform runs
    if (platform !== Object.keys(TIER3_ACTORS)[Object.keys(TIER3_ACTORS).length - 1]) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenRuns));
    }
  }

  return results;
}

/**
 * Fetch results from a completed Tier 3 keyword search
 * @param {string} datasetId - Apify dataset ID from the run result
 * @param {string} apifyToken - Apify API token
 * @returns {Promise<Array>} Array of posts matching the search
 */
async function fetchKeywordSearchResults(datasetId, apifyToken) {
  try {
    const response = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items`,
      {
        headers: { "Authorization": `Bearer ${apifyToken}` }
      }
    );

    if (!response.ok) {
      throw new Error(`Apify API error: ${response.status}`);
    }

    const items = await response.json();
    return items;
  } catch (error) {
    console.error("Failed to fetch keyword search results:", error);
    return [];
  }
}

/**
 * Transform keyword search results into SPS Media Monitor clip format
 * @param {Array} searchResults - Raw results from Apify actor
 * @param {string} platform - Which platform these came from
 * @returns {Array} Clips in sps-media-monitor format
 */
function transformKeywordResults(searchResults, platform) {
  return searchResults
    .filter(item => {
      // Filter out unwanted content
      const text = (item.message || item.description || item.text || "").toLowerCase();
      return !TIER3_KEYWORDS.exclusions.some(excl => text.includes(excl.toLowerCase()));
    })
    .map(item => {
      const clip = {
        date: new Date(
          item.created_time || item.created_at || Date.now()
        ).toISOString().split('T')[0],
        pub: getPlatformPublisherName(item, platform),
        plat: platform.charAt(0).toUpperCase() + platform.slice(1),
        subject: (item.message || item.description || item.text || "").substring(0, 500),
        link: getItemLink(item, platform),
        cat: "daily_news", // Keyword search posts are daily news by default
        eng: extractEngagementMetrics(item, platform)
      };
      return clip;
    });
}

/**
 * Extract publisher name from item metadata
 */
function getPlatformPublisherName(item, platform) {
  if (item.publisher_name) return item.publisher_name;
  if (item.author_name) return item.author_name;
  if (item.account_name) return item.account_name;
  return platform === "twitter" ? item.author?.username || "Unknown" : "Unknown";
}

/**
 * Get the direct link to the item on its platform
 */
function getItemLink(item, platform) {
  if (platform === "facebook" && item.post_id) {
    return `https://facebook.com/${item.post_id}`;
  }
  if (platform === "tiktok" && item.video_id) {
    return `https://www.tiktok.com/video/${item.video_id}`;
  }
  if (platform === "twitter" && item.id) {
    return `https://twitter.com/i/web/status/${item.id}`;
  }
  return item.link || item.url || null;
}

/**
 * Extract engagement metrics for traction calculation
 */
function extractEngagementMetrics(item, platform) {
  if (platform === "tiktok") {
    return {
      plays: item.view_count || 0,
      likes: item.like_count || 0,
      comments: item.comment_count || 0,
      shares: item.share_count || 0
    };
  }

  // Facebook, Twitter, etc.
  if (item.public_metrics) {
    return {
      likes: item.public_metrics.like_count || 0,
      comments: item.public_metrics.reply_count || item.public_metrics.comment_count || 0,
      shares: item.public_metrics.retweet_count || item.public_metrics.share_count || 0
    };
  }

  return {
    likes: item.likes || 0,
    comments: item.comments || 0,
    shares: item.shares || 0
  };
}

/**
 * Schedule Tier 3 keyword searches to run daily
 * Integrate with your scheduler (e.g., node-cron, AWS Lambda, etc.)
 */
const TIER3_SCHEDULE = {
  frequency: "daily",
  run_times: [
    "09:00 SGT", // Morning briefing
    "17:00 SGT"  // Evening round-up
  ],
  notes: "Run twice daily to catch both morning and evening posts from activists/media"
};

// Export for browser use
window.TIER3_KEYWORDS = TIER3_KEYWORDS;
window.TIER3_PLATFORMS = TIER3_PLATFORMS;
window.TIER3_ACTORS = TIER3_ACTORS;
window.buildKeywordSearchPayload = buildKeywordSearchPayload;
window.buildApifyRequest = buildApifyRequest;
window.runAllKeywordSearches = runAllKeywordSearches;
window.fetchKeywordSearchResults = fetchKeywordSearchResults;
window.transformKeywordResults = transformKeywordResults;
window.TIER3_SCHEDULE = TIER3_SCHEDULE;

// Example usage:
/*
(async () => {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  // Run all keyword searches
  const results = await runAllKeywordSearches(APIFY_TOKEN);
  console.log("Tier 3 Search Results:", results);

  // Later: fetch and transform results
  for (const [platform, result] of Object.entries(results)) {
    if (result.status === "completed") {
      const rawItems = await fetchKeywordSearchResults(result.dataset_id, APIFY_TOKEN);
      const clips = transformKeywordResults(rawItems, platform);
      console.log(`${platform} clips:`, clips);
    }
  }
})();
*/

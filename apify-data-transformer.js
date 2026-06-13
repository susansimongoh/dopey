/**
 * SPS Media Monitor - Data Transformation Layer
 *
 * Converts outputs from various Apify Actors into the dashboard's clip format.
 * Handles engagement metrics, traction calculation, and data normalization.
 */

/**
 * Traction calculation rules (from MM Search Guide)
 */
const TRACTION_RULES = {
  tiktok: {
    very_high: { views: 400000, engagement: 14000 },
    high: { views: 100000, engagement: 3000 },
    moderate: { views: 40000, engagement: 850 },
    low: { views: 20000, engagement: 350 },
    very_low: { views: 0, engagement: 0 }
  },
  general: {
    very_high: 1500,  // combined interactions in 3 hrs (viral threshold)
    high: 300,
    moderate: 100,
    low: 0
  }
};

/**
 * Transform Facebook post to clip format
 * Source: apify/facebook-comments-reactions
 */
function transformFacebookPost(item) {
  if (!item) return null;

  const engagement = {
    likes: item.likes || 0,
    comments: (item.commentsCount || 0) + (item.comments?.length || 0),
    shares: item.shares || 0
  };

  const totalEngagement = engagement.likes + engagement.comments + engagement.shares;
  const trInt = calculateGeneralTraction(totalEngagement);
  const trCom = calculateGeneralTraction(engagement.comments);

  return {
    date: new Date(item.createdTime).toISOString().split('T')[0],
    pub: item.pageTitle || item.authorName || "Unknown",
    plat: "Facebook",
    subject: (item.message || item.description || "").substring(0, 500),
    link: item.url || item.permalinkUrl || null,
    cat: "daily_news",
    eng: {
      plays: 0,  // Facebook doesn't expose view counts for posts
      likes: engagement.likes,
      comments: engagement.comments,
      shares: engagement.shares
    },
    trInt,
    trCom
  };
}

/**
 * Transform Instagram post to clip format
 * Source: bnkysz/instagram-scraper
 */
function transformInstagramPost(item) {
  if (!item) return null;

  const engagement = {
    likes: item.likes || item.likeCount || 0,
    comments: item.comments || item.commentsCount || 0,
    shares: 0  // Instagram doesn't expose share counts publicly
  };

  const totalEngagement = engagement.likes + engagement.comments;
  const trInt = calculateGeneralTraction(totalEngagement);
  const trCom = calculateGeneralTraction(engagement.comments);

  return {
    date: new Date(item.timestamp || item.createdTime).toISOString().split('T')[0],
    pub: item.accountName || item.username || "Unknown",
    plat: "Instagram",
    subject: (item.caption || "").substring(0, 500),
    link: item.postUrl || item.url || null,
    cat: "social_updates",
    eng: {
      plays: 0,
      likes: engagement.likes,
      comments: engagement.comments,
      shares: 0
    },
    ogImage: item.displayUrl || item.image || null,
    trInt,
    trCom
  };
}

/**
 * Transform TikTok video to clip format
 * Source: clockworks/tiktok-video-scraper
 */
function transformTikTokVideo(item) {
  if (!item) return null;

  const views = item.viewCount || item.playCount || 0;
  const engagement = (item.likeCount || 0) + (item.commentCount || 0) + (item.shareCount || 0);

  const trInt = calculateTikTokTraction(views, engagement);
  const trCom = calculateGeneralTraction(item.commentCount || 0);

  return {
    date: new Date(item.createTime || item.createdTime).toISOString().split('T')[0],
    pub: item.authorName || item.author?.nickname || "Unknown",
    plat: "TikTok",
    subject: (item.description || item.caption || "").substring(0, 500),
    link: item.videoUrl || item.url || null,
    cat: "social_updates",
    eng: {
      plays: views,
      likes: item.likeCount || 0,
      comments: item.commentCount || 0,
      shares: item.shareCount || 0
    },
    ogImage: item.thumbnailUrl || item.coverImage || null,
    trInt,
    trCom
  };
}

/**
 * Transform YouTube video to clip format
 * Source: apify/youtube-scraper
 */
function transformYouTubeVideo(item) {
  if (!item) return null;

  const views = item.viewCount || 0;
  const engagement = (item.likeCount || 0) + (item.commentCount || 0);

  const trInt = calculateGeneralTraction(views / 1000); // Scale down view count for traction
  const trCom = calculateGeneralTraction(item.commentCount || 0);

  return {
    date: new Date(item.publishedDate || item.uploadedAt).toISOString().split('T')[0],
    pub: item.channelTitle || item.author || "Unknown",
    plat: "YouTube",
    subject: (item.title || "").substring(0, 500),
    link: `https://www.youtube.com/watch?v=${item.id || item.videoId}`,
    cat: "daily_news",
    eng: {
      plays: views,
      likes: item.likeCount || 0,
      comments: item.commentCount || 0,
      shares: 0  // YouTube doesn't expose share counts
    },
    ogImage: item.thumbnail || null,
    trInt,
    trCom
  };
}

/**
 * Transform Twitter/X post to clip format
 * Source: apify/twitter-scraper
 */
function transformTwitterPost(item) {
  if (!item) return null;

  const engagement = {
    likes: item.likeCount || item.public_metrics?.like_count || 0,
    comments: item.replyCount || item.public_metrics?.reply_count || 0,
    shares: item.retweetCount || item.public_metrics?.retweet_count || 0
  };

  const totalEngagement = engagement.likes + engagement.comments + engagement.shares;
  const trInt = calculateGeneralTraction(totalEngagement);
  const trCom = calculateGeneralTraction(engagement.comments);

  return {
    date: new Date(item.createdAt || item.created_at).toISOString().split('T')[0],
    pub: item.author?.name || item.authorName || "Unknown",
    plat: "X/Twitter",
    subject: (item.text || "").substring(0, 500),
    link: `https://twitter.com/${item.author?.username}/status/${item.id}`,
    cat: "daily_news",
    eng: {
      plays: 0,
      likes: engagement.likes,
      comments: engagement.comments,
      shares: engagement.shares
    },
    trInt,
    trCom
  };
}

/**
 * Generic transformer for unidentified post types
 */
function transformGenericPost(item, platform) {
  const engagement = {
    likes: item.likes || item.likeCount || 0,
    comments: item.comments || item.commentsCount || 0,
    shares: item.shares || item.shareCount || 0
  };

  const totalEngagement = engagement.likes + engagement.comments + engagement.shares;
  const trInt = calculateGeneralTraction(totalEngagement);
  const trCom = calculateGeneralTraction(engagement.comments);

  return {
    date: new Date(item.createdTime || item.created_at || Date.now()).toISOString().split('T')[0],
    pub: item.pub || item.author || item.authorName || "Unknown",
    plat: platform,
    subject: (item.message || item.description || item.text || "").substring(0, 500),
    link: item.link || item.url || null,
    cat: "daily_news",
    eng: engagement,
    trInt,
    trCom
  };
}

/**
 * Calculate traction for TikTok videos
 * Rules: Very High ≥400k views OR ≥14k eng | High ≥100k OR ≥3k | etc.
 */
function calculateTikTokTraction(views, engagement) {
  if (views >= 400000 || engagement >= 14000) return "very_high";
  if (views >= 100000 || engagement >= 3000) return "high";
  if (views >= 40000 || engagement >= 850) return "moderate";
  if (views >= 20000 || engagement >= 350) return "low";
  return "very_low";
}

/**
 * Calculate traction for general social media
 * Rules: Viral ≥1500 | High >300 | Moderate 100-300 | Low <100
 */
function calculateGeneralTraction(combinedEngagement) {
  if (combinedEngagement >= 1500) return "very_high";
  if (combinedEngagement > 300) return "high";
  if (combinedEngagement >= 100) return "moderate";
  return "low";
}

/**
 * Route incoming data to appropriate transformer
 * @param {Object} item - Raw item from Apify
 * @param {string} platform - 'facebook', 'instagram', 'tiktok', 'youtube', 'twitter'
 * @param {Object} metadata - Extra context (e.g., which account, keywords matched)
 * @returns {Object} Transformed clip in dashboard format
 */
function transformPost(item, platform, metadata = {}) {
  if (!item) return null;

  let clip;

  switch (platform.toLowerCase()) {
    case "facebook":
      clip = transformFacebookPost(item);
      break;
    case "instagram":
      clip = transformInstagramPost(item);
      break;
    case "tiktok":
      clip = transformTikTokVideo(item);
      break;
    case "youtube":
      clip = transformYouTubeVideo(item);
      break;
    case "twitter":
    case "x/twitter":
      clip = transformTwitterPost(item);
      break;
    default:
      clip = transformGenericPost(item, platform);
  }

  if (clip && metadata) {
    if (metadata.category) clip.cat = metadata.category;
    if (metadata.keywords) clip.keywords = metadata.keywords;
    if (metadata.tier) clip.tier = metadata.tier;
  }

  return clip;
}

/**
 * Batch transform multiple posts
 * @param {Array} items - Array of raw items from Apify
 * @param {string} platform - Source platform
 * @param {Object} metadata - Context metadata
 * @returns {Array} Array of transformed clips
 */
function transformBatch(items, platform, metadata = {}) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => transformPost(item, platform, metadata))
    .filter(clip => clip !== null);
}

/**
 * Merge transformation results from multiple Tier 1/2 runs
 * Deduplicate by link, merge engagement metrics for duplicates
 * @param {Array} allClips - Array of clips from different sources
 * @returns {Array} Deduplicated clips
 */
function deduplicateAndMerge(allClips) {
  const seen = new Map();

  for (const clip of allClips) {
    if (!clip.link) {
      seen.set(Math.random(), clip); // No link = unique
      continue;
    }

    if (seen.has(clip.link)) {
      // Merge engagement metrics
      const existing = seen.get(clip.link);
      existing.eng.likes = Math.max(existing.eng.likes, clip.eng.likes);
      existing.eng.comments = Math.max(existing.eng.comments, clip.eng.comments);
      existing.eng.shares = Math.max(existing.eng.shares, clip.eng.shares);
      existing.eng.plays = Math.max(existing.eng.plays, clip.eng.plays);

      // Recalculate traction
      if (clip.plat === "TikTok") {
        existing.trInt = calculateTikTokTraction(existing.eng.plays, existing.eng.likes + existing.eng.comments + existing.eng.shares);
      } else {
        existing.trInt = calculateGeneralTraction(existing.eng.likes + existing.eng.comments + existing.eng.shares);
      }
      existing.trCom = calculateGeneralTraction(existing.eng.comments);
    } else {
      seen.set(clip.link, clip);
    }
  }

  return Array.from(seen.values());
}

/**
 * Generate a traction note from engagement data
 * Mimics the format used in your example data
 */
function generateTractionNote(clips) {
  if (clips.length === 0) return "";

  return clips
    .filter(c => c.eng)
    .map(c => {
      const { plays = 0, likes = 0, comments = 0, shares = 0 } = c.eng;
      const who = c.pub + (c.plat ? ` (${c.plat})` : "");

      if (c.plat === "TikTok" && plays) {
        return `${who}: ${plays.toLocaleString()} views, ${likes} likes, ${comments} comments`;
      }

      const total = likes + comments + shares;
      return `${who}: ${total} combined (${likes} likes, ${comments} comments, ${shares} shares)`;
    })
    .join(". ");
}

/**
 * Validate transformed clip
 * Check required fields and data types
 */
function validateClip(clip) {
  const required = ["date", "pub", "plat", "subject"];
  const missing = required.filter(field => !clip[field]);

  if (missing.length > 0) {
    console.warn(`Clip missing required fields: ${missing.join(", ")}`, clip);
    return false;
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clip.date)) {
    console.warn(`Invalid date format: ${clip.date}`, clip);
    return false;
  }

  return true;
}

/**
 * Transform entire Apify dataset result into dashboard format
 * Top-level function for processing a complete run
 */
function transformApifyResult(apifyDataset, platform, metadata = {}) {
  if (!apifyDataset || !Array.isArray(apifyDataset)) {
    console.error("Invalid Apify dataset");
    return [];
  }

  let clips = transformBatch(apifyDataset, platform, metadata);

  // Validate all clips
  clips = clips.filter(clip => {
    const valid = validateClip(clip);
    if (!valid) {
      console.warn("Skipping invalid clip:", clip);
    }
    return valid;
  });

  return clips;
}

// Export for browser use
window.transformPost = transformPost;
window.transformBatch = transformBatch;
window.transformApifyResult = transformApifyResult;
window.transformFacebookPost = transformFacebookPost;
window.transformInstagramPost = transformInstagramPost;
window.transformTikTokVideo = transformTikTokVideo;
window.transformYouTubeVideo = transformYouTubeVideo;
window.transformTwitterPost = transformTwitterPost;
window.transformGenericPost = transformGenericPost;
window.deduplicateAndMerge = deduplicateAndMerge;
window.generateTractionNote = generateTractionNote;
window.validateClip = validateClip;
window.calculateTikTokTraction = calculateTikTokTraction;
window.calculateGeneralTraction = calculateGeneralTraction;
window.TRACTION_RULES = TRACTION_RULES;

// Example usage:
/*
const transformer = require('./apify-data-transformer');

// Transform a single TikTok video
const tikTokClip = transformer.transformPost(
  { viewCount: 250000, likeCount: 5000, commentCount: 200 },
  'tiktok',
  { category: 'social_updates', tier: 1 }
);

// Transform entire batch
const allClips = transformer.transformApifyResult(
  apifyDatasetItems,
  'tiktok',
  { category: 'social_updates', tier: 1 }
);

// Deduplicate across multiple sources
const merged = transformer.deduplicateAndMerge(allClips);
*/

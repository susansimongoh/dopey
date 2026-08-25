// Background function: comment-sentiment enrichment for ONE PM-approved social
// clip. Fetches comments where they weren't free at sweep time (TikTok/Instagram
// via a small per-post Apify run; Facebook already carries cmts from the sweep),
// writes the Gemini house-style sentiment line onto the clip, and mirrors it into
// any story carrying the clip. Returns 202 immediately; runs only on approval, so
// no comment spend on clips that won't be reported.
import { enrichClipComments } from '../lib/sps.mjs';

export default async (req) => {
  let date, project, clipId;
  try { ({ date, project, clipId } = await req.json()); } catch { /* fall through */ }
  if (!date || !clipId) { console.error('enrich-comments: date+clipId required'); return; }
  project = (project || 'sps').replace(/[^a-z0-9_-]/gi, '');
  try { await enrichClipComments(project, date, clipId); }
  catch (e) { console.error('enrich-comments failed', e); }
};

export const config = { path: '/api/enrich-comments' };

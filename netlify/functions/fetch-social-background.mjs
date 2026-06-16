// Background function: Apify social sweep (TikTok/Instagram/Facebook) → Supabase.
// Returns 202 immediately; client polls /api/day/:date for social_fetched_at.
import { runSocialFetch } from '../lib/sps.mjs';

export default async (req) => {
  let date, project;
  try { ({ date, project } = await req.json()); } catch { date = null; }
  date = (date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  project = (project || 'sps').replace(/[^a-z0-9_-]/gi, '');
  try { await runSocialFetch(project, date); }
  catch (e) { console.error('social fetch failed', e); }
};

export const config = { path: '/api/fetch-social' };

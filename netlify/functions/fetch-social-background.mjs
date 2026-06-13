// Background function: Apify social sweep (TikTok/Instagram/Facebook) → Supabase.
// Returns 202 immediately; client polls /api/day/:date for social_fetched_at.
import { runSocialFetch } from '../lib/sps.mjs';

export default async (req) => {
  let date;
  try { ({ date } = await req.json()); } catch { date = null; }
  date = (date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  try { await runSocialFetch(date); }
  catch (e) { console.error('social fetch failed', e); }
};

export const config = { path: '/api/fetch-social' };

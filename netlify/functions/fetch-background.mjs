// Background function: news/Reddit/Bing/YouTube sweep → Supabase.
// Returns 202 immediately; client polls /api/day/:date for fetched_at.
import { runNewsFetch } from '../lib/sps.mjs';

export default async (req) => {
  let date;
  try { ({ date } = await req.json()); } catch { date = null; }
  date = (date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  try { await runNewsFetch(date); }
  catch (e) { console.error('news fetch failed', e); }
};

export const config = { path: '/api/fetch' };

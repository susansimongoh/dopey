// Background function: news/Reddit/Bing/YouTube/outlet sweep → Supabase.
// Returns 202 immediately; client polls /api/day/:date for fetched_at.
import { runNewsFetch } from '../lib/sps.mjs';

export default async (req) => {
  let date, project;
  try { ({ date, project } = await req.json()); } catch { date = null; }
  date = (date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  project = (project || 'sps').replace(/[^a-z0-9_-]/gi, '');
  try { await runNewsFetch(project, date); }
  catch (e) { console.error('news fetch failed', e); }
};

export const config = { path: '/api/fetch' };

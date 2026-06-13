// Background function: one-off catch-up that fetches a wide window and buckets
// SPS-relevant items into the day each was PUBLISHED, then regenerates stories.
// Returns 202 immediately; poll /api/day/:date to watch days fill in.
import { runBackfill } from '../lib/sps.mjs';

export default async (req) => {
  let from;
  try { ({ from } = await req.json()); } catch { from = null; }
  from = (from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  try { const r = await runBackfill(from); console.log('backfill done', JSON.stringify(r)); }
  catch (e) { console.error('backfill failed', e); }
};

export const config = { path: '/api/backfill' };

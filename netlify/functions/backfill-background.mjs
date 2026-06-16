// Background function: one-off catch-up that fetches a wide window and buckets
// relevant items into the day each was PUBLISHED, then regenerates stories.
import { runBackfill } from '../lib/sps.mjs';

export default async (req) => {
  let from, project;
  try { ({ from, project } = await req.json()); } catch { from = null; }
  from = (from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
  project = (project || 'sps').replace(/[^a-z0-9_-]/gi, '');
  try { const r = await runBackfill(project, from); console.log('backfill done', JSON.stringify(r)); }
  catch (e) { console.error('backfill failed', e); }
};

export const config = { path: '/api/backfill' };

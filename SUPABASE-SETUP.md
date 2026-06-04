# Supabase Setup for SPS Media Monitor

## Create the monitoring_clips table

Run this SQL in Supabase's SQL Editor:

```sql
-- Create the monitoring_clips table
CREATE TABLE public.monitoring_clips (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  publisher TEXT NOT NULL,
  platform TEXT NOT NULL,
  subject TEXT NOT NULL,
  link TEXT,
  category TEXT,
  tier INTEGER,
  engagement JSONB,
  raw_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for fast queries
CREATE INDEX idx_monitoring_clips_date ON public.monitoring_clips(date DESC);
CREATE INDEX idx_monitoring_clips_platform ON public.monitoring_clips(platform);
CREATE INDEX idx_monitoring_clips_created_at ON public.monitoring_clips(created_at DESC);

-- Enable RLS (Row Level Security) - allow all reads, but only Netlify can write
ALTER TABLE public.monitoring_clips ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users (Netlify function) can insert
CREATE POLICY "Netlify can insert clips" ON public.monitoring_clips
  FOR INSERT
  WITH CHECK (true);

-- Policy: Anyone can read
CREATE POLICY "Anyone can read clips" ON public.monitoring_clips
  FOR SELECT
  USING (true);
```

## Get your Supabase credentials

In Supabase Dashboard:
1. Settings → API
2. Copy:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`

These go into Netlify environment variables.

## Fetch clips from the dashboard

```javascript
const SUPABASE_URL = "your-project.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-key";

async function fetchClipsFromSupabase() {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/monitoring_clips?order=created_at.desc&limit=100`,
    {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      }
    }
  );

  if (!response.ok) throw new Error(`Supabase error: ${response.status}`);
  return await response.json();
}
```

## Netlify environment variables

In Netlify Dashboard → Site settings → Build & deploy → Environment:

```
APIFY_TOKEN=apify_api_GSPIERMUCKGeEl1QqQrZSYShnzUdN30EGLFr
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
```

## Test the function

```bash
# From your project directory
netlify deploy --prod

# Then test the endpoint
curl https://your-site.netlify.app/.netlify/functions/run-apify-monitoring
```

Should return:
```json
{
  "success": true,
  "message": "Monitoring complete: X clips stored",
  "clipsCount": X,
  "timestamp": "2026-06-04T..."
}
```

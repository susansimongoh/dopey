/**
 * SPS Media Monitor – daily scrape Edge Function
 * Deploy: supabase functions deploy daily-scrape
 *
 * Required secrets (set via Supabase Dashboard → Edge Functions → Secrets):
 *   APIFY_TOKEN          – your Apify API token
 *   SUPABASE_URL         – https://ezQ96J5Y5Xd8b1sa.supabase.co (auto-available)
 *   SUPABASE_SERVICE_ROLE_KEY – auto-available inside Edge Functions
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const APIFY_BASE = 'https://api.apify.com/v2'
const TODAY      = new Date().toISOString().slice(0, 10)

// ── Apify helpers ─────────────────────────────────────────────────────────
async function runActor(actorId: string, input: unknown): Promise<unknown[]> {
  const token = Deno.env.get('APIFY_TOKEN')!

  // Start run
  const start = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${token}&waitForFinish=120`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  ).then(r => r.json())

  const datasetId: string = start?.data?.defaultDatasetId
  if (!datasetId) return []

  // Fetch results
  const items = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&clean=true&limit=20`
  ).then(r => r.json())

  return Array.isArray(items) ? items : []
}

// ── Format Apify results as clips ─────────────────────────────────────────
function igToClip(post: Record<string, unknown>, cat: string) {
  return {
    date: post.timestamp ? String(post.timestamp).slice(0, 10) : TODAY,
    pub:  String(post.ownerFullName || post.ownerUsername || 'Unknown'),
    plat: 'Instagram',
    subject: String(post.caption || '').slice(0, 250),
    link:    String(post.url || ''),
    cat,
    eng: {
      plays:    0,
      likes:    Number(post.likesCount || 0),
      comments: Number(post.commentsCount || 0),
      shares:   0,
    },
  }
}

function ttToClip(post: Record<string, unknown>, cat: string) {
  const author = (post.authorMeta as Record<string, unknown>) || {}
  const video  = (post.videoMeta  as Record<string, unknown>) || {}
  return {
    date: post.createTimeISO ? String(post.createTimeISO).slice(0, 10) : TODAY,
    pub:  String(author.nickName || author.name || 'Unknown'),
    plat: 'TikTok',
    subject: String(post.text || '').slice(0, 250),
    link: String(post.webVideoUrl || ''),
    cat,
    eng: {
      plays:    Number(post.playCount    || 0),
      likes:    Number(post.diggCount    || 0),
      comments: Number(post.commentCount || 0),
      shares:   Number(post.shareCount   || 0),
    },
  }
}

// ── Traction calculation (mirrors HTML logic) ─────────────────────────────
function calcTr(clip: ReturnType<typeof igToClip | typeof ttToClip>) {
  const TR = ['low', 'moderate', 'high', 'very_high']
  const higher = (a: string, b: string) => TR.indexOf(a) >= TR.indexOf(b) ? a : b

  const { plays = 0, likes = 0, comments = 0, shares = 0 } = clip.eng
  let trInt, trCom

  if (clip.plat === 'TikTok') {
    const eng = likes + comments + shares
    const v = plays >= 400000 ? 'very_high' : plays >= 100000 ? 'high' : plays >= 40000 ? 'moderate' : 'low'
    const e = eng  >= 14000   ? 'very_high' : eng   >= 3000   ? 'high' : eng   >= 850    ? 'moderate' : 'low'
    trInt = higher(v, e)
    trCom = comments >= 1500 ? 'very_high' : comments >= 300 ? 'high' : comments >= 100 ? 'moderate' : 'low'
  } else {
    const total = likes + comments + shares
    trInt = total    >= 1500 ? 'very_high' : total    >= 300 ? 'high' : total    >= 100 ? 'moderate' : 'low'
    trCom = comments >= 1500 ? 'very_high' : comments >= 300 ? 'high' : comments >= 100 ? 'moderate' : 'low'
  }
  return { trInt, trCom }
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const clips: ReturnType<typeof igToClip>[] = []

  // 1. Instagram: SPS + Yellow Ribbon + SANA
  try {
    const igPosts = await runActor('apify~instagram-post-scraper', {
      username: ['singaporeprisonservice', 'yellowribbonsg', 'singaporeantinarcotics'],
      resultsLimit: 5,
      onlyPostsNewerThan: '3 days',
      dataDetailLevel: 'basicData',
    }) as Record<string, unknown>[]
    for (const p of igPosts) {
      const owner = String((p.ownerUsername || '')).toLowerCase()
      const cat = owner.includes('yellow') ? 'yellow_ribbon'
                : owner.includes('sana')   ? 'care_network'
                : 'social_updates'
      clips.push(igToClip(p, cat))
    }
  } catch (e) { console.error('Instagram scrape failed:', e) }

  // 2. TikTok: SPS + Yellow Ribbon
  try {
    const ttPosts = await runActor('scrapeforge~tiktok-posts', {
      scrapeMode: 'profiles',
      profiles: ['singaporeprisonservice', 'yellowribbonsg'],
      maxResultsPerProfile: 5,
      sortBy: 'latest',
    }) as Record<string, unknown>[]
    for (const p of ttPosts) {
      const author = String(((p.authorMeta as Record<string, unknown>)?.name || '')).toLowerCase()
      const cat = author.includes('yellow') ? 'yellow_ribbon' : 'social_updates'
      clips.push(ttToClip(p, cat))
    }
  } catch (e) { console.error('TikTok scrape failed:', e) }

  // 3. Deduplicate by link
  const seen = new Set<string>()
  const unique = clips.filter(c => {
    if (!c.link || seen.has(c.link)) return false
    seen.add(c.link); return true
  })

  // 4. Auto-generate stories (one per category with engagement data)
  // Group clips by category and compute traction
  const byCat: Record<string, typeof unique> = {}
  for (const c of unique) {
    byCat[c.cat] = byCat[c.cat] || []
    byCat[c.cat].push(c)
  }

  const stories = Object.entries(byCat).map(([cat, catClips]) => {
    const trs = catClips.map(calcTr)
    const TR  = ['low', 'moderate', 'high', 'very_high']
    const higher = (a: string, b: string) => TR.indexOf(a) >= TR.indexOf(b) ? a : b
    const trInt = trs.reduce((best, t) => higher(best, t.trInt), 'low')
    const trCom = trs.reduce((best, t) => higher(best, t.trCom), 'low')
    const note  = catClips.filter(c => c.eng.plays || c.eng.likes).map(c => {
      const { plays, likes, comments, shares } = c.eng
      return c.plat === 'TikTok' && plays
        ? `${c.pub} (TikTok): ${plays.toLocaleString()} views, ${likes} likes`
        : `${c.pub} (${c.plat}): ${likes + comments + shares} interactions`
    }).join('. ')

    const headline = catClips.length === 1
      ? catClips[0].subject.slice(0, 120)
      : `${catClips.length} posts from ${[...new Set(catClips.map(c => c.pub))].join(', ')}`

    return { cat, hl: headline, summary: '', reported: '', syndicated: '',
             published: catClips.map(c => `${c.pub} (${c.plat})`).join(', '),
             trInt, trCom, trNote: note }
  })

  // 5. Upsert to Supabase
  const { error } = await supabase.from('sessions').upsert({
    date:     TODAY,
    saved_at: new Date().toISOString(),
    cfg: {
      num:        '',
      date:       new Date().toLocaleDateString('en-SG', { weekday:'long', day:'numeric', month:'long', year:'numeric' }),
      highlights: '1. XXX',
      issues:     '1. XXX',
      fyi:        '1. XXX',
    },
    clips:   unique,
    stories,
  }, { onConflict: 'date' })

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true, clips: unique.length, stories: stories.length, date: TODAY }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

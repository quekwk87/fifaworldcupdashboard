// ============================================================
// Cloudflare Worker — Premier League dashboard API proxy
//
// Routes:
//   GET /?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD   → PL fixtures & results
//   GET /highlights?home=..&away=..&date=..       → official YouTube highlights
//
// Secrets required (Settings → Variables and Secrets):
//   FD_API_KEY  — football-data.org API key
//   YT_API_KEY  — YouTube Data API v3 key
// ============================================================

// Origins allowed to call this Worker. Add your custom domain here
// when you move off github.io.
const ALLOWED_ORIGINS = [
  'https://quekwk87.github.io',
];

// Club name → official YouTube handle. Unresolved handles are reported
// in the `unresolved` field of /highlights responses.
const HANDLES = {
  arsenal: '@Arsenal',
  astonvilla: '@avfcofficial',
  bournemouth: '@afcbournemouth',
  brentford: '@BrentfordFC',
  brightonandhovealbion: '@OfficialBHAFC',
  burnley: '@BurnleyFOfficial',
  chelsea: '@ChelseaFC',
  crystalpalace: '@CPFC',
  everton: '@Everton',
  fulham: '@FulhamFC',
  leedsunited: '@LeedsUnited',
  liverpool: '@LiverpoolFC',
  manchestercity: '@ManCity',
  manchesterunited: '@manutd',
  newcastleunited: '@NUFC',
  nottinghamforest: '@officialnffc',
  sunderland: '@sunderlandafcofficial',
  tottenhamhotspur: '@TottenhamHotspur',
  westhamunited: '@WestHamUnited',
  wolverhamptonwanderers: '@Wolves',
};

// Searched alongside the two clubs playing
const ALWAYS = ['@premierleague', '@NBCSports'];

const MIN_SECONDS = 60;   // 1 minute
const MAX_SECONDS = 600;  // 10 minutes

// Cache TTLs (seconds)
const TTL_FIXTURES_LIVE = 300;    // current/future week — scores still moving
const TTL_FIXTURES_PAST = 21600;  // finished week — results are final (6h)
const TTL_HIGHLIGHTS_HIT = 86400; // videos found — they don't change (24h)
const TTL_HIGHLIGHTS_MISS = 600;  // nothing yet — retry soon (10m)

// Channel handle → ID, cached per isolate so repeat lookups are free
const idCache = new Map();

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function normalizeTeam(name) {
  return (name || '').toLowerCase()
    .replace(/\b(fc|afc)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function parseDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

async function resolveHandle(handle, key) {
  if (idCache.has(handle)) return idCache.get(handle);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${key}`
  );
  const data = await res.json();
  const id = data.items?.[0]?.id || null;
  idCache.set(handle, id);
  return id;
}

async function handleHighlights(url, env) {
  const home = url.searchParams.get('home') || '';
  const away = url.searchParams.get('away') || '';
  const date = url.searchParams.get('date');
  const key = env.YT_API_KEY;

  // 1. Resolve official channel IDs from handles (1 quota unit each, cached)
  const wanted = [...ALWAYS];
  for (const team of [home, away]) {
    const h = HANDLES[normalizeTeam(team)];
    if (h) wanted.push(h);
  }
  const resolved = await Promise.all(wanted.map(h => resolveHandle(h, key)));
  const officialIds = new Set(resolved.filter(Boolean));
  const unresolved = wanted.filter((h, i) => !resolved[i]);

  // 2. Search within a tight window around the match date
  let dateParams = '';
  if (date) {
    const d = new Date(date);
    const after = new Date(d); after.setDate(after.getDate() - 1);
    const before = new Date(d); before.setDate(before.getDate() + 3);
    dateParams = `&publishedAfter=${after.toISOString()}&publishedBefore=${before.toISOString()}`;
  }
  const q = encodeURIComponent(`"${home}" "${away}" highlights`);
  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video` +
    `&maxResults=25&order=relevance&videoEmbeddable=true${dateParams}&key=${key}`
  );
  const search = await searchRes.json();
  if (search.error) {
    return { body: search, status: searchRes.status, ttl: 0 };
  }

  const items = search.items || [];
  if (items.length === 0) {
    return { body: { items: [], officialOnly: true, unresolved }, status: 200, ttl: TTL_HIGHLIGHTS_MISS };
  }

  // 3. Exact durations in one batched call (1 quota unit for up to 50 ids)
  const ids = items.map(i => i.id.videoId).join(',');
  const detRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${key}`
  );
  const det = await detRes.json();
  const durations = {};
  (det.items || []).forEach(v => { durations[v.id] = parseDuration(v.contentDetails?.duration); });

  // 4. Keep official channels within the duration window; fall back if none
  const inRange = i => {
    const s = durations[i.id.videoId];
    return s >= MIN_SECONDS && s <= MAX_SECONDS;
  };
  const official = items.filter(i => officialIds.has(i.snippet.channelId) && inRange(i));

  let out = official;
  let officialOnly = true;
  if (out.length === 0) {
    out = items.filter(inRange).slice(0, 10);
    officialOnly = false;
  }

  return {
    body: { items: out, officialOnly, unresolved },
    status: 200,
    ttl: out.length > 0 ? TTL_HIGHLIGHTS_HIT : TTL_HIGHLIGHTS_MISS,
  };
}

async function handleFixtures(url, env) {
  const from = url.searchParams.get('dateFrom');
  const to = url.searchParams.get('dateTo');

  const res = await fetch(
    `https://api.football-data.org/v4/competitions/PL/matches?dateFrom=${from}&dateTo=${to}`,
    { headers: { 'X-Auth-Token': env.FD_API_KEY } }
  );
  const body = await res.json();

  // A week that has already ended can be cached for much longer
  const weekEnded = to && new Date(`${to}T23:59:59Z`) < new Date();
  const ttl = res.ok ? (weekEnded ? TTL_FIXTURES_PAST : TTL_FIXTURES_LIVE) : 0;

  return { body, status: res.status, ttl };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
    }

    // Block cross-origin use from sites that aren't ours. Requests with no
    // Origin header (direct navigation, curl) are allowed so the endpoints
    // stay testable — this stops hotlinking, not a determined scripter.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });

    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const { body, status, ttl } = url.pathname === '/highlights'
      ? await handleHighlights(url, env)
      : await handleFixtures(url, env);

    const response = new Response(JSON.stringify(body), {
      status,
      headers: { ...JSON_HEADERS, 'Cache-Control': `public, max-age=${ttl}` },
    });

    if (status === 200 && ttl > 0) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};

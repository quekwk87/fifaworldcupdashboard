#!/usr/bin/env node
// ============================================================
// Generates one static, crawlable HTML page per Premier League match
// under matches/<slug>/index.html, plus sitemap.xml.
//
// Why this exists: the main site (index.html) is a client-rendered SPA
// with exactly one URL. Search engines can't rank "Arsenal vs Chelsea
// highlights" against a page that has no text about that match until
// JavaScript runs. This script gives every match its own stable URL
// with the score/summary baked into real HTML text, plus structured
// data, so it's actually indexable.
//
// Run via .github/workflows/generate-match-pages.yml on a schedule.
// Safe to run locally too: `node scripts/generate-match-pages.mjs`.
// ============================================================

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MATCHES_DIR = path.join(ROOT, 'matches');
const CACHE_PATH = path.join(__dirname, 'data', 'highlights-cache.json');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');

const PROXY_URL = 'https://silent-mode-cf93.quekwk.workers.dev';
const SITE_URL = 'https://quekwk87.github.io/fifaworldcupdashboard';

const WEEKS_BACK = 10;   // regenerate/refresh this many past weeks each run
const WEEKS_FORWARD = 2; // and preview this many upcoming weeks

// Only actively query YouTube for matches finished within this window, and
// give up after this many daily attempts. Bounds quota use — once a video
// is found it's cached forever; if a handle is wrong or nothing gets
// posted, we stop asking after two weeks rather than burning quota on it
// indefinitely on every run.
const RESOLVE_WINDOW_DAYS = 5;
const MAX_ATTEMPTS = 14;

const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ---- date helpers (mirrors index.html's, kept independent on purpose —
// this runs in Node, not the browser, and has no shared module to import) ----
function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function toSGT(utcStr) {
  return new Date(new Date(utcStr).getTime() + 8 * 3600000);
}
function longDate(d) {
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fmtKickoff(sgt) {
  const h = sgt.getUTCHours(), m = sgt.getUTCMinutes();
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
}
function getMondayUTC(d) {
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
}
function weekRange(offsetWeeks) {
  const monday = getMondayUTC(new Date());
  monday.setUTCDate(monday.getUTCDate() + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday, end: sunday };
}

// Must match slugifyTeam()/matchSlug() in index.html exactly, or the
// permalinks the app renders will 404.
function slugifyTeam(name) {
  return (name || '')
    .replace(/\b(FC|AFC)\b/gi, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function matchSlug(m) {
  const date = isoDate(toSGT(m.utcDate));
  return `${slugifyTeam(m.homeTeam.name)}-vs-${slugifyTeam(m.awayTeam.name)}-${date}`;
}

function statusOf(m) {
  if (m.status === 'FINISHED' || m.status === 'AWARDED') return 'ft';
  return 'upcoming'; // live/paused matches are treated as upcoming for static-page purposes; the live experience is what the SPA is for
}
function goals(m) {
  const s = m.score || {};
  const h = s.fullTime?.home ?? s.regularTime?.home ?? null;
  const a = s.fullTime?.away ?? s.regularTime?.away ?? null;
  return { h, a };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON.stringify doesn't escape "</script", so a value containing that
// literal substring could break out of the <script type="application/ld+json">
// block. Team/venue names come from football-data.org, not user input, so
// this is defensive rather than a live threat — but it's free to guard.
function jsonLd(obj) {
  return JSON.stringify(obj, null, 2).replace(/<\//g, '<\\/');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- fetch fixtures week by week (same shape the live app uses, so it
// benefits from the same Worker cache) ----
async function fetchWeek(offsetWeeks) {
  const { start, end } = weekRange(offsetWeeks);
  const url = `${PROXY_URL}?dateFrom=${isoDate(start)}&dateTo=${isoDate(end)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) { console.warn(`fixtures fetch failed for week ${offsetWeeks}: HTTP ${res.status}`); return []; }
    const data = await res.json();
    return data.matches || [];
  } catch (e) {
    console.warn(`fixtures fetch errored for week ${offsetWeeks}:`, e.message);
    return [];
  }
}

async function fetchAllMatches() {
  const byId = new Map();
  for (let w = -WEEKS_BACK; w <= WEEKS_FORWARD; w++) {
    const matches = await fetchWeek(w);
    matches.forEach(m => byId.set(m.id, m));
    await sleep(250); // stay well clear of football-data.org's free-tier rate limit
  }
  return [...byId.values()];
}

// ---- highlights cache ----
async function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); }
  catch { return {}; }
}
async function saveCache(cache) {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

async function resolveHighlight(m, cache) {
  const key = String(m.id);
  const entry = cache[key];
  if (entry?.video) return entry.video; // already found — never re-query

  const daysSinceFinish = (Date.now() - new Date(m.utcDate).getTime()) / 86400000;
  if (daysSinceFinish > RESOLVE_WINDOW_DAYS) return null; // too old, not worth spending quota on

  const attempts = entry?.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) return null; // gave up

  const today = isoDate(new Date());
  if (entry?.lastCheckedDate === today) return null; // already tried today

  try {
    const url = `${PROXY_URL}/highlights?home=${encodeURIComponent(m.homeTeam.name)}&away=${encodeURIComponent(m.awayTeam.name)}&date=${encodeURIComponent(m.utcDate)}`;
    const res = await fetch(url);
    const data = await res.json();
    const item = data.items?.[0];
    if (item) {
      cache[key] = { video: item, attempts: attempts + 1, lastCheckedDate: today };
      return item;
    }
    cache[key] = { attempts: attempts + 1, lastCheckedDate: today };
    return null;
  } catch (e) {
    console.warn(`highlights lookup failed for match ${m.id}:`, e.message);
    return null;
  }
}

// ---- summary text ----
function summarize(m, homeName, awayName) {
  const dateStr = longDate(new Date(m.utcDate));
  const venuePart = m.venue ? ` at ${m.venue}` : '';
  if (statusOf(m) === 'ft') {
    const { h, a } = goals(m);
    const result = h === a
      ? 'The match finished level.'
      : (h > a ? `${homeName} won.` : `${awayName} won.`);
    return `${homeName} ${h}–${a} ${awayName}: Premier League Matchday ${m.matchday} result${venuePart} on ${dateStr}. ${result}`;
  }
  const sgt = toSGT(m.utcDate);
  return `${homeName} host ${awayName} in a Premier League Matchday ${m.matchday} fixture${venuePart}, kicking off at ${fmtKickoff(sgt)} SGT/MYT on ${dateStr}.`;
}

// ---- page template ----
function renderPage(m, video) {
  const homeName = m.homeTeam.shortName || m.homeTeam.name;
  const awayName = m.awayTeam.shortName || m.awayTeam.name;
  const finished = statusOf(m) === 'ft';
  const slug = matchSlug(m);
  const pageUrl = `${SITE_URL}/matches/${slug}/`;
  const summary = summarize(m, homeName, awayName);
  const { h, a } = goals(m);

  const titleScore = finished ? ` (${h}-${a})` : '';
  const title = finished
    ? `${homeName} vs ${awayName}${titleScore} — Premier League Highlights`
    : `${homeName} vs ${awayName} — Kickoff Time & Preview`;
  const fullTitle = `${title} | PL Fixtures SGT/MYT`;

  const ogImage = video?.snippet?.thumbnails?.high?.url || video?.snippet?.thumbnails?.medium?.url || `${SITE_URL}/assets/og-image.png`;

  const scoreBlock = finished
    ? `<div class="score">${h}<span class="dash">–</span>${a}</div><div class="ft-label">Full-time</div>`
    : `<div class="kickoff">${fmtKickoff(toSGT(m.utcDate))} <span class="tz">SGT/MYT</span></div>`;

  let highlightsBlock = '';
  if (finished && video) {
    const vid = video.id.videoId;
    highlightsBlock = `
    <section class="highlights">
      <h2>Highlights</h2>
      <div class="video-wrap">
        <iframe src="https://www.youtube.com/embed/${vid}" title="${escapeHtml(video.snippet.title)}" allowfullscreen loading="lazy" allow="encrypted-media"></iframe>
      </div>
      <p class="video-credit">${escapeHtml(video.snippet.channelTitle)} · <a href="https://www.youtube.com/watch?v=${vid}" target="_blank" rel="noopener">Watch on YouTube &#8599;</a></p>
    </section>`;
  } else if (finished) {
    highlightsBlock = `
    <section class="highlights">
      <h2>Highlights</h2>
      <p class="no-video">Official highlights aren’t up yet — check back soon, or see the <a href="${SITE_URL}/">live fixtures app</a> for the latest.</p>
    </section>`;
  }

  const videoJsonLd = (finished && video) ? `
<script type="application/ld+json">
${jsonLd({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.snippet.title,
    description: video.snippet.description || summary,
    thumbnailUrl: [video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.medium?.url].filter(Boolean),
    uploadDate: video.snippet.publishedAt,
    contentUrl: `https://www.youtube.com/watch?v=${video.id.videoId}`,
    embedUrl: `https://www.youtube.com/embed/${video.id.videoId}`,
  })}
</script>` : '';

  const eventJsonLd = `
<script type="application/ld+json">
${jsonLd({
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${homeName} vs ${awayName}`,
    startDate: m.utcDate,
    description: summary,
    ...(m.venue ? { location: { '@type': 'Place', name: m.venue } } : {}),
    homeTeam: { '@type': 'SportsTeam', name: m.homeTeam.name },
    awayTeam: { '@type': 'SportsTeam', name: m.awayTeam.name },
  })}
</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0b0b0c">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${pageUrl}">
<link rel="icon" type="image/png" sizes="32x32" href="${SITE_URL}/assets/favicon-32.png">
<link rel="apple-touch-icon" href="${SITE_URL}/assets/apple-touch-icon.png">

<meta property="og:type" content="${finished && video ? 'video.other' : 'website'}">
<meta property="og:site_name" content="PL Fixtures SGT/MYT">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(summary)}">
<meta property="og:image" content="${ogImage}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(summary)}">
<meta name="twitter:image" content="${ogImage}">
${eventJsonLd}${videoJsonLd}
<style>
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Archivo:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0b0b0c;color:#f7f7f5;font-family:'Archivo',sans-serif;font-size:15px;line-height:1.6;max-width:600px;margin:0 auto;padding:24px 20px 60px}
  a{color:#ff3b1f}
  .nav{font-size:13px;color:#8c8c93;text-decoration:none;display:inline-block;margin-bottom:20px}
  h1{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:32px;text-transform:uppercase;line-height:1.05;letter-spacing:.01em;margin-bottom:10px}
  .meta{font-size:12px;color:#8c8c93;letter-spacing:.04em;text-transform:uppercase;margin-bottom:24px}
  .score-row{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  .score{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:56px;color:#f7f7f5}
  .score .dash{color:#4a4a50;margin:0 8px}
  .ft-label{font-size:12px;font-weight:600;letter-spacing:.1em;color:#8c8c93;text-transform:uppercase}
  .kickoff{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:28px;margin-bottom:20px}
  .kickoff .tz{font-size:13px;color:#8c8c93;font-family:'Archivo',sans-serif;font-weight:500}
  .summary{color:#c9c9cf;margin-bottom:32px}
  .highlights h2{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:14px}
  .video-wrap{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden}
  .video-wrap iframe{width:100%;height:100%;border:0}
  .video-credit{font-size:12px;color:#8c8c93;margin-top:8px}
  .no-video{color:#8c8c93;font-size:14px}
  footer{margin-top:48px;padding-top:20px;border-top:1px solid #1f1f24;font-size:12px;color:#5c5c62}
</style>
</head>
<body>
<a class="nav" href="${SITE_URL}/">&larr; All fixtures</a>
<h1>${escapeHtml(homeName)} vs ${escapeHtml(awayName)}</h1>
<div class="meta">Premier League &middot; Matchday ${m.matchday}${m.venue ? ` &middot; ${escapeHtml(m.venue)}` : ''} &middot; ${longDate(new Date(m.utcDate))}</div>
<div class="score-row">${scoreBlock}</div>
<p class="summary">${escapeHtml(summary)}</p>
${highlightsBlock}
<footer>Unofficial fan-made dashboard &mdash; not affiliated with the Premier League. Fixture data via football-data.org. Highlights via YouTube.</footer>
</body>
</html>
`;
}

// ---- write helpers (skip unchanged files so git diffs stay small) ----
async function writeIfChanged(filePath, content) {
  if (existsSync(filePath)) {
    const existing = await readFile(filePath, 'utf8');
    if (existing === content) return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return true;
}

async function buildSitemap() {
  const urls = [{ loc: `${SITE_URL}/`, priority: '1.0', changefreq: 'daily' }];
  if (existsSync(MATCHES_DIR)) {
    const entries = await readdir(MATCHES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(MATCHES_DIR, entry.name, 'index.html');
      if (!existsSync(indexPath)) continue;
      const mtime = (await stat(indexPath)).mtime.toISOString().slice(0, 10);
      urls.push({ loc: `${SITE_URL}/matches/${entry.name}/`, priority: '0.7', changefreq: 'monthly', lastmod: mtime });
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map(u => `  <url>\n    <loc>${u.loc}</loc>\n${u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''}    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')
  }\n</urlset>\n`;
  return writeIfChanged(SITEMAP_PATH, xml);
}

// ---- main ----
async function main() {
  console.log('Fetching fixtures...');
  const matches = await fetchAllMatches();
  console.log(`Fetched ${matches.length} matches across ${WEEKS_BACK + WEEKS_FORWARD + 1} weeks.`);

  const cache = await loadCache();
  let written = 0, resolved = 0;

  for (const m of matches) {
    let video = null;
    if (statusOf(m) === 'ft') {
      const before = cache[String(m.id)]?.video;
      video = await resolveHighlight(m, cache);
      if (video && !before) resolved++;
    }
    const html = renderPage(m, video);
    const filePath = path.join(MATCHES_DIR, matchSlug(m), 'index.html');
    if (await writeIfChanged(filePath, html)) written++;
  }

  await saveCache(cache);
  const sitemapChanged = await buildSitemap();

  console.log(`Wrote/updated ${written} match page(s). Resolved ${resolved} new highlight(s). Sitemap ${sitemapChanged ? 'updated' : 'unchanged'}.`);
}

main().catch(e => { console.error(e); process.exit(1); });

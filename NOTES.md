# Project notes

Maintenance reference for this repo. Keep this updated when something
changes that a future session (or future you) would otherwise have to
rediscover the hard way.

## Architecture

- **`index.html`** — the live site. A client-rendered single-page app;
  fetches the current week's fixtures from the Cloudflare Worker on load.
- **`worker.js`** — Cloudflare Worker. Proxies football-data.org (fixtures)
  and the YouTube Data API (highlights), holding both API keys server-side.
  Also enforces the `ALLOWED_ORIGINS` check and caches responses.
- **`scripts/generate-match-pages.mjs`** — generates one static, SEO-indexable
  page per match under `matches/<home>-vs-<away>-<date>/index.html`, plus
  `sitemap.xml`. Run by `.github/workflows/generate-match-pages.yml` daily
  (06:00 UTC) and on manual dispatch. Talks to the same Worker.
- **`matches/`** — generated output, committed to the repo (not gitignored —
  it's the actual served content).
- **`scripts/data/highlights-cache.json`** — persists which matches have a
  resolved highlight video (or have given up after 14 attempts), so the
  daily job doesn't re-spend YouTube quota on the same match repeatedly.

## ⚠️ The Worker is NOT auto-deployed

`worker.js` in this repo is the source of truth, but Cloudflare does not
pull from GitHub automatically. **Every time `worker.js` changes, it must
be manually copy-pasted into the Cloudflare dashboard and redeployed**, or
the live Worker silently keeps running whatever was pasted in last time.

This has caused real bugs before — e.g. stale scores on the homepage while
the backend (which calls the Worker from GitHub Actions, not a browser)
kept working fine, because only the deployed Worker's origin-check logic
was out of date relative to the repo.

**When touching `worker.js`: tell the user explicitly to redeploy, and
don't assume a repo commit alone fixes anything live.**

Secrets required in the Cloudflare dashboard (Settings → Variables and
Secrets, not in the repo):
- `FD_API_KEY` — football-data.org API key
- `YT_API_KEY` — YouTube Data API v3 key

## Known quirks (not bugs — don't re-chase these)

- **Google Search Console → Sitemaps report shows "Couldn't fetch" /
  "Sitemap could not be read"** despite `sitemap.xml` being confirmed
  valid (clean XML, no BOM, no truncation, correctly served, not blocked
  by `robots.txt`), and despite URL Inspection's **live** fetch test
  separately confirming "URL is available to Google". This is a
  documented, sometimes long-lived quirk reported by multiple developers
  on GitHub Pages specifically — no confirmed root cause or fix exists in
  the community. It does not block actual indexing; Google can still
  discover match pages by following links from the homepage. Don't keep
  resubmitting the sitemap or treat this as a sign something else is
  broken — periodically check back on the Sitemaps report instead.

- **This GitHub Pages URL has no custom-header control.** Unlike Cloudflare
  Pages/Netlify, there's no way to set response headers (e.g. force a
  `Content-Type`) from this repo. If a future issue turns out to genuinely
  be a header problem, the fix is migrating hosting, not a repo change.

## Monetization status

Deliberately deferred. football-data.org's free tier is non-commercial use
only and crests/logos aren't licensed for use at all — ads or any paid
tier would need the data-source question revisited first. See conversation
history for the full reasoning; nothing here currently assumes
monetization.

## Status log

- **2026-09** — Rebuilt from a World Cup bracket tracker into a Premier
  League fixtures/results/highlights dashboard. Added the Cloudflare
  Worker proxy (CORS + API key security), YouTube highlights (official
  channels only, date-filtered), SEO fundamentals (meta tags, favicon,
  robots.txt), the static per-match page generator, Cloudflare Web
  Analytics on both the homepage and match pages.
- **2026-10-21** — Worker redeployed after drifting from the repo;
  homepage scores confirmed updating again. Sitemap `Couldn't fetch`
  status in Search Console remains (see Known quirks above) — file itself
  verified healthy via live URL Inspection test.

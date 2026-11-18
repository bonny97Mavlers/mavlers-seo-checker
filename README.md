# Mavlers SEO Pre-Launch Checker

Internal QA tool that answers one question: **"Is this website ready for client delivery?"**
Enter a URL → the server crawls the site → checks every page against the Mavlers on-page SEO standards → scores it → returns **READY / READY WITH WARNINGS / NOT READY**, with issues to fix, an audit-aware AI assistant, history and comparison, and reports.

## Run it

```bash
npm install
npm start                      # http://localhost:4300  (Node 22.5+)
```

Local trial with no internet needed:
```bash
npm run fixture                # demo site with planted SEO defects on :4400
npm run dev                    # app in dev mode (lets you audit localhost)
npm test                       # end-to-end smoke test (20 assertions)
```
## Deploy on Vercel

The repo is set up for Vercel (`vercel.json` + `api/index.js`): static UI from `public/`, API as one serverless function.

1. Import the repo in Vercel (no build settings needed).
2. **Storage → Create Database → Neon Postgres** and connect it to the project. This sets `DATABASE_URL`; tables and default standards are created automatically on the first request. Without it the app runs on a temporary database and shows a red warning banner.
3. Optional env vars: `API_TOKEN` (recommended — the URL is public), `ANTHROPIC_API_KEY`, `PAGESPEED_API_KEY`.
4. Redeploy after adding env vars.

On Vercel each audit runs in the background of the request that started it (`waitUntil`), limited by the function's 300 s max duration. Crawling stops discovering new pages after `CRAWL_TIME_BUDGET_MS` (200 s by default), then runs the analysis on what it has, and the dashboard flags it. Very large sites need several audits or a self-hosted server (Docker) with no time limit.

Locally the app uses SQLite when `DATABASE_URL` isn't set, and Postgres when it is.

Docker: `docker build -t mavlers-seo . && docker run -p 4300:4300 -v seo-data:/data --env-file .env mavlers-seo`

Settings are in `.env.example`. Optional: `ANTHROPIC_API_KEY` (Claude assistant + AI fix suggestions), `PAGESPEED_API_KEY` (LCP/INP/CLS), `API_TOKEN` (shared access token).

## Architecture

```
api/index.js       Vercel function entry (re-exports the Express app)
public/            Front end (vanilla ES modules, no build step)
  css/app.css      Mavlers tokens (#FFDB2D / #000 / #FFF, Montserrat) — map to the existing design system here
  js/app.js        Shell, router, context bar · js/views/*.js one file per screen
server/
  index.js         REST API, roles, rate limiting, audit queue
  db.js            Async DB adapter — Postgres (DATABASE_URL) in production, SQLite locally
  crawler/         urlGuard (SSRF protection) · fetcher (manual redirects, timeouts, size caps, per-host throttle)
                   robots · sitemap · parser (HTML → page data) · crawlManager (crawl lifecycle + live progress)
  engine/          defaultStandards (seed from "On-page SEO — included at build") · standards (library service)
                   rules (one function per standard) · analyse (page typing, link graph, scoring, readiness, carry-over)
  ai/assistant.js  Audit context builder → Claude API, or the built-in rule-based assistant when there's no key
  reports.js       Internal QA + client reports (printable HTML → Save as PDF), CSV export
fixtures/          Test site + smoke test
```

**Standards are data, not code.** All 85 standards (threshold, severity, page types, recommendation, on/off) and the category weights can be edited in **SEO Standards** without a rebuild. Each edit increases the standards version, and every audit records the version it ran against.

**Readiness:** any open critical issue → NOT READY. Open warnings or unconfirmed manual checklist items → READY WITH WARNINGS. Otherwise READY. When an issue is marked resolved or ignored, readiness updates straight away; the score only changes after a re-crawl confirms the fix.

**Data labels:** throughout the UI, every finding is tagged *Auto-verified*, *Heuristic*, *AI recommendation / Template suggestion* or *Manual verification*.

## Before wider rollout
- **Branding:** add the official logo as `public/brand/logo.svg` (it's picked up automatically). If the existing Mavlers project has a token file or components, map the variables at the top of `app.css` to it.
- **Auth:** "Viewing as" role switching is scaffolding. Put Google Workspace SSO in the `/api` middleware in `server/index.js`.
- **JS-rendered sites:** the crawler reads server HTML. Fully client-rendered sites would need a headless-browser fetcher added in `crawler/fetcher.js`.
- **Integrations planned:** Search Console, GA4, Rich Results Test, Lighthouse, Ahrefs/Semrush. Each would add data to `site` in `crawlManager.js` plus rules in `engine/rules.js`.

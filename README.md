# scrape-pipeline

## What

A scheduled web data pipeline. Point it at a site, and every run it pulls the data, checks the
data is sane, and tells you **what changed since last time** — new rows, removed rows, and
changed fields like a price or a stock status.

It stops quietly instead of guessing: if the site's layout changes and the scraper starts
returning blanks, the run fails loudly rather than reporting success over empty data.

## Tech Stack

- Node.js 24 + TypeScript (run directly, no build step)
- `cheerio` — HTML parsing
- `zod` — config and data validation
- `robots-parser` — robots.txt compliance
- Node's built-in `fetch`

## Local Dev

```bash
cd projects/scrape-pipeline
npm install
npm start                          # runs the demo target
npm run run -- targets/<name>.json # runs any other target
npm run typecheck
```

Run it twice to see change detection — the first run has nothing to compare against.

## Adding a site

Drop a JSON file in `targets/`. No code changes. See `CLAUDE.md` for the field reference.

## How it behaves

- Reads and honors `robots.txt`, including `Crawl-delay`
- Waits between requests, retries with backoff on 429 and 5xx
- Identifies itself with a descriptive User-Agent
- Public pages only — nothing behind a login, no bot-protection bypass

## AIOS Integration

- Skill: not yet created
- Connection: not yet registered in `connections.md`
- Trigger: n/a

## Status

active — scaffold working, demo target verified. Export destinations, alerting, and scheduling
are the next build steps.

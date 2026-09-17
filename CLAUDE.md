# scrape-pipeline — CLAUDE.md
*Part of Tariq_Osmani_OS — see root CLAUDE.md for AIOS context.*

## Project Overview

A scheduled web data pipeline. It scrapes a target site, validates what it got, compares the
result against the previous run, and reports **what changed** — new rows, removed rows, and
changed fields. Built as an Upwork portfolio piece: the catalog has no scraping proof and no
live TypeScript proof, and the job-screener data shows recurring scrape-and-diff pipelines
(scores 88 and 93) are the well-paid shape of this work, not one-off list building.

Selling line: *"tell me what changed"*, not *"I scraped a page"*.

## Runtime

Node 24 runs TypeScript natively (type stripping) — **there is no build step and no `tsx`**.
Run `.ts` files directly with `node`. Because of type stripping, all type-only imports must use
`import type`, and TS-only runtime syntax (enums, parameter properties, namespaces) is banned.
`tsconfig.json` enforces this with `erasableSyntaxOnly`.

## Commands

```bash
npm start                          # run the books.toscrape.com demo target
npm run run -- targets/<name>.json # run any other target
npm run typecheck                  # tsc --noEmit (types only; nothing is emitted)
```

Exit code is `0` when the run is healthy and `1` when a health check fails, so cron or CI
catches a broken scrape instead of logging success over empty data.

## Architecture

```
targets/*.json  →  config.ts (validate)  →  fetch.ts (polite GET)  →  extract.ts (parse)
                                                                            ↓
                           report (stdout) ←  index.ts  ←  store.ts (snapshot + diff)
```

- **`src/config.ts`** — Zod schema for a target file. Rejects a bad config before any network call.
- **`src/fetch.ts`** — the politeness layer: robots.txt (cached per origin, honors `Crawl-delay`),
  per-request delay, retry with backoff on 429/5xx, descriptive User-Agent.
- **`src/extract.ts`** — Cheerio extraction driven by the config's selectors, plus `fillRates()`.
- **`src/store.ts`** — snapshot read/write to `data/<target>.json` and the keyed diff. A snapshot
  is `{ target, runAt, itemCount, fillRates, items }`; `diff()` maps both item lists by `key` and
  compares by `JSON.stringify` equality, so field order inside an item never causes a false change.
- **`src/index.ts`** — orchestration, health checks, and the run report.

## Target config format

One JSON file per site in `targets/`. `key` must name one of the `fields` and must be stable —
the diff is keyed on it.

```json
{
  "name": "books-demo",
  "startUrl": "https://books.toscrape.com/catalogue/page-1.html",
  "maxPages": 3,
  "requestDelayMs": 1000,
  "userAgent": "scrape-pipeline/0.1 (portfolio demo; +https://smartaiworkspace.tech)",
  "itemSelector": "article.product_pod",
  "fields": {
    "title": { "selector": "h3 a", "attr": "title" },
    "price": { "selector": "p.price_color" }
  },
  "key": "title",
  "nextPageSelector": "li.next a",
  "minItemsExpected": 40
}
```

Omit `attr` to take the element's text.

## Health checks (the differentiating feature)

A scraper that returns HTTP 200 with empty fields is the failure everyone gets burned by. Before
reporting success this checks: zero items extracted, item count below `minItemsExpected`, any
field at 0% fill, and any field whose fill rate dropped more than 50 points versus the previous
run (selector drift). Any of those fails the run.

## Rules

- **Public data only.** No login-gated or paywalled pages, no CAPTCHA solving, no fingerprint or
  TLS spoofing, no proxy rotation for evasion. This has to be publicly showable and sellable —
  the good-citizen posture *is* the product, and it is the legal posture after *Meta v. Bright Data*.
- **Never demo against** LinkedIn, Meta, Amazon, Zillow, Indeed, or Google Maps. Safe targets:
  `books.toscrape.com`, `quotes.toscrape.com`, `scrapethissite.com`, SEC EDGAR, open-data portals.
- **Check for a JSON/XHR endpoint or an official API before scraping HTML.** Most "hard" sites
  hand over JSON directly.
- **Plain HTTP first.** Only reach for a headless browser when content is genuinely client-rendered.
  Playwright is deliberately *not* a dependency yet — do not add it until a target needs it.
- **No personal contact data** in demo targets (GDPR exposure; CNIL fined Kaspr €240k for this).
- Keep dependencies minimal. Current set: `cheerio`, `zod`, `robots-parser`. Node's built-in
  `fetch` covers HTTP.

## Known workaround

`robots-parser@3.0.1` ships a broken `index.d.ts` (a shorthand `declare module` shadows its real
export, so the module types as non-callable). `src/fetch.ts` restates the runtime signature and
casts. Remove that cast if upstream fixes the typings.

## Status

**Scaffold working, verified end to end.** The demo target pulls 60 items across 3 pages, diffs
against the previous snapshot, and fails correctly on a broken selector.

Not built yet, in rough priority order: Google Sheets export (the deliverable clients actually
ask for), an email/Telegram "what changed" digest, scheduling, a second target on a real live
site (SEC EDGAR), and the Upwork portfolio card.

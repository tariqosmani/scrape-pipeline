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

## Env vars

This project keeps its **own `.env`** in `projects/scrape-pipeline/` (git-ignored), a deliberate
exception to the root rule that projects read the shared root `.env`: it is built to deploy on its
own. Keys: `SCRAPE_PIPELINE_SERVICE_ACCOUNT_EMAIL`, `SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY`
(in double quotes, either one line with `\n` escapes or the PEM across real lines; both load),
`SCRAPE_PIPELINE_SHEET_ID`, `SCRAPE_PIPELINE_TELEGRAM_BOT_TOKEN`, `SCRAPE_PIPELINE_TELEGRAM_CHAT_ID`.
Google Sheets access is a service account, not an API key: an API key can only read public sheets
and cannot write.

**Telegram is blocked on Tariq's local network.** `api.telegram.org` resets the TLS handshake while
Google and GitHub work, so a local run cannot send an alert or call `getUpdates`. Test the Telegram
path from the deploy host or over a VPN, not from this PC.

The original JSON key file is kept **outside the repo** at `~/.config/scrape-pipeline/service-account.json`.
Never place a key file inside the project: Google's default name (`invoice-472509-<id>.json`) matches
no ignore rule and would be committed.

## Commands

```bash
npm start                          # run the books.toscrape.com demo target
npm run run -- targets/<name>.json # run any other target
npm run typecheck                  # tsc --noEmit (types only; nothing is emitted)
```

Exit code is `0` when the run is healthy and `1` when a health check, the Sheets export, or the
Telegram alert fails, so cron or CI catches a broken scrape instead of logging success over empty data.

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
- **`src/index.ts`** — orchestration, health checks, the run report, the Sheets push, and the alert.
- **`src/sheets.ts`** — Google Sheets export through a service account. It signs its own JWT with
  `node:crypto` and calls the Sheets REST API with `fetch`, so there is no Google client library.
  Skipped with a log line when the `SCRAPE_PIPELINE_*` vars are not set.
- **`src/telegram.ts`** — the "what changed" alert. `digest()` returns the message text, or `null`
  for a quiet healthy run or a baseline, so the bot only speaks when something changed, the health
  check failed, or the Sheets export failed. Plain text with no `parse_mode`, so scraped `*` or `<`
  cannot break the message. Capped at 15 change lines and Telegram's 4096 characters. Skipped when
  either `SCRAPE_PIPELINE_TELEGRAM_*` var is unset.

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
reporting success this checks: any page that failed to load, zero items extracted, item count
below `minItemsExpected`, any field at 0% fill, and any field whose fill rate dropped more than 50
points versus the previous run (selector drift). Any of those fails the run.

**An unhealthy run writes nothing but a `Failed` row to the Runs tab.** It does not overwrite the
local snapshot or the sheet's Items / Changes. Otherwise a partial crawl logs every missing item as
"Removed", and the next healthy run after a selector break logs every field as "Updated". A failed
Sheets export also exits `1`.

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

## Google Sheet (output destination)

**"Scrape Pipeline — Data Feed"** — ID `1IRCSdaUuFZKBOvFb3qUEo_snI_PP89MkZhrNpmrdIgk`
(https://docs.google.com/spreadsheets/d/1IRCSdaUuFZKBOvFb3qUEo_snI_PP89MkZhrNpmrdIgk/edit).
Created 2026-09-17 with the `gws` CLI, timezone Asia/Karachi. **The Sheets export must write to
this sheet and these columns — do not create a new sheet.**

Written by the service account `scrape-pipeline@invoice-472509.iam.gserviceaccount.com`. It lives in
GCP project **`invoice-472509`**, not `tariq-aios`, and the Google Sheets API is enabled there. It is
shared on the sheet as **Editor**; without that share every write fails with
`403: The caller does not have permission`. The date serials in `sheets.ts` assume the sheet's
UTC+5 timezone — change `SHEET_UTC_OFFSET_HOURS` if the sheet's timezone ever changes.

| Tab | Columns | Behavior |
|---|---|---|
| **Items** | Title · Price · Availability · Target · Scraped At | Current dataset, one row per item. Price is a number shown as £; Scraped At is a date serial. Filter on the header. |
| **Changes** | Detected At · Target · Change · Item · Field · Before · After | Append-only change log. Color rules match the exact words `New` / `Removed` / `Updated`. |
| **Runs** | Run At · Target · Items · New · Removed · Updated · Fill Rates · Health · Notes | One row per run. Color rules match `Passed` / `Failed`. |

Seeded with the 2026-09-17 19:40 baseline snapshot (60 books, health Passed). **Changes is empty on
purpose:** no real change has happened yet, and the faked diff used to test change detection was
never written to the sheet. Keep it that way — portfolio screenshots only show real data.

Write scraped values with `valueInputOption: RAW`. `USER_ENTERED` would execute a scraped value
that starts with `=` as a formula.

## Status

**Scrape → diff → Google Sheet working, verified end to end (2026-09-17).** The demo target pulls
60 items across 3 pages, diffs against the previous snapshot, fails correctly on a broken selector,
and each run writes itself into the sheet. Verified by reading the sheet back through a separate
identity: Items refreshed, a Passed row on Runs, Changes empty because nothing changed.

**Telegram alert built, not yet sent for real (2026-09-17).** The message text is checked offline;
the bot token is in `.env`, but `SCRAPE_PIPELINE_TELEGRAM_CHAT_ID` is still blank and no message has
gone through, because Telegram is blocked on the local network (see Env vars).

Not built yet, in rough priority order: scheduling on a host that can reach Telegram, a second
target on a real live site (SEC EDGAR), and the Upwork portfolio card.

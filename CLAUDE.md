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
`SCRAPE_PIPELINE_SHEET_ID`, `SCRAPE_PIPELINE_SLACK_WEBHOOK_URL`. Google Sheets access is a service
account, not an API key: an API key can only read public sheets and cannot write.

**Alerts go to Slack, not Telegram (switched 2026-09-18).** Telegram was dropped partly because
`api.telegram.org` is blocked on Tariq's local network (TLS handshake reset), so it could never be
tested from this PC. Slack's `hooks.slack.com` is reachable here. The old `SCRAPE_PIPELINE_TELEGRAM_*`
lines may still sit in `.env`; nothing reads them.

The original JSON key file is kept **outside the repo** at `~/.config/scrape-pipeline/service-account.json`.
Never place a key file inside the project. Google's default name (`<project-id>-<12 hex>.json`) is now
covered by a `.gitignore` rule (added 2026-09-19, after a key was saved into the project folder), but
the file still belongs in `~/.config`.

## Commands

```bash
npm start                          # run the books.toscrape.com demo target
npm run run -- targets/<name>.json # run any other target
npm run typecheck                  # tsc --noEmit (types only; nothing is emitted)
npm test                           # node --test, currently just sheets.test.ts (normalizePrivateKey)
npm run dev:trigger                # Trigger.dev dev server: runs tasks locally against the dev environment
```

Exit code is `0` when the run is healthy and `1` when a health check, the Sheets export, or the
Slack alert fails, so cron or CI catches a broken scrape instead of logging success over empty data.

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
- **`src/store.ts`** — the keyed diff, plus the local snapshot file `data/<target>.json`, used only
  when the Google vars are unset (with them, the snapshot lives in the sheet). A snapshot
  is `{ target, runAt, itemCount, fillRates, items }`; `diff()` maps both item lists by `key` and
  compares by `JSON.stringify` equality, so field order inside an item never causes a false change.
- **`src/pipeline.ts`** — `runPipeline(target)`: one full run (crawl, health checks, snapshot, Sheets,
  Slack). Returns `{ ok, failures, ... }` and never exits the process, so both entry points share it.
- **`src/index.ts`** — CLI entry point: loads `.env`, reads the target file, exits `1` when the run fails.
- **`src/trigger/scrape.ts`** — Trigger.dev task `scrape-books-demo`. Imports `targets/books.json` into
  the bundle (no file read at runtime) and throws on failure so the run shows Failed. It also throws
  before crawling when any of the four `SCRAPE_PIPELINE_*` vars is missing: unlike the CLI, a cloud run
  has no disk to fall back to, so it would otherwise pass green while writing nothing. `retry.maxAttempts`
  is `1` on purpose: a retry would append a second Runs row and send the Slack alert twice.
- **`src/sheets.ts`** — Google Sheets export through a service account. It signs its own JWT with
  `node:crypto` and calls the Sheets REST API with `fetch`, so there is no Google client library.
  Skipped with a log line when the `SCRAPE_PIPELINE_*` vars are not set. Also `loadSnapshot()` /
  `saveSnapshot()` for the hidden Snapshot tab (see Google Sheet).
- **`src/slack.ts`** — the "what changed" alert, posted to a Slack incoming webhook. `digest()` returns
  the message text, or `null` for a quiet healthy run or a baseline, so the channel only hears about it
  when something changed, the health check failed, or the Sheets export failed. Sent with
  `mrkdwn: false` and `&` `<` `>` escaped, so a scraped `<!channel>` or `<url|text>` cannot ping the
  channel or fake a link. Capped at 15 change lines and 4096 characters. Errors carry Slack's reason
  (`no_service`, `invalid_payload`) but never the webhook URL, which is the secret. Skipped when
  `SCRAPE_PIPELINE_SLACK_WEBHOOK_URL` is unset.

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
snapshot or the sheet's Items / Changes. Otherwise a partial crawl logs every missing item as
"Removed", and the next healthy run after a selector break logs every field as "Updated". A failed
Sheets export also exits `1`.

**The snapshot only advances after the Sheets export succeeds.** A failed export leaves the old
snapshot, so the next run reports those changes again (possibly a duplicate Changes row) rather than
never reporting them. **A snapshot that cannot be loaded fails the run before crawling**; treating it
as a first run would silently swallow every change since the last good run.

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
- Keep dependencies minimal. Current set: `cheerio`, `zod`, `robots-parser`, `@trigger.dev/sdk`. Node's
  built-in `fetch` covers HTTP.

## Trigger.dev

Project **"Upwork Trigger"** (`proj_rozkxmfiedxeuvegkfph`, org Smart AI Workspace), runtime `node-24`.
The GitHub repo is connected in the dashboard: **every push to `main` deploys to Production.**

- `@trigger.dev/sdk`, `@trigger.dev/build` and `trigger.dev` are pinned to the **exact same version**
  (no `^`). Without a TTY the CLI treats the run as CI and aborts on any version mismatch.
- `.env` is not deployed. Production needs the four `SCRAPE_PIPELINE_*` vars set separately; without
  them the task fails before crawling. Check with `npx trigger.dev env list --env prod` (names only).
  Prefer `npx trigger.dev env set --env prod --secret -- <NAME> <value>` over the dashboard's bulk paste.
  The `--` is required for the private key: a value starting with `-----BEGIN` is otherwise parsed as an
  unknown option, and the CLI's error message echoes the whole value back.
- **The private key's line breaks do not always survive that dashboard.** A first Production test
  failed with `error:1E08010C:DECODER routines::unsupported` from `Sign.sign` — the multi-line PEM was
  mangled by the dashboard's "paste all your .env values at once" bulk import. A later Production run
  hit the same error again with the line breaks collapsed away entirely (no `\n` left in any form),
  a shape the first fix didn't cover since it only replaced known escape patterns. `normalizePrivateKey()`
  in `sheets.ts` no longer pattern-matches paste shapes: it pulls the base64 body out from between the
  `BEGIN`/`END` markers and rebuilds a standard PEM, so any whitespace damage — quotes, CRLF, `\n`
  escapes, or line breaks gone entirely — is irrelevant. Checked in `sheets.test.ts` (`npm test`) by
  re-signing and verifying against a real key pair for each mangled shape, not just that parsing doesn't
  throw.
- The bundler warns `Unrecognized target environment "es2024"` from `tsconfig.json`. Harmless.
- `npm audit` flags packages inside Trigger.dev itself; the only offered "fix" downgrades to v1/v2.
  Do not run `npm audit fix --force`.
- **Local files do not survive.** Code is bundled into `.trigger/tmp/build-*/` (so an
  `import.meta.dirname`-relative path lands in a throwaway build folder), and cloud runs keep no files
  at all. That is why the snapshot lives in the sheet's Snapshot tab. Never reintroduce run state on
  local disk.

## Known workaround

`robots-parser@3.0.1` ships a broken `index.d.ts` (a shorthand `declare module` shadows its real
export, so the module types as non-callable). `src/fetch.ts` restates the runtime signature and
casts. Remove that cast if upstream fixes the typings.

## Google Sheet (output destination)

**"Scrape Pipeline — Data Feed"** — ID `1IRCSdaUuFZKBOvFb3qUEo_snI_PP89MkZhrNpmrdIgk`
(https://docs.google.com/spreadsheets/d/1IRCSdaUuFZKBOvFb3qUEo_snI_PP89MkZhrNpmrdIgk/edit).
Created 2026-09-17 with the `gws` CLI, timezone Asia/Karachi. **The Sheets export must write to
this sheet and these columns — do not create a new sheet.**

Written by the service account `scrape-pipeline@scrape-pipeline-509110.iam.gserviceaccount.com`. It lives
in its own GCP project **`scrape-pipeline-509110`** (created 2026-09-19), with only the Google Sheets API
enabled and no project roles. It is shared on the sheet as **Editor**; without that share every write fails with
`403: The caller does not have permission`. The date serials in `sheets.ts` assume the sheet's
UTC+5 timezone — change `SHEET_UTC_OFFSET_HOURS` if the sheet's timezone ever changes.

**Moved from `invoice-472509` on 2026-09-19.** The old account `scrape-pipeline@invoice-472509` had its
key partly printed to a terminal and chat by a setup script, so the pipeline got its own project and a
new account. The old account's share on the sheet was removed the same day; the account itself is to be
deleted in the `invoice-472509` console.

| Tab | Columns | Behavior |
|---|---|---|
| **Items** | Title · Price · Availability · Target · Scraped At | Current dataset, one row per item. Price is a number shown as £; Scraped At is a date serial. Filter on the header. |
| **Changes** | Detected At · Target · Change · Item · Field · Before · After | Append-only change log. Color rules match the exact words `New` / `Removed` / `Updated`. |
| **Runs** | Run At · Target · Items · New · Removed · Updated · Fill Rates · Health · Notes | One row per run. Color rules match `Passed` / `Failed`. |
| **Snapshot** *(hidden)* | Column A only: A1 = `{ target, runAt, itemCount, fillRates }` as JSON, A2 down = one item per row as JSON | The last good run the next run diffs against. Written in one `values:batchUpdate`; reads stop at `itemCount`, so leftover rows never count. One sheet serves one target: a different target name in A1 fails the run. Created and seeded 2026-09-17 from the 21:18 run, after checking it matched Items and the latest Runs row. |

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

**Slack alert working (2026-09-18).** Replaced the Telegram alert. The message text, the escaping,
and the error path are checked offline against a local fake webhook, and a test message through
`sendMessage` reached the real channel (HTTP 200). The webhook belongs to Tariq's existing Slack app
(Smart AI Workspace, app ID `A0ASA67NYAF`) with Incoming Webhooks switched on. No change alert has fired
yet: books.toscrape.com never changes.

**Snapshot moved into the sheet, verified (2026-09-17).** With `data/` moved aside, `npm start` still
reported 0 changes (not "first run") and saved the snapshot back to the Snapshot tab.

**Trigger.dev dev run verified (2026-09-18).** A dashboard Test run (`run_06gb85aa4clstqjbjdicuflc01`)
succeeded in 12s: 60 items, 0 changes, a Passed row on Runs at 15:35, and the Snapshot tab advanced.
`trigger dev` loads the project `.env` into local runs on its own. A Development run only executes while
`npm run dev:trigger` is running on this PC; otherwise it waits as Queued.

**First Production run, 2026-09-19 (`run_06gbib2a9sbf4inpn7ehln2te1`): Completed, but wrote nothing.**
`env list --env prod` showed none of the `SCRAPE_PIPELINE_*` vars, so it logged "sheet: skipped" and
"slack: skipped", saved its snapshot to `/app/src/data/` (discarded), and still returned `ok: true`. The
task now fails in that case.

**Production run verified (2026-09-19).** After the four vars were set with `env set` (new service account
in `scrape-pipeline-509110`), `run_06gbiil3tmst8bohc8t7msaje1` at 15:51 read the snapshot from the sheet
(0 changes, not a first run), refreshed Items, wrote a Passed Runs row, and advanced the Snapshot tab.
Checked by reading all three tabs back through `gws`.

Not built yet, in rough priority order: a schedule on
the task, a second target on a real live site (SEC
EDGAR), and the Upwork portfolio card.

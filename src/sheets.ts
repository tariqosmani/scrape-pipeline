import { createSign } from "node:crypto";
import type { Item } from "./extract.ts";
import type { Diff } from "./store.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
// Must match the spreadsheet's timezone (Asia/Karachi, UTC+5, no DST) or run times shift.
const SHEET_UTC_OFFSET_HOURS = 5;

export type SheetsConfig = { email: string; privateKey: string; sheetId: string };

export type RunRecord = {
  target: string;
  runAt: string;
  key: string;
  fieldNames: string[];
  items: Item[];
  fillRates: Record<string, number>;
  isBaseline: boolean;
  changes: Diff;
  problems: string[];
};

type Cell = string | number;

export function sheetsConfigFromEnv(): SheetsConfig | null {
  const email = process.env.SCRAPE_PIPELINE_SERVICE_ACCOUNT_EMAIL?.trim();
  // .env stores the PEM on one line with literal \n escapes; restore real newlines.
  const privateKey = process.env.SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const sheetId = process.env.SCRAPE_PIPELINE_SHEET_ID?.trim();
  if (!email || !privateKey || !sheetId) return null;
  return { email, privateKey, sheetId };
}

/** Healthy run: replace Items, append Changes and Runs. Unhealthy run: append Runs only, so bad data never reaches the sheet. */
export async function pushRun(config: SheetsConfig, run: RunRecord): Promise<void> {
  const call = await client(config);
  const at = dateSerial(run.runAt);
  const healthy = run.problems.length === 0;

  if (healthy) {
    await call("POST", "/values:batchClear", { ranges: ["Items!A2:Z"] });
    if (run.items.length > 0) {
      await call("POST", "/values:batchUpdate", {
        valueInputOption: "RAW",
        data: [{ range: "Items!A2", values: run.items.map((item) => itemRow(item, run, at)) }],
      });
    }
    const changes = run.isBaseline ? [] : changeRows(run, at);
    if (changes.length > 0) await append(call, "Changes!A1", changes);
  }

  await append(call, "Runs!A1", [runRow(run, at, healthy)]);
}

export function itemRow(item: Item, run: RunRecord, at: number): Cell[] {
  return [...run.fieldNames.map((field) => toCell(item[field] ?? "")), run.target, at];
}

export function changeRows(run: RunRecord, at: number): Cell[][] {
  const rows: Cell[][] = [];
  for (const item of run.changes.added) rows.push([at, run.target, "New", item[run.key] ?? "", "", "", ""]);
  for (const item of run.changes.removed) rows.push([at, run.target, "Removed", item[run.key] ?? "", "", "", ""]);
  for (const { key, before, after } of run.changes.changed) {
    for (const field of run.fieldNames) {
      if (before[field] !== after[field]) {
        rows.push([at, run.target, "Updated", key, field, before[field] ?? "", after[field] ?? ""]);
      }
    }
  }
  return rows;
}

function runRow(run: RunRecord, at: number, healthy: boolean): Cell[] {
  const fill = run.fieldNames.map((f) => `${f} ${Math.round((run.fillRates[f] ?? 0) * 100)}%`).join(", ");
  const counts: Cell[] = healthy && !run.isBaseline
    ? [run.changes.added.length, run.changes.removed.length, run.changes.changed.length]
    : ["", "", ""];
  const notes = !healthy
    ? run.problems.join("; ")
    : run.isBaseline ? "Baseline snapshot. Change tracking starts from the next run." : "";
  return [at, run.target, run.items.length, ...counts, fill, healthy ? "Passed" : "Failed", notes];
}

// A price-like string becomes a number so the sheet can sort and format it; everything else stays text.
function toCell(value: string): Cell {
  return /^[£$€]\s?\d[\d,]*(\.\d+)?$/.test(value) ? Number(value.replace(/[^\d.]/g, "")) : value;
}

function dateSerial(iso: string): number {
  return (Date.parse(iso) + SHEET_UTC_OFFSET_HOURS * 3_600_000) / 86_400_000 + 25569;
}

type Call = (method: string, path: string, body: unknown) => Promise<unknown>;

// RAW input: a scraped value starting with "=" must land as text, never run as a formula.
function append(call: Call, range: string, values: Cell[][]): Promise<unknown> {
  const query = "valueInputOption=RAW&insertDataOption=OVERWRITE";
  return call("POST", `/values/${encodeURIComponent(range)}:append?${query}`, { values });
}

async function client(config: SheetsConfig): Promise<Call> {
  const token = await accessToken(config);
  return async (method, path, body) => {
    const res = await fetch(`${SHEETS_API}/${config.sheetId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) throw new Error(`Sheets ${path} → ${res.status}: ${json.error?.message ?? "unknown error"}`);
    return json;
  };
}

async function accessToken({ email, privateKey }: SheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json.access_token;
}

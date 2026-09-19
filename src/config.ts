import { readFile } from "node:fs/promises";
import { z } from "zod";

const fieldSchema = z.object({
  // Omitted: the value comes from the item element itself, e.g. an attribute on it.
  selector: z.string().optional(),
  attr: z.string().optional(),
});

export const targetSchema = z.object({
  // Lands in a file name and a sheet tab name, so it stays plain.
  name: z.string().regex(/^[a-z0-9-]+$/, "use lowercase letters, digits and hyphens"),
  // The sheet tab listing this target's current items. Defaults to the name.
  sheetTab: z.string().optional(),
  startUrl: z.url(),
  // "xml" for feeds such as the ECB's daily rates: tag names are case-sensitive there.
  format: z.enum(["html", "xml"]).default("html"),
  maxPages: z.number().int().positive().default(1),
  requestDelayMs: z.number().int().min(0).default(1000),
  userAgent: z.string(),
  itemSelector: z.string(),
  fields: z.record(z.string(), fieldSchema),
  key: z.string(),
  nextPageSelector: z.string().optional(),
  minItemsExpected: z.number().int().min(0).default(1),
});

export type Target = z.infer<typeof targetSchema>;

export async function loadTarget(path: string): Promise<Target> {
  return parseTarget(JSON.parse(await readFile(path, "utf8")), path);
}

/** Validates an already-loaded target, e.g. one a Trigger.dev task imports into its bundle. */
export function parseTarget(raw: unknown, source: string): Target {
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid target config ${source}:\n${z.prettifyError(parsed.error)}`);
  }
  if (!(parsed.data.key in parsed.data.fields)) {
    throw new Error(`Target "${parsed.data.name}": key "${parsed.data.key}" is not one of the configured fields.`);
  }
  return parsed.data;
}

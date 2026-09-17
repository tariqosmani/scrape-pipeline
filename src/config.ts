import { readFile } from "node:fs/promises";
import { z } from "zod";

const fieldSchema = z.object({
  selector: z.string(),
  attr: z.string().optional(),
});

export const targetSchema = z.object({
  name: z.string(),
  startUrl: z.url(),
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
  const parsed = targetSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid target config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  if (!(parsed.data.key in parsed.data.fields)) {
    throw new Error(`Target "${parsed.data.name}": key "${parsed.data.key}" is not one of the configured fields.`);
  }
  return parsed.data;
}

import robotsParserModule from "robots-parser";

// robots-parser 3.0.1 ships a broken index.d.ts: a shorthand `declare module` shadows its real
// export, so the module resolves as non-callable. Its runtime signature is restated here.
type Robots = {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};
const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => Robots;

const robotsCache = new Map<string, Robots | null>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// An unreachable or 4xx robots.txt means "allowed" per RFC 9309, so null is a valid cached result.
async function getRobots(origin: string, userAgent: string): Promise<Robots | null> {
  const cached = robotsCache.get(origin);
  if (cached !== undefined) return cached;

  const robotsUrl = `${origin}/robots.txt`;
  let parsed: Robots | null = null;
  try {
    const res = await fetch(robotsUrl, { headers: { "user-agent": userAgent } });
    if (res.ok) parsed = robotsParser(robotsUrl, await res.text());
  } catch {
    parsed = null;
  }
  robotsCache.set(origin, parsed);
  return parsed;
}

export async function isAllowed(url: string, userAgent: string): Promise<boolean> {
  const robots = await getRobots(new URL(url).origin, userAgent);
  return robots?.isAllowed(url, userAgent) ?? true;
}

export async function crawlDelayMs(url: string, userAgent: string, fallbackMs: number): Promise<number> {
  const robots = await getRobots(new URL(url).origin, userAgent);
  const declared = robots?.getCrawlDelay(userAgent);
  return declared === undefined ? fallbackMs : Math.max(declared * 1000, fallbackMs);
}

export async function politeFetch(url: string, userAgent: string, attempts = 3): Promise<string> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": userAgent } });
    if (res.ok) return res.text();

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === attempts) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
    console.warn(`  ${res.status} on ${url}, retrying in ${backoffMs}ms (attempt ${attempt}/${attempts})`);
    await sleep(backoffMs);
  }
  throw new Error(`GET ${url} failed after ${attempts} attempts`);
}

export { sleep };

const USER_AGENT = 'earth-data-mcp/1.0 (+https://github.com/fablackner/earth-data-mcp)';

// Upstream feeds are public and rate-limited; a small TTL cache keeps repeated
// agent calls (which tend to re-ask the same question) off the origin.
const cache = new Map();

/** Thrown when an upstream feed fails in a way the caller should report, not retry. */
export class UpstreamError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  // Bounded so a long-running server can't grow without limit.
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

/**
 * Fetch with a timeout, one retry on 5xx/network failure, and a TTL cache.
 * Retries are deliberately shallow — USGS returning 503 twice in a row is a
 * real outage, and reporting it beats hammering the origin.
 */
export async function fetchText(url, { ttlMs = 300_000, timeoutMs = 10_000 } = {}) {
  const cached = cacheGet(url);
  if (cached !== null) return cached;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 4xx is our fault (bad query) — surface it immediately, don't retry.
      if (res.status >= 400 && res.status < 500) {
        throw new UpstreamError(`${url} rejected the query (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      if (!res.ok) {
        lastError = new UpstreamError(`${url} responded with ${res.status}`, {
          status: res.status,
        });
        continue;
      }
      const text = await res.text();
      cacheSet(url, text, ttlMs);
      return text;
    } catch (error) {
      if (error instanceof UpstreamError && error.status < 500) throw error;
      lastError = error;
    }
  }
  throw new UpstreamError(`could not reach ${url}: ${lastError?.message ?? 'unknown error'}`);
}

/** As `fetchText`, but parses JSON and reports malformed payloads as upstream errors. */
export async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`${url} returned a malformed JSON payload`);
  }
}

// Lightweight rate limiting stored in D1. Good enough for a first
// deployment; for high-traffic production use, move this to a
// Durable Object or Workers KV with a sliding-window algorithm instead
// of a per-request table scan.

async function hashIp(ip) {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Checks and records a request against per-minute limits.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export async function checkRateLimit(db, request, quantity, limits) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await hashIp(ip);

  // Compute the window boundary with SQLite's own datetime() rather than a
  // JS-formatted ISO string: created_at is stored via datetime('now') too,
  // and comparing two differently-formatted timestamp strings (ISO with
  // "T"/milliseconds vs SQLite's "YYYY-MM-DD HH:MM:SS") does not sort
  // reliably. Keeping both sides in SQLite's format avoids that mismatch.
  const { results } = await db
    .prepare(
      `SELECT COUNT(*) as request_count, COALESCE(SUM(quantity), 0) as code_count
       FROM rate_limit_log
       WHERE ip_hash = ? AND created_at >= datetime('now', '-60 seconds')`
    )
    .bind(ipHash)
    .all();

  const { request_count, code_count } = results[0];

  if (request_count >= limits.maxRequestsPerMinute) {
    return {
      ok: false,
      error: "Too many requests. Please wait a moment and try again.",
    };
  }

  if (code_count + quantity > limits.maxCodesPerMinute) {
    return {
      ok: false,
      error:
        "Too many codes requested in a short period. Please wait a moment and try again.",
    };
  }

  await db
    .prepare(
      `INSERT INTO rate_limit_log (ip_hash, quantity) VALUES (?, ?)`
    )
    .bind(ipHash, quantity)
    .run();

  return { ok: true };
}

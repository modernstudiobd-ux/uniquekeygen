// Cryptographically secure candidate generation.
//
// Never uses Math.random(). Uses crypto.getRandomValues (available as a
// standard Web Crypto API in the Workers runtime) with rejection sampling
// so that character selection has no modulo bias, even when charset.length
// doesn't evenly divide 256.

/**
 * Return a single unbiased random index in [0, max).
 */
function randomIndex(max) {
  if (max <= 0) throw new Error("randomIndex: max must be > 0");
  if (max > 256) {
    // Fallback for large charsets: use a 32-bit unbiased draw.
    const limit = Math.floor(0xffffffff / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  }

  // Rejection sampling over a single byte to avoid modulo bias.
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

/**
 * Generate one candidate code string from a template (see pattern.js)
 * and a resolved charset string.
 */
export function generateCandidate(tokens, charset) {
  let out = "";
  for (const t of tokens) {
    if (t.random) {
      out += charset[randomIndex(charset.length)];
    } else {
      out += t.literal;
    }
  }
  return out;
}

/**
 * Generate `n` distinct-within-this-batch candidates. Distinctness within
 * a batch is just an optimization (avoids wasting an INSERT OR IGNORE on
 * an obvious in-batch dupe) — the real uniqueness guarantee is always the
 * D1 UNIQUE constraint, never this Set.
 */
export function generateCandidateBatch(tokens, charset, n) {
  const seen = new Set();
  let guard = 0;
  const maxGuard = n * 50 + 1000; // avoid pathological infinite loop on tiny spaces
  while (seen.size < n && guard < maxGuard) {
    seen.add(generateCandidate(tokens, charset));
    guard++;
  }
  return [...seen];
}

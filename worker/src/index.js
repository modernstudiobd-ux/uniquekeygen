import { resolveCharset } from "./charset.js";
import { buildTemplate, templateToLikePattern } from "./pattern.js";
import { generateCandidateBatch } from "./random.js";
import { checkRateLimit } from "./rateLimit.js";

const BATCH_SIZE = 100; // codes attempted per D1 batch round-trip
const MAX_ROUNDS_MULTIPLIER = 20; // safety cap on total insert attempts

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

function errorResponse(message, status, env) {
  return json({ error: message }, status, env);
}

// Computes charset.length ^ randomPositions, capped so we never try to
// build an astronomically large BigInt for huge patterns. Above the cap
// we treat the space as "effectively unbounded" for the purposes of the
// pre-flight capacity check (the per-request retry cap still protects
// against pathological cases at generation time).
const CAPACITY_CAP = 10n ** 15n;

function computeCapacity(charsetSize, randomPositions) {
  let capacity = 1n;
  const base = BigInt(charsetSize);
  for (let i = 0; i < randomPositions; i++) {
    capacity *= base;
    if (capacity > CAPACITY_CAP) return { value: CAPACITY_CAP, uncapped: true };
  }
  return { value: capacity, uncapped: false };
}

async function estimateExistingForShape(db, tokens) {
  const likePattern = templateToLikePattern(tokens);
  const { results } = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM generated_codes WHERE code LIKE ? ESCAPE '\\'`
    )
    .bind(likePattern)
    .all();
  return BigInt(results[0].cnt);
}

async function reserveCodes(db, tokens, charset, quantity, requestId, patternDesc) {
  const reserved = [];
  let totalAttempts = 0;
  const maxAttempts = quantity * MAX_ROUNDS_MULTIPLIER + BATCH_SIZE;

  while (reserved.length < quantity && totalAttempts < maxAttempts) {
    const remaining = quantity - reserved.length;
    // Never generate more candidates than we still need: every candidate we
    // attempt to insert that succeeds becomes a PERMANENT reservation, even
    // if we then have no use for it. Capping at `remaining` (not padding it)
    // is what keeps "requested 6, got 6" true instead of quietly burning
    // extra slots from the combination space.
    const roundSize = Math.min(BATCH_SIZE, remaining);
    const candidates = generateCandidateBatch(tokens, charset, roundSize);

    const stmts = candidates.map((code) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO generated_codes (code, request_id, pattern) VALUES (?, ?, ?)`
        )
        .bind(code, requestId, patternDesc)
    );

    const results = await db.batch(stmts);

    for (let i = 0; i < results.length && reserved.length < quantity; i++) {
      const r = results[i];
      if (r.meta && r.meta.changes === 1) {
        reserved.push(candidates[i]);
      }
    }

    totalAttempts += candidates.length;
  }

  return reserved;
}

export { computeCapacity, estimateExistingForShape, reserveCodes };

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Malformed request body.", 400, env);
  }

  const {
    quantity,
    length,
    prefix = "",
    postfix = "",
    pattern = "",
    charsetPreset,
    customCharset = "",
    excludeConfusing = false,
  } = body || {};

  // --- Validate quantity -------------------------------------------------
  const qty = Number(quantity);
  const maxQty = Number(env.MAX_QUANTITY_PER_REQUEST || 10000);
  if (!Number.isInteger(qty) || qty < 1) {
    return errorResponse("Please enter a valid number of codes.", 400, env);
  }
  if (qty > maxQty) {
    return errorResponse(
      `Please request at most ${maxQty} codes per request.`,
      400,
      env
    );
  }

  // --- Rate limiting -------------------------------------------------
  const rl = await checkRateLimit(env.DB, request, qty, {
    maxRequestsPerMinute: Number(env.MAX_REQUESTS_PER_MINUTE || 30),
    maxCodesPerMinute: Number(env.MAX_CODES_PER_MINUTE || 20000),
  });
  if (!rl.ok) {
    return errorResponse(rl.error, 429, env);
  }

  // --- Validate charset -------------------------------------------------
  const charsetResult = resolveCharset({
    preset: charsetPreset,
    custom: customCharset,
    excludeConfusing,
  });
  if (!charsetResult.ok) {
    return errorResponse(charsetResult.error, 400, env);
  }
  const charset = charsetResult.charset;

  // --- Validate length (bounds check even when a pattern is used, since
  //     prefix/postfix + pattern length together must stay sane) --------
  const maxLen = Number(env.MAX_CODE_LENGTH || 128);
  if (!pattern && (!Number.isInteger(Number(length)) || Number(length) < 1)) {
    return errorResponse("Please enter a valid code length.", 400, env);
  }

  // --- Build template (prefix + pattern/length + postfix) ---------------
  const templateResult = buildTemplate({ prefix, postfix, pattern, length });
  if (!templateResult.ok) {
    return errorResponse(templateResult.error, 400, env);
  }
  const { tokens, randomPositions } = templateResult;

  if (tokens.length > maxLen) {
    return errorResponse(
      `Codes must be at most ${maxLen} characters long.`,
      400,
      env
    );
  }

  // --- Capacity check -----------------------------------------------
  const { value: capacity, uncapped } = computeCapacity(
    charset.length,
    randomPositions
  );

  if (!uncapped) {
    const existing = await estimateExistingForShape(env.DB, tokens);
    const remaining = capacity - existing;
    if (remaining < BigInt(qty)) {
      return errorResponse(
        "There are not enough unique combinations available for this configuration.",
        409,
        env
      );
    }
  }
  // When uncapped (space > 10^15), we trust the per-request retry cap in
  // reserveCodes() to fail gracefully rather than loop forever, since an
  // exact remaining-count query would be prohibitively expensive.

  // --- Generate + atomically reserve -------------------------------------
  const requestId = crypto.randomUUID();
  const patternDesc = pattern || `prefix:${prefix}|len:${length}|postfix:${postfix}`;

  const reserved = await reserveCodes(
    env.DB,
    tokens,
    charset,
    qty,
    requestId,
    patternDesc
  );

  if (reserved.length < qty) {
    // We ran out of retry budget before reserving the full quantity —
    // almost certainly means the space is nearly exhausted despite the
    // pre-flight estimate (e.g. heavy concurrent contention). Return what
    // we got reserved (they ARE validly, permanently reserved) plus an
    // error so the client knows the batch was partial.
    return json(
      {
        error:
          "Not enough unique combinations could be reserved for this configuration. Some codes were generated; request fewer codes or broaden the character set.",
        codes: reserved,
        requestId,
      },
      206,
      env
    );
  }

  return json({ codes: reserved, requestId, quantity: reserved.length }, 200, env);
}

async function handleHealth(env) {
  try {
    await env.DB.prepare("SELECT 1").first();
    return json({ status: "ok" }, 200, env);
  } catch (err) {
    return json({ status: "error", detail: String(err) }, 500, env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === "/api/generate" && request.method === "POST") {
        return await handleGenerate(request, env);
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return await handleHealth(env);
      }

      return errorResponse("Not found.", 404, env);
    } catch (err) {
      console.error("Unhandled worker error:", err);
      return errorResponse(
        "Unable to generate codes right now. Please try again.",
        500,
        env
      );
    }
  },
};

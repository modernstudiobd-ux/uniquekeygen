import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createMockD1WithSchema } from "./mockD1.js";
import { resolveCharset } from "../src/charset.js";
import { buildTemplate, templateToLikePattern } from "../src/pattern.js";
import { generateCandidate, generateCandidateBatch } from "../src/random.js";
import { reserveCodes, computeCapacity, estimateExistingForShape } from "../src/index.js";
import { checkRateLimit } from "../src/rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(
  path.join(__dirname, "../migrations/0001_initial.sql"),
  "utf8"
);

let passCount = 0;
let failCount = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err.message}`);
  }
}

function freshDb() {
  return createMockD1WithSchema(SCHEMA);
}

async function run() {
  console.log("\n== Character sets ==");

  await test("dedupes custom charset", () => {
    const r = resolveCharset({ custom: "AABBCC" });
    assert.equal(r.ok, true);
    assert.equal(r.charset, "ABC");
  });

  await test("rejects empty charset", () => {
    const r = resolveCharset({ custom: "" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Please select at least one character.");
  });

  await test("excludes confusing characters", () => {
    const r = resolveCharset({ preset: "upperNumbers", excludeConfusing: true });
    assert.equal(r.ok, true);
    for (const ch of ["O", "0", "I", "1", "L"]) {
      assert.ok(!r.charset.includes(ch), `charset should not include ${ch}`);
    }
  });

  await test("all presets resolve to non-empty sets", () => {
    for (const preset of ["numbers", "upper", "lower", "upperNumbers", "lowerNumbers", "upperLowerNumbers"]) {
      const r = resolveCharset({ preset });
      assert.equal(r.ok, true, `preset ${preset} should resolve`);
      assert.ok(r.charset.length > 0);
    }
  });

  await test("unknown preset is rejected", () => {
    const r = resolveCharset({ preset: "not-a-real-preset" });
    assert.equal(r.ok, false);
  });

  console.log("\n== Pattern / template building ==");

  await test("length-based template with prefix/postfix", () => {
    const r = buildTemplate({ prefix: "KMP", postfix: "2026", pattern: "", length: 4 });
    assert.equal(r.ok, true);
    assert.equal(r.randomPositions, 4);
    assert.equal(r.tokens.length, 3 + 4 + 4);
  });

  await test("pattern preserves literal separators, prefix and postfix don't count as random", () => {
    const r = buildTemplate({ prefix: "KMP-", postfix: "-2026", pattern: "####-####", length: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.randomPositions, 8);
    const literalCount = r.tokens.filter((t) => t.literal).length;
    // "KMP-" (4) + "-2026" (5) + the literal "-" inside the pattern (1) = 10
    assert.equal(literalCount, 10);
  });

  await test("pattern without # is rejected", () => {
    const r = buildTemplate({ prefix: "", postfix: "", pattern: "----", length: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /valid pattern/);
  });

  await test("invalid length without pattern is rejected", () => {
    const r = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /valid code length/);
  });

  await test("templateToLikePattern turns random slots into wildcards", () => {
    const r = buildTemplate({ prefix: "AB", postfix: "", pattern: "##-##", length: 0 });
    const like = templateToLikePattern(r.tokens);
    assert.equal(like, "AB__-__");
  });

  console.log("\n== Cryptographic randomness ==");

  await test("generateCandidate only uses charset characters and matches template shape", () => {
    const t = buildTemplate({ prefix: "X", postfix: "Y", pattern: "##-##", length: 0 });
    const candidate = generateCandidate(t.tokens, "ABC123");
    assert.equal(candidate.length, t.tokens.length);
    assert.ok(candidate.startsWith("X"));
    assert.ok(candidate.endsWith("Y"));
    assert.equal(candidate[3], "-"); // tokens: X # # - # # Y
  });

  await test("random character selection is unbiased across a large sample (chi-square)", () => {
    // 4-character charset, sample many draws, check rough uniformity.
    const charset = "ABCD";
    const t = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 1 });
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    const N = 40000;
    for (let i = 0; i < N; i++) {
      const c = generateCandidate(t.tokens, charset);
      counts[c]++;
    }
    const expected = N / 4;
    let chiSq = 0;
    for (const k of Object.keys(counts)) {
      chiSq += (counts[k] - expected) ** 2 / expected;
    }
    // Critical value for df=3 at p=0.001 is ~16.27 — this is a very
    // generous bound to avoid flaky failures while still catching real bias.
    assert.ok(chiSq < 16.27, `chi-square too high: ${chiSq} (counts: ${JSON.stringify(counts)})`);
  });

  await test("generateCandidateBatch produces the requested count when space allows", () => {
    const t = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 4 });
    const batch = generateCandidateBatch(t.tokens, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 50);
    assert.equal(batch.length, 50);
    assert.equal(new Set(batch).size, 50); // all distinct within batch
  });

  console.log("\n== Capacity calculation ==");

  await test("computeCapacity matches charset^positions for small spaces", () => {
    const { value, uncapped } = computeCapacity(36, 4);
    assert.equal(uncapped, false);
    assert.equal(value, 36n ** 4n);
    assert.equal(value, 1679616n);
  });

  await test("computeCapacity caps out for huge spaces instead of hanging", () => {
    const { value, uncapped } = computeCapacity(62, 100);
    assert.equal(uncapped, true);
    assert.equal(value, 10n ** 15n);
  });

  console.log("\n== Core uniqueness guarantee (single-writer) ==");

  await test("reserving codes never returns a code already in D1", async () => {
    const db = freshDb();
    const t = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 3 });
    const charset = "AB"; // tiny space: 8 combinations total, forces collisions
    const first = await reserveCodes(db, t.tokens, charset, 6, "req-1", "test");
    assert.equal(new Set(first).size, first.length, "no duplicates within first batch");

    const { results } = await db.prepare("SELECT code FROM generated_codes").all();
    assert.equal(results.length, first.length);

    const second = await reserveCodes(db, t.tokens, charset, 2, "req-2", "test");
    // Only 2 combinations left (8 total - 6 reserved), should get exactly those.
    assert.equal(second.length, 2);
    for (const code of second) {
      assert.ok(!first.includes(code), `code ${code} was reserved twice`);
    }

    const allRows = (await db.prepare("SELECT code FROM generated_codes").all()).results;
    const allCodes = allRows.map((r) => r.code);
    assert.equal(new Set(allCodes).size, allCodes.length, "D1 table itself has zero duplicates");
    assert.equal(allCodes.length, 8, "entire 8-combination space is now exhausted");
  });

  await test("reserveCodes stops gracefully (no infinite loop) when space is exhausted", async () => {
    const db = freshDb();
    const t = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 2 });
    const charset = "AB"; // only 4 combinations total: AA AB BA BB
    const first = await reserveCodes(db, t.tokens, charset, 4, "req-1", "test");
    assert.equal(first.length, 4);

    const start = Date.now();
    const second = await reserveCodes(db, t.tokens, charset, 10, "req-2", "test");
    const elapsed = Date.now() - start;
    assert.equal(second.length, 0, "no combinations left, so nothing new can be reserved");
    assert.ok(elapsed < 5000, "must bail out quickly via the retry cap, not hang");
  });

  console.log("\n== Concurrency / collision handling ==");

  await test("concurrent 'devices' reserving from the same space never overlap", async () => {
    const db = freshDb();
    const t = buildTemplate({ prefix: "", postfix: "", pattern: "", length: 3 });
    const charset = "ABCDEF"; // 216 combinations — enough for 3 x 50 with contention

    const [deviceA, deviceB, deviceC] = await Promise.all([
      reserveCodes(db, t.tokens, charset, 50, "device-A", "test"),
      reserveCodes(db, t.tokens, charset, 50, "device-B", "test"),
      reserveCodes(db, t.tokens, charset, 50, "device-C", "test"),
    ]);

    assert.equal(deviceA.length, 50);
    assert.equal(deviceB.length, 50);
    assert.equal(deviceC.length, 50);

    const all = [...deviceA, ...deviceB, ...deviceC];
    assert.equal(all.length, 150, "total returned = 300/2 scaled down = 150 here");
    assert.equal(new Set(all).size, 150, "unique returned = total returned, duplicates = 0");

    const dbRows = (await db.prepare("SELECT code FROM generated_codes").all()).results;
    assert.equal(dbRows.length, 150, "D1 row count matches total issued codes exactly");
  });

  console.log("\n== Patterns end-to-end through reserveCodes ==");

  const patternCases = [
    { pattern: "####", prefix: "", postfix: "" },
    { pattern: "####-####", prefix: "", postfix: "" },
    { pattern: "########-##", prefix: "", postfix: "" },
    { pattern: "####-2026", prefix: "KMP-", postfix: "" },
  ];

  for (const pc of patternCases) {
    await test(`pattern "${pc.prefix}${pc.pattern}${pc.postfix}" reserves correctly shaped, unique codes`, async () => {
      const db = freshDb();
      const t = buildTemplate({ prefix: pc.prefix, postfix: pc.postfix, pattern: pc.pattern, length: 0 });
      const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const codes = await reserveCodes(db, t.tokens, charset, 20, "req-pattern", pc.pattern);
      assert.equal(codes.length, 20);
      assert.equal(new Set(codes).size, 20);
      for (const code of codes) {
        assert.equal(code.length, t.tokens.length);
        assert.ok(code.startsWith(pc.prefix));
        assert.ok(code.endsWith(pc.postfix));
      }
    });
  }

  console.log("\n== estimateExistingForShape (capacity pre-flight) ==");

  await test("counts only codes matching the same shape", async () => {
    const db = freshDb();
    const t1 = buildTemplate({ prefix: "", postfix: "", pattern: "##", length: 0 });
    await reserveCodes(db, t1.tokens, "AB", 4, "req-1", "##"); // fills all of AA/AB/BA/BB

    const t2 = buildTemplate({ prefix: "X", postfix: "", pattern: "##", length: 0 });
    const existingForDifferentShape = await estimateExistingForShape(db, t2.tokens);
    assert.equal(existingForDifferentShape, 0n, "differently-shaped codes shouldn't be counted");

    const existingForSameShape = await estimateExistingForShape(db, t1.tokens);
    assert.equal(existingForSameShape, 4n);
  });

  console.log("\n== Rate limiting ==");

  await test("allows requests within limits and blocks once exceeded", async () => {
    const db = freshDb();
    const fakeRequest = { headers: new Map([["CF-Connecting-IP", "1.2.3.4"]]) };
    fakeRequest.headers.get = Map.prototype.get.bind(fakeRequest.headers);

    const limits = { maxRequestsPerMinute: 3, maxCodesPerMinute: 1000 };

    let lastResult;
    for (let i = 0; i < 3; i++) {
      lastResult = await checkRateLimit(db, fakeRequest, 10, limits);
      assert.equal(lastResult.ok, true, `request ${i + 1} should be allowed`);
    }
    const fourth = await checkRateLimit(db, fakeRequest, 10, limits);
    assert.equal(fourth.ok, false, "4th request within the window should be blocked");
  });

  await test("blocks when code-volume limit exceeded even under request-count limit", async () => {
    const db = freshDb();
    const fakeRequest = { headers: new Map([["CF-Connecting-IP", "5.6.7.8"]]) };
    fakeRequest.headers.get = Map.prototype.get.bind(fakeRequest.headers);

    const limits = { maxRequestsPerMinute: 100, maxCodesPerMinute: 500 };
    const first = await checkRateLimit(db, fakeRequest, 400, limits);
    assert.equal(first.ok, true);
    const second = await checkRateLimit(db, fakeRequest, 200, limits);
    assert.equal(second.ok, false, "400 + 200 > 500 code/minute limit");
  });

  console.log("\n== Summary ==");
  console.log(`  ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

run();

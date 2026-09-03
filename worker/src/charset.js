// Character-set resolution: presets + custom sets + confusing-character
// exclusion. Runs server-side because the worker must never trust a
// charset string the client claims to have used — it rebuilds it from
// the same rules the client's preview uses, then validates the result.

export const PRESETS = {
  numbers: "0123456789",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  upperNumbers: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  lowerNumbers: "abcdefghijklmnopqrstuvwxyz0123456789",
  upperLowerNumbers:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
};

// Characters commonly confused with each other visually.
const CONFUSING_CHARS = new Set(["O", "0", "I", "1", "L", "l", "o"]);

/**
 * Resolve the final character set to use for random positions.
 *
 * @param {object} opts
 * @param {string} [opts.preset] - one of the PRESETS keys, or "custom"
 * @param {string} [opts.custom] - custom character string (used when preset === "custom",
 *   or merged in if provided alongside a preset)
 * @param {boolean} [opts.excludeConfusing] - strip visually-confusing characters
 * @returns {{ ok: true, charset: string } | { ok: false, error: string }}
 */
export function resolveCharset({ preset, custom, excludeConfusing }) {
  let raw = "";

  if (preset && preset !== "custom") {
    if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
      return { ok: false, error: `Unknown character preset: ${preset}` };
    }
    raw += PRESETS[preset];
  }

  if (custom && typeof custom === "string") {
    raw += custom;
  }

  if (!raw) {
    return { ok: false, error: "Please select at least one character." };
  }

  // De-duplicate while preserving first-seen order.
  const seen = new Set();
  let deduped = "";
  for (const ch of raw) {
    if (!seen.has(ch)) {
      seen.add(ch);
      deduped += ch;
    }
  }

  if (excludeConfusing) {
    deduped = [...deduped].filter((ch) => !CONFUSING_CHARS.has(ch)).join("");
  }

  if (deduped.length === 0) {
    return { ok: false, error: "Please select at least one character." };
  }

  return { ok: true, charset: deduped };
}

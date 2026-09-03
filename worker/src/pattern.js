// Turns { prefix, pattern, postfix, length } into a single template:
// an array of tokens, each either { literal: "X" } or { random: true }.
//
// Rules:
// - If `pattern` is provided, it must contain at least one "#" and every
//   other character is a literal, preserved exactly (separators included).
// - If no pattern is provided, `length` random positions are used instead.
// - prefix/postfix are literal tokens prepended/appended around the pattern
//   or random run. They are NEVER counted as random positions.

export function buildTemplate({ prefix, postfix, pattern, length }) {
  const tokens = [];

  if (prefix) {
    for (const ch of prefix) tokens.push({ literal: ch });
  }

  if (pattern) {
    if (typeof pattern !== "string" || !pattern.includes("#")) {
      return {
        ok: false,
        error:
          "Please enter a valid pattern containing at least one # placeholder.",
      };
    }
    for (const ch of pattern) {
      tokens.push(ch === "#" ? { random: true } : { literal: ch });
    }
  } else {
    const len = Number(length);
    if (!Number.isInteger(len) || len < 1) {
      return { ok: false, error: "Please enter a valid code length." };
    }
    for (let i = 0; i < len; i++) tokens.push({ random: true });
  }

  if (postfix) {
    for (const ch of postfix) tokens.push({ literal: ch });
  }

  const randomPositions = tokens.filter((t) => t.random).length;
  if (randomPositions === 0) {
    return {
      ok: false,
      error:
        "Please enter a valid pattern containing at least one # placeholder.",
    };
  }

  return { ok: true, tokens, randomPositions };
}

// Builds a SQLite LIKE pattern from the template so we can COUNT(*) how
// many codes matching this exact shape already exist in D1, for the
// capacity estimate. "_" matches any single character in SQLite LIKE;
// literal "_" and "%" in the template are escaped with ESCAPE '\'.
export function templateToLikePattern(tokens) {
  let out = "";
  for (const t of tokens) {
    if (t.random) {
      out += "_";
    } else if (t.literal === "_" || t.literal === "%" || t.literal === "\\") {
      out += "\\" + t.literal;
    } else {
      out += t.literal;
    }
  }
  return out;
}

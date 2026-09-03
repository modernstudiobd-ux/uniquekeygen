-- Migration 0001: initial schema for Unique Code Generator
-- The UNIQUE constraint on `code` is the sole source of truth for
-- global uniqueness. Every other layer (frontend, worker, IndexedDB
-- cache) is convenience only — this constraint is what actually
-- prevents a code from ever being issued twice.

CREATE TABLE IF NOT EXISTS generated_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    request_id  TEXT,              -- groups codes issued in the same /api/generate call
    pattern     TEXT,              -- pattern/config used to produce this code, for auditing
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Speeds up the INSERT-then-check-conflict path and any future
-- lookups/exports by request batch.
CREATE INDEX IF NOT EXISTS idx_generated_codes_request_id
    ON generated_codes (request_id);

-- Optional: a lightweight table to track per-IP request volume for
-- rate limiting without needing an external service (Durable
-- Objects / KV are better at scale, but this keeps everything in D1
-- for a first version).
CREATE TABLE IF NOT EXISTS rate_limit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash    TEXT NOT NULL,
    quantity   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_log_ip_time
    ON rate_limit_log (ip_hash, created_at);

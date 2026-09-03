// A minimal mock of Cloudflare D1's binding API, backed by better-sqlite3.
// Mirrors just enough of the real interface (prepare/bind/run/all/first,
// db.batch) for our worker code to run unmodified against it in tests.
// This does NOT prove D1's own SQLite engine enforces UNIQUE atomically
// under real network concurrency (that's Cloudflare's guarantee, and is
// documented D1/SQLite behavior) — it proves OUR code correctly relies on
// that guarantee: that it never does check-then-insert, and correctly
// interprets INSERT OR IGNORE results via meta.changes.

import Database from "better-sqlite3";

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    const s = new MockStatement(this.db, this.sql);
    s.params = params;
    return s;
  }

  run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: info.lastInsertRowid,
      },
    };
  }

  all() {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.params);
    return { success: true, results, meta: {} };
  }

  first() {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params);
    return row === undefined ? null : row;
  }
}

export class MockD1 {
  constructor() {
    this.db = new Database(":memory:");
  }

  prepare(sql) {
    return new MockStatement(this.db, sql);
  }

  async batch(statements) {
    // D1's batch runs statements sequentially in an implicit transaction;
    // INSERT OR IGNORE never throws on conflict, so this simple sequential
    // execution reproduces the semantics we depend on.
    const results = [];
    const txn = this.db.transaction((stmts) => {
      for (const s of stmts) {
        const stmt = this.db.prepare(s.sql);
        const info = stmt.run(...s.params);
        results.push({
          success: true,
          meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
        });
      }
    });
    txn(statements);
    return results;
  }

  exec(sql) {
    this.db.exec(sql);
  }
}

export function createMockD1WithSchema(schemaSql) {
  const mock = new MockD1();
  mock.exec(schemaSql);
  return mock;
}

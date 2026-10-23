// Offline D1-shaped adapter over the Node 24 bundled SQLite implementation.
import { DatabaseSync } from 'node:sqlite';

export function createD1(options = {}) {
  const { filename = ':memory:', schemaSql } = typeof options === 'string' ? { filename: options } : options;
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  if (schemaSql !== undefined) sqlite.exec(schemaSql);
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first(column) {
      const row = sqlite.prepare(this.sql).get(...this.values);
      if (!row) return null;
      return column === undefined ? { ...row } : row[column];
    }
    async all() {
      return { success: true, results: sqlite.prepare(this.sql).all(...this.values).map(row => ({ ...row })) };
    }
    syncRun() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    async run() { return this.syncRun(); }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        // Execute the entire transaction synchronously; do not yield an open
        // SQLite transaction to another concurrent fake-D1 request.
        for (const statement of statements) results.push(statement.syncRun());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    exec(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); },
  };
}

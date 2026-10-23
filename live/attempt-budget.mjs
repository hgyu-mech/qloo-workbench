import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

function check(state) {
  if (state?.version !== 1 || !Number.isInteger(state.limit) || state.limit < 1 || state.limit > 4 || !Number.isInteger(state.attempts)
      || state.attempts < 0 || state.attempts > state.limit || typeof state.stopped !== 'boolean'
      || !Array.isArray(state.paths) || state.paths.length !== state.attempts) {
    throw new Error('BUDGET_STATE_INVALID');
  }
  return state;
}

// Trusted private path supplied by the launcher, never by an MCP argument.
// Reservation is persisted BEFORE fetch; failed requests remain consumed.
export class FileAttemptBudget {
  constructor(path, limit = 2) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('BUDGET_LIMIT_STOP');
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify({ version: 1, limit, attempts: 0, stopped: false, paths: [] }),
                    { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('BUDGET_STORAGE_FAILED');
    }
    if (this.snapshot().limit !== limit) throw new Error('BUDGET_LIMIT_CHANGED_STOP');
  }
  snapshot() {
    try { return check(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { throw new Error('BUDGET_STATE_INVALID'); }
  }
  change(action) {
    let fd;
    const lock = this.path + '.lock';
    try {
      fd = openSync(lock, 'wx', 0o600);
      const state = this.snapshot();
      action(state);
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
      return structuredClone(state);
    } catch (error) {
      if (error?.message?.endsWith('_STOP')) throw error;
      throw new Error('BUDGET_STORAGE_STOP');
    } finally {
      if (fd !== undefined) { closeSync(fd); unlinkSync(lock); }
    }
  }
  reserve(path) {
    return this.change(state => {
      if (state.stopped) throw new Error('SESSION_STOPPED_STOP');
      if (state.attempts >= state.limit) throw new Error('BUDGET_EXHAUSTED_STOP');
      state.attempts += 1;
      state.paths.push(path);
    });
  }
  stop() { return this.change(state => { state.stopped = true; }); }
}

// Explicit memory-only test seam. Production entry does not construct this.
export class MemoryAttemptBudget {
  constructor(limit = 2) { this.state = { version: 1, limit, attempts: 0, stopped: false, paths: [] }; check(this.state); }
  snapshot() { return structuredClone(this.state); }
  reserve(path) {
    if (this.state.stopped) throw new Error('SESSION_STOPPED_STOP');
    if (this.state.attempts >= this.state.limit) throw new Error('BUDGET_EXHAUSTED_STOP');
    this.state.attempts += 1; this.state.paths.push(path);
  }
  stop() { this.state.stopped = true; }
}

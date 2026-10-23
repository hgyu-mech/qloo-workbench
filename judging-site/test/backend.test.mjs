import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { createD1 } from './d1-shim.mjs';
import { createWorkflow } from '../src/backend.mjs';

const SCHEMA = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
const SID = 'a'.repeat(32);
const SID2 = 'b'.repeat(32);
const FAKE_KEY = 'OFFLINE_TEST_ONLY_NOT_A_REAL_QLOO_KEY_12345';
const BASE_TIME = Date.parse('2026-10-23T12:00:00Z');
const POLICY = { id: 'offline-review-1', enabled: true, validUntil: '2026-11-06T04:45:00Z', maxHttpAttempts: 2 };
const TAG_ROW = { id: 'urn:tag:genre:media:synthetic-a', name: 'Synthetic tag A' };
const MOVIE_ROW = { entity_id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic movie A', type: 'urn:entity', subtype: 'urn:entity:movie', query: { affinity: 0.25 } };
let unexpectedNetwork = 0;
const noNetwork = () => { unexpectedNetwork++; throw Error('OFFLINE_NETWORK_GUARD'); };
globalThis.fetch = noNetwork;
for (const [object, names] of [[net, ['connect', 'createConnection']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']]]) {
  for (const name of names) object[name] = noNetwork;
}
after(() => assert.equal(unexpectedNetwork, 0, 'No real fetch or socket path may run'));
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function fakeProvider(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    return new URL(url).pathname === '/v2/tags'
      ? jsonResponse({ results: { tags: [TAG_ROW] }, unknown_metadata: 'discard' })
      : jsonResponse({ results: { entities: [MOVIE_ROW] }, description: 'discard', raw_url: 'https://example.invalid' });
  };
}
function setup(options = {}) {
  const db = createD1(); db.exec(SCHEMA);
  let time = Date.parse('2026-10-23T12:00:00Z');
  let fetches = 0;
  const workflow = createWorkflow({ db, now: () => time,
    fetchImpl: async () => { fetches++; throw Error('NO NETWORK IN TEST'); }, ...options });
  return { db, workflow, advance: ms => { time += ms; }, calls: () => fetches };
}

test('invented fixture resolves, confirms one returned choice and caches identical recommendation', async () => {
  const { workflow: app, db, calls } = setup();
  try {
    const resolved = await app.resolve(SID, 'quiet evenings');
    assert.equal(resolved.status, 'needs_confirmation');
    assert.equal(typeof resolved.canonical.execution.correlation_id, 'string');
    assert.deepEqual(resolved.canonical.interpretation, { query: 'quiet evenings', semantic: true });
    assert.equal(resolved.canonical.provenance.endpoint, '/v2/tags');
    assert.equal(resolved.canonical.provenance.source, 'Invented fixtures');
    assert.equal(resolved.mode, 'fixture');
    assert.equal(resolved.data_source, 'invented-fixture-v1');
    assert.ok(resolved.fixture_notice.includes('invented'));
    const confirmed = await app.confirm(SID, resolved.resolution_id, resolved.candidates[1].id);
    assert.equal(confirmed.status, 'confirmed');
    const result = await app.recommend(SID, confirmed.receipt, 'movie', 3);
    assert.equal(result.status, 'ok');
    assert.equal(result.recommendations.length, 3);
    assert.equal(result.selected_tag.id, resolved.candidates[1].id);
    assert.equal(result.cached_receipt_replay, false);
    const cached = await app.recommend(SID, confirmed.receipt, 'movie', 3);
    assert.equal(cached.cached_receipt_replay, true);
    assert.deepEqual(cached.recommendations, result.recommendations);
    assert.equal(calls(), 0);
  } finally { db.close(); }
});

test('cross-session, altered receipt, and changed target/limit cannot authorize a recommendation', async () => {
  const { workflow: app, db } = setup();
  try {
    const resolved = await app.resolve(SID, 'quiet evenings');
    assert.equal((await app.confirm(SID2, resolved.resolution_id, resolved.candidates[0].id)).error.code, 'unknown_or_expired_resolution');
    assert.equal((await app.confirm(SID, resolved.resolution_id, 'urn:tag:genre:media:not-returned')).error.code, 'tag_not_in_candidates');
    const confirmed = await app.confirm(SID, resolved.resolution_id, resolved.candidates[0].id);
    assert.equal((await app.recommend(SID2, confirmed.receipt, 'movie', 3)).error.code, 'invalid_receipt');
    assert.equal((await app.recommend(SID, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'movie', 3)).error.code, 'invalid_receipt');
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 3)).status, 'ok');
    assert.equal((await app.recommend(SID, confirmed.receipt, 'book', 3)).error.code, 'receipt_already_used');
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 2)).error.code, 'receipt_already_used');
  } finally { db.close(); }
});

test('authority expires after 15 minutes and reset removes old receipts without erasing stop state', async () => {
  const { workflow: app, db, advance } = setup();
  try {
    const resolved = await app.resolve(SID, 'quiet evenings');
    const confirmed = await app.confirm(SID, resolved.resolution_id, resolved.candidates[0].id);
    advance(15 * 60 * 1000);
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 3)).error.code, 'session_expired');
    assert.equal((await app.readiness(SID)).ready_for_calls, false);
    assert.equal((await app.reset(SID)).budget_reset, false);
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 3)).error.code, 'invalid_receipt');
  } finally { db.close(); }
});

test('confirmation is idempotent and concurrent conflicting choices cannot mint two receipts', async () => {
  const { workflow: app, db } = setup();
  try {
    const resolved = await app.resolve(SID, 'quiet evenings');
    const outcomes = await Promise.all([
      app.confirm(SID, resolved.resolution_id, resolved.candidates[0].id),
      app.confirm(SID, resolved.resolution_id, resolved.candidates[1].id),
    ]);
    assert.equal(outcomes.filter(row => row.status === 'confirmed').length, 1);
    assert.equal(outcomes.filter(row => row.error?.code === 'choice_already_confirmed').length, 1);
    const winner = outcomes.find(row => row.status === 'confirmed');
    assert.equal((await app.confirm(SID, resolved.resolution_id, winner.selected_tag.id)).receipt, winner.receipt);
  } finally { db.close(); }
});

test('live fake provider receives only two bounded GETs and returns projected generic type/subtype', async () => {
  const calls = [];
  const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY, fetchImpl: fakeProvider(calls) });
  try {
    const resolved = await app.resolve(SID, 'quiet evenings');
    assert.equal(resolved.status, 'needs_confirmation');
    const confirmed = await app.confirm(SID, resolved.resolution_id, TAG_ROW.id);
    assert.equal(calls.length, 1, 'confirmation performs no HTTP');
    const result = await app.recommend(SID, confirmed.receipt, 'movie', 1);
    assert.equal(result.status, 'ok');
    assert.equal(result.recommendations[0].subtype, 'urn:entity:movie');
    assert.equal(result.recommendations[0].affinity, 0.25);
    assert.equal(result.recommendations[0].description, undefined);
    assert.equal(result.canonical.provenance.source, 'Qloo API');
    assert.equal(result.canonical.provenance.endpoint, '/v2/insights');
    assert.equal(typeof result.canonical.execution.correlation_id, 'string');
    assert.deepEqual(result.canonical.interpretation, { target_type: 'urn:entity:movie',
      signal_tags: [{ input: TAG_ROW.id, tagId: TAG_ROW.id, match: 'identifier' }] });
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 1)).cached_receipt_replay, true);
    assert.equal(calls.length, 2);
    const tags = new URL(calls[0].url), insights = new URL(calls[1].url);
    assert.equal(tags.origin, 'https://hackathon.api.qloo.com');
    assert.deepEqual([...tags.searchParams], [['filter.query', 'quiet evenings'], ['feature.semantic_search', 'true'], ['take', '3']]);
    assert.deepEqual([...insights.searchParams], [['filter.type', 'urn:entity:movie'], ['signal.interests.tags', TAG_ROW.id],
      ['operator.signal.interests.tags', 'intersection'], ['feature.explainability', 'true'], ['take', '1']]);
    for (const call of calls) {
      assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'manual');
      assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.body, undefined);
      assert.equal(call.options.headers['X-Api-Key'], FAKE_KEY);
    }
    const readiness = await app.readiness(SID);
    assert.equal(readiness.remaining_http_attempts, 0);
    assert.equal(readiness.ready_for_calls, false);
    assert.equal(readiness.blocked_reason, 'budget_exhausted');
    assert.match(readiness.limitation, /billing guarantee and quota unknown/);
  } finally { db.close(); }
});

test('live is fail closed with absent/disabled/expired/overlong policy and fixture never calls fetch', async () => {
  const configurations = [undefined, { ...POLICY, enabled: false }, { ...POLICY, validUntil: '2026-10-22T12:00:00Z' },
    { ...POLICY, validUntil: '2026-11-06T04:45:00.001Z' }, { ...POLICY, maxHttpAttempts: 0 }];
  for (const policy of configurations) {
    let calls = 0;
    const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy, fetchImpl: async () => { calls++; throw Error('NO'); } });
    try {
      assert.equal((await app.resolve(SID, 'quiet evenings')).status, 'error');
      assert.equal((await app.readiness(SID)).ready_for_calls, false);
      assert.equal(calls, 0);
    } finally { db.close(); }
  }
});

test('contact details, URLs, and key reflections are rejected before fetch or budget use', async () => {
  const calls = [];
  const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY, fetchImpl: fakeProvider(calls) });
  try {
    for (const query of ['mail@example.test', 'https://example.test', 'www.example.test', '+82 10 1234 5678', FAKE_KEY]) {
      assert.equal((await app.resolve(SID, query)).status, 'error');
    }
    assert.equal(calls.length, 0);
    assert.equal((await app.readiness(SID)).backend_calls, 0);
  } finally { db.close(); }
});

test('concurrent requests cannot exceed shared budget across factories, and reset cannot replenish it', async () => {
  const { db } = setup(); const calls = []; const releases = [];
  const slow = async url => { calls.push(url); return new Promise(resolve => releases.push(() => resolve(jsonResponse({ results: { tags: [TAG_ROW] } })))); };
  const factory = () => createWorkflow({ db, mode: 'live', policy: POLICY, apiKey: FAKE_KEY, now: () => BASE_TIME, fetchImpl: slow });
  try {
    const first = factory(), second = factory(), third = factory();
    const pending = [first.resolve(SID, 'first taste'), second.resolve(SID2, 'second taste'), third.resolve('c'.repeat(32), 'third taste')];
    for (let index = 0; index < 40 && releases.length < 2; index++) await Promise.resolve();
    assert.equal(releases.length, 2);
    releases.forEach(release => release());
    const results = await Promise.all(pending);
    assert.equal(results.filter(row => row.status === 'needs_confirmation').length, 2);
    assert.equal(results.filter(row => row.error?.code === 'budget_exhausted').length, 1);
    assert.equal(calls.length, 2);
    await first.reset(SID);
    assert.equal((await factory().resolve('d'.repeat(32), 'new session')).error.code, 'budget_exhausted');
    assert.equal((await factory().readiness(SID)).backend_calls, 2);
  } finally { db.close(); }
});

test('SQLite restart preserves consumed aggregate budget and rejects changed policy settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qloo-judging-test-'));
  const filename = join(directory, 'budget.sqlite');
  let db = createD1({ filename, schemaSql: SCHEMA }); const calls = [];
  try {
    const policy = { ...POLICY, maxHttpAttempts: 1 };
    const make = p => createWorkflow({ db, mode: 'live', policy: p, apiKey: FAKE_KEY, now: () => BASE_TIME, fetchImpl: fakeProvider(calls) });
    assert.equal((await make(policy).resolve(SID, 'quiet evenings')).status, 'needs_confirmation');
    db.close(); db = createD1({ filename });
    assert.equal((await make(policy).resolve(SID2, 'another taste')).error.code, 'budget_exhausted');
    assert.equal((await make({ ...policy, maxHttpAttempts: 2 }).resolve(SID2, 'another taste')).error.code, 'policy_mismatch');
    assert.equal(calls.length, 1);
  } finally { db.close(); unlinkSync(filename); rmdirSync(directory); }
});

test('upstream HTTP, redirect, schema and secret failures stop the shared policy across reset and restart', async () => {
  const badResponses = [
    () => new Response('not stored', { status: 429 }),
    () => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }),
    () => jsonResponse({ results: { tags: [{ ...TAG_ROW, id: 'bad-id' }] } }),
    () => jsonResponse({ results: { tags: [TAG_ROW] }, [FAKE_KEY]: 'reflection in key' }),
    () => jsonResponse({ results: { tags: [TAG_ROW] }, nested: JSON.stringify({ value: FAKE_KEY }) }),
    () => new Response(JSON.stringify({ results: { tags: [TAG_ROW] } }), { headers: { 'content-type': 'application/json', 'x-synthetic': FAKE_KEY } }),
  ];
  for (const respond of badResponses) {
    let calls = 0;
    const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY,
      fetchImpl: async () => { calls++; return respond(); } });
    try {
      const error = await app.resolve(SID, 'quiet evenings');
      assert.equal(error.status, 'error'); assert.ok(!JSON.stringify(error).includes(FAKE_KEY));
      assert.equal(calls, 1);
      await app.reset(SID);
      assert.equal((await app.resolve(SID, 'quiet evenings')).error.code, 'session_stopped');
      const restarted = createWorkflow({ db, mode: 'live', apiKey: FAKE_KEY, policy: POLICY, now: () => BASE_TIME, fetchImpl: fakeProvider([]) });
      assert.equal((await restarted.resolve(SID2, 'another taste')).error.code, 'policy_stopped');
      const stoppedReadiness = await restarted.readiness(SID2);
      assert.equal(stoppedReadiness.ready_for_calls, false);
      assert.equal(stoppedReadiness.backend_calls, 1, 'consumed reservations remain visible after stop');
      assert.equal(stoppedReadiness.remaining_http_attempts, 1);
      assert.equal(calls, 1);
    } finally { db.close(); }
  }
});

test('wrong entity subtype fails closed and cannot be replayed by changing receipt target', async () => {
  let calls = 0;
  const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY,
    fetchImpl: async () => ++calls === 1 ? jsonResponse({ results: { tags: [TAG_ROW] } })
      : jsonResponse({ results: { entities: [{ ...MOVIE_ROW, subtype: 'urn:entity:book' }] } }) });
  try {
    const resolution = await app.resolve(SID, 'quiet evenings');
    const confirmed = await app.confirm(SID, resolution.resolution_id, TAG_ROW.id);
    assert.equal((await app.recommend(SID, confirmed.receipt, 'movie', 1)).error.code, 'provider_schema_error');
    assert.equal((await app.recommend(SID, confirmed.receipt, 'book', 1)).error.code, 'session_stopped');
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test('body cap accepts exact 5 MiB and rejects cap+1 while valid payload above 64 KiB succeeds', async () => {
  const maximum = 5 * 1024 * 1024;
  for (const size of [70000, maximum, maximum + 1]) {
    const prefix = JSON.stringify({ results: { tags: [TAG_ROW] } }).slice(0, -1) + ',"padding":"';
    const suffix = '"}';
    const body = prefix + 'a'.repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
    assert.equal(Buffer.byteLength(body), size);
    const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY,
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
    try {
      const result = await app.resolve(SID, 'quiet evenings');
      assert.equal(result.status, size <= maximum ? 'needs_confirmation' : 'error');
      if (size > maximum) assert.equal(result.error.code, 'provider_size_error');
    } finally { db.close(); }
  }
});

test('15-second timeout consumes one reservation and blocks late completion and alternate sessions', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let signal; let calls = 0;
  const { workflow: app, db } = setup({ mode: 'live', apiKey: FAKE_KEY, policy: POLICY,
    fetchImpl: async (_url, options) => { calls++; signal = options.signal; entered(); return new Promise(() => {}); } });
  try {
    const pending = app.resolve(SID, 'quiet evenings');
    await started; context.mock.timers.tick(15001);
    assert.equal((await pending).error.code, 'provider_timeout');
    assert.equal(signal.aborted, true);
    await app.reset(SID);
    assert.equal((await app.resolve(SID2, 'another taste')).error.code, 'policy_stopped');
    assert.equal(calls, 1);
  } finally { db.close(); }
});

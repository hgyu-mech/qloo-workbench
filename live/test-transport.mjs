import { networkGuard } from './offline-network-guard.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ACCESS_POLICY, requireAccess, REVIEW_BASIS, COST_CERTAINTY, REVIEW_FACTS } from './access-policy.mjs';
import { FileAttemptBudget, MemoryAttemptBudget } from './attempt-budget.mjs';
import { createBoundedTransport, ORIGIN, MAX_BYTES, assertNoSecret } from './bounded-transport.mjs';
import { createCandidateRuntime } from './canonical-live-entry.mjs';
import { parseLauncherEnvironment, main as launchMain, cleanAuditRecord, createPrivatePayloadCapture } from './entry.mjs';

const KEY = 'SYNTHETIC-QLOO-KEY-ONLY';
const TAG = 'urn:tag:genre:media:science_fiction';
const POLICY = Object.freeze({ enabled: true, freeAccessConfirmed: true,
  evidenceReference: 'offline-fixture-only-not-provider-access', expiresAt: '2100-01-01T00:00:00Z', httpAttemptBudget: 2 });
const TAG_DATA = { results: { tags: [{ id: TAG, name: 'Science fiction', type: 'urn:tag:genre' }] } };
const ENTITY_DATA = { results: { entities: [{ entity_id: '12345678-1234-1234-9234-123456789abc',
  name: 'Synthetic Movie Fixture', type: 'urn:entity:movie', query: { affinity: 0.75 } }] } };
function response(value, options = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value),
    { status: 200, headers: { 'content-type': 'application/json' }, ...options });
}
function tagUrl() {
  const url = new URL('/v2/tags', ORIGIN);
  url.search = new URLSearchParams({ 'filter.query': 'science fiction', 'feature.semantic_search': 'true', take: '3' });
  return url;
}
function recoUrl(tag = TAG) {
  const url = new URL('/v2/insights', ORIGIN);
  url.search = new URLSearchParams({ 'filter.type': 'urn:entity:movie', 'signal.interests.tags': tag,
    'operator.signal.interests.tags': 'intersection', 'feature.explainability': 'true', take: '3' });
  return url;
}
const INIT = { method: 'GET', headers: { 'X-Api-Key': KEY } };
function setup(fetchImplementation, options = {}) {
  const budget = options.budget ?? new MemoryAttemptBudget();
  const transport = createBoundedTransport({ policy: POLICY, secret: KEY, budget, fetchImplementation, ...options });
  return { transport, budget };
}

function reviewedEnvironment(folder) {
  const record = 'Offline synthetic reviewed event record; no provider guarantee.';
  const digest = createHash('sha256').update(record).digest('hex');
  const recordPath = join(folder, 'review.private.txt');
  writeFileSync(recordPath, record);
  const env = { QLOO_ACCESS_BASIS: REVIEW_BASIS, QLOO_COST_CERTAINTY: COST_CERTAINTY,
    QLOO_REVIEWED_AT: new Date(Date.now() - 5000).toISOString(),
    QLOO_FREE_ACCESS_EXPIRES_AT: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    QLOO_MAX_HTTP_ATTEMPTS: '2', QLOO_HARNESS_DIR: folder,
    QLOO_BASE_URL: ORIGIN, QLOO_TRUSTED_BASE_URL: ORIGIN,
    QLOO_POLICY_DIRECTORY: folder, QLOO_REVIEW_RECORD_PATH: recordPath,
    QLOO_REVIEW_RECORD_SHA256: digest,
    QLOO_TRANSPORT_AUDIT: join(folder, 'reviewed-event-' + digest + '.http-attempts.private.jsonl') };
  for (const variable of Object.values(REVIEW_FACTS)) env[variable] = 'yes';
  return env;
}

test('reviewed event basis does not upgrade inferred entitlement to provider confirmation', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-reviewed-basis-'));
  try {
    const config = parseLauncherEnvironment(reviewedEnvironment(folder));
    assert.equal(config.policy.accessBasis, REVIEW_BASIS);
    assert.equal(config.policy.freeAccessConfirmed, false);
    assert.equal(config.policy.costCertainty, COST_CERTAINTY);
    assert.doesNotThrow(() => requireAccess(config.policy));
    assert.throws(() => requireAccess(ACCESS_POLICY), /FREE_ACCESS_NOT_CONFIRMED/);
    assert.throws(() => requireAccess({ ...config.policy, freeAccessConfirmed: true }), /FREE_ACCESS_NOT_CONFIRMED/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('reviewed event missing or false facts reject main before it reads a credential', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-reviewed-facts-'));
  try {
    const env = reviewedEnvironment(folder);
    for (const variable of Object.values(REVIEW_FACTS)) {
      for (const value of [undefined, 'no', 'true', false]) {
        const invalid = { ...env, [variable]: value };
        let keyReads = 0;
        const watched = new Proxy(invalid, { get(target, name) {
          if (name === 'QLOO_API_KEY') { keyReads++; throw Error('KEY_READ_FORBIDDEN'); }
          return target[name];
        } });
        await assert.rejects(launchMain(watched), /FREE_ACCESS_NOT_CONFIRMED/);
        assert.equal(keyReads, 0);
      }
    }
    for (const patch of [{ QLOO_ACCESS_BASIS: 'unknown' }, { QLOO_COST_CERTAINTY: 'guaranteed' },
      { QLOO_MAX_HTTP_ATTEMPTS: '3' }, { QLOO_FREE_ACCESS_CONFIRMED: 'yes' },
      { QLOO_FREE_ACCESS_EXPIRES_AT: new Date(Date.now() + 31 * 60 * 1000).toISOString() }]) {
      assert.throws(() => parseLauncherEnvironment({ ...env, ...patch }));
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('review record hash and containment bind the shared audit path', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-reviewed-binding-'));
  try {
    const env = reviewedEnvironment(folder);
    assert.throws(() => parseLauncherEnvironment({ ...env, QLOO_TRANSPORT_AUDIT: join(folder, 'different.jsonl') }),
      /REVIEW_RECORD_BINDING_STOP/);
    const inner = join(folder, 'policy-parent'); mkdirSync(inner);
    assert.throws(() => parseLauncherEnvironment({ ...env, QLOO_POLICY_DIRECTORY: inner }), /REVIEW_RECORD_BOUNDARY_STOP/);
    writeFileSync(env.QLOO_REVIEW_RECORD_PATH, 'changed judgement');
    assert.throws(() => parseLauncherEnvironment(env), /REVIEW_RECORD_BINDING_STOP/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('private capture preserves validated payload before projection failure without overwrites', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-private-capture-'));
  try {
    const env = reviewedEnvironment(folder);
    env.QLOO_PRIVATE_RESPONSE_DIRECTORY = join(folder, 'private', 'responses-' + env.QLOO_REVIEW_RECORD_SHA256);
    const config = parseLauncherEnvironment(env);
    const capture = createPrivatePayloadCapture(config);
    const payload = { results: { entities: 'synthetic unexpected schema' }, unknown_fixture: true };
    const runtime = await createCandidateRuntime({ policy: config.policy, secret: KEY,
      budget: new MemoryAttemptBudget(), captureValidatedPayload: capture,
      fetchImplementation: async url => response(url.pathname === '/v2/tags' ? TAG_DATA : payload) });
    const tags = await runtime.tools.find(tool => tool.name === 'qloo_find_tags').execute('capture_tags',
      { query: 'science fiction', semantic: true, limit: 3 });
    assert.equal(tags.details.status, 'ok');
    const recommendation = await runtime.tools.find(tool => tool.name === 'qloo_recommend').execute('capture_reco',
      { target_type: 'movie', signal_tags: [TAG], limit: 1, explain: true });
    assert.equal(recommendation.details.error.code, 'LIVE_BOUNDARY_STOP');
    assert.equal(runtime.transport.snapshot().stopped, true);
    assert.equal(runtime.transport.snapshot().httpAttempts, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(config.captureDirectory, 'tags.json'))), TAG_DATA);
    const target = join(config.captureDirectory, 'insights.json');
    const saved = readFileSync(target);
    assert.deepEqual(JSON.parse(saved), payload);
    const meta = JSON.parse(readFileSync(join(config.captureDirectory, 'insights.meta.json')));
    assert.equal(meta.sha256, createHash('sha256').update(saved).digest('hex'));
    assert.equal(meta.bytes, saved.length);
    assert.throws(() => capture('/v2/insights', ENTITY_DATA), /PRIVATE_CAPTURE_STOP/);
    assert.deepEqual(JSON.parse(readFileSync(target)), payload);
    assert.throws(() => capture('/search', TAG_DATA), /PRIVATE_CAPTURE_STOP/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('capture never receives reflected secrets in values, object keys, or nested encoded JSON', async () => {
  for (const payload of [{ ...TAG_DATA, debug: KEY }, { ...TAG_DATA, [KEY]: 'value' },
    { ...TAG_DATA, nested: JSON.stringify({ [KEY]: 'value' }) }]) {
    let captures = 0;
    const { transport } = setup(async () => response(payload), {
      captureValidatedPayload: () => { captures++; } });
    await assert.rejects(transport.fetch(tagUrl(), INIT), /SECRET_REFLECTION_STOP/);
    assert.equal(captures, 0);
  }
});

test('capture directory is v2-only and fixed inside the policy private subtree', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-capture-boundary-'));
  try {
    const env = reviewedEnvironment(folder);
    assert.throws(() => parseLauncherEnvironment({ ...env, QLOO_PRIVATE_RESPONSE_DIRECTORY: join(folder, 'outside') }),
      /PRIVATE_CAPTURE_BOUNDARY_STOP/);
    assert.equal(existsSync(join(folder, 'outside')), false);
    assert.throws(() => createPrivatePayloadCapture({ policy: POLICY, captureDirectory: folder }), /PRIVATE_CAPTURE_BOUNDARY_STOP/);
    assert.equal(createPrivatePayloadCapture({ policy: POLICY }), undefined);
    const v1 = { QLOO_FREE_ACCESS_CONFIRMED: 'yes', QLOO_FREE_ACCESS_EXPIRES_AT: POLICY.expiresAt,
      QLOO_MAX_HTTP_ATTEMPTS: '2', QLOO_HARNESS_DIR: folder, QLOO_TRANSPORT_AUDIT: join(folder, 'audit'),
      QLOO_BASE_URL: ORIGIN, QLOO_TRUSTED_BASE_URL: ORIGIN, QLOO_PRIVATE_RESPONSE_DIRECTORY: folder };
    assert.throws(() => parseLauncherEnvironment(v1), /PRIVATE_CAPTURE_BOUNDARY_STOP/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('reviewed event two-attempt budget and failure stop survive a new runtime', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'qloo-reviewed-restart-'));
  try {
    const env = reviewedEnvironment(folder);
    const config = parseLauncherEnvironment(env);
    const ledger = config.auditPath + '.budget.json';
    let fakeCalls = 0;
    const firstBudget = new FileAttemptBudget(ledger, 2);
    const first = createBoundedTransport({ policy: config.policy, secret: KEY, budget: firstBudget,
      fetchImplementation: async () => { fakeCalls++; return response(TAG_DATA); } });
    await first.fetch(tagUrl(), INIT);
    const restarted = new FileAttemptBudget(parseLauncherEnvironment(env).auditPath + '.budget.json', 2);
    assert.equal(restarted.snapshot().attempts, 1);
    restarted.reserve('/v2/insights');
    const exhausted = new FileAttemptBudget(ledger, 2);
    assert.equal(exhausted.snapshot().attempts, 2);
    assert.throws(() => exhausted.reserve('/v2/tags'), /BUDGET_EXHAUSTED_STOP/);
    assert.equal(fakeCalls, 1);
    const failedLedger = config.auditPath + '.failure-test.budget.json';
    const failed = new FileAttemptBudget(failedLedger, 2);
    const failing = createBoundedTransport({ policy: config.policy, secret: KEY, budget: failed,
      fetchImplementation: async () => { fakeCalls++; return response({}, { status: 429 }); } });
    await assert.rejects(failing.fetch(tagUrl(), INIT), /HTTP_STATUS_STOP/);
    const failedRestart = new FileAttemptBudget(failedLedger, 2);
    assert.equal(failedRestart.snapshot().stopped, true);
    const afterRestart = createBoundedTransport({ policy: config.policy, secret: KEY, budget: failedRestart,
      fetchImplementation: async () => { fakeCalls++; return response(TAG_DATA); } });
    await assert.rejects(afterRestart.fetch(tagUrl(), INIT), /SESSION_STOPPED_STOP/);
    assert.equal(fakeCalls, 2);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('rate header audit keeps only allowlisted safe integer values after reflection checks', async () => {
  const audit = [];
  const { transport } = setup(async () => response(TAG_DATA, { headers: {
    'content-type': 'application/json', 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '999',
    'x-ratelimit-reset': '999999999999999', 'ratelimit-limit': '100;w=60',
    'ratelimit-remaining': '-1', 'ratelimit-reset': '1234567890123456',
    'x-unrelated-header': 'do not log me' } }), { audit: item => audit.push(item) });
  await transport.fetch(tagUrl(), INIT);
  assert.deepEqual(audit.find(item => item.event === 'RATE_HEADERS'), {
    event: 'RATE_HEADERS', attempt: 1,
    rateHeaders: { 'x-ratelimit-limit': 1000, 'x-ratelimit-remaining': 999,
      'x-ratelimit-reset': 999999999999999 } });
  assert.deepEqual(cleanAuditRecord({ event: 'RATE_HEADERS', attempt: 1, rawBody: KEY,
    rateHeaders: { 'x-ratelimit-limit': 1000, 'ratelimit-reset': '123', 'x-unrelated': KEY } }),
    { event: 'RATE_HEADERS', attempt: 1, rateHeaders: { 'x-ratelimit-limit': 1000 } });
  const blockedAudit = [];
  const blocked = setup(async () => response(TAG_DATA, { headers: {
    'content-type': 'application/json', 'x-ratelimit-limit': '1000', 'x-key-echo': KEY } }),
    { audit: item => blockedAudit.push(item) });
  await assert.rejects(blocked.transport.fetch(tagUrl(), INIT), /SECRET_REFLECTION_STOP/);
  assert.equal(blockedAudit.some(item => item.event === 'RATE_HEADERS'), false);
});

test('default false gate rejects before a fetch or any key lookup', async () => {
  let count = 0;
  await assert.rejects(createCandidateRuntime({ policy: ACCESS_POLICY, fetchImplementation: () => { count += 1; } }),
    /FREE_ACCESS_NOT_CONFIRMED/);
  const env = new Proxy({}, { get(_target, name) {
    if (name === 'QLOO_API_KEY') throw new Error('KEY_MUST_NOT_BE_READ'); return undefined;
  } });
  assert.throws(() => parseLauncherEnvironment(env), /FREE_ACCESS_NOT_CONFIRMED/);
  assert.equal(count, 0);
});

test('pinned official tools execute the normal two-step flow with exactly two fake HTTP attempts', async () => {
  const calls = [];
  const budget = new MemoryAttemptBudget();
  const runtime = await createCandidateRuntime({ policy: POLICY, secret: KEY, budget,
    fetchImplementation: async (url, init) => {
      calls.push({ path: url.pathname, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
      return response(url.pathname === '/v2/tags' ? TAG_DATA : ENTITY_DATA);
    } });
  assert.deepEqual(runtime.tools.map(tool => tool.name), ['qloo_capabilities', 'qloo_recommend', 'qloo_find_tags']);
  assert.equal(runtime.clientOptions.maxAttempts, 1);
  const tags = await runtime.tools.find(tool => tool.name === 'qloo_find_tags').execute('tags_1',
    { query: 'science fiction', semantic: true, limit: 3 });
  assert.equal(tags.details.status, 'ok');
  assert.equal(tags.details.results[0].id, TAG);
  const recommendation = await runtime.tools.find(tool => tool.name === 'qloo_recommend').execute('recommend_1',
    { target_type: 'movie', signal_tags: [TAG], limit: 3, explain: true });
  assert.equal(recommendation.details.status, 'ok');
  assert.equal(recommendation.details.provenance.endpoint, '/v2/insights');
  assert.equal(recommendation.details.results[0].affinity, 0.75);
  assert.equal(recommendation.details.results[0].entity_id, ENTITY_DATA.results.entities[0].entity_id);
  assert.equal(calls.length, 2);
  assert.equal(runtime.transport.snapshot().attempts, 2);
  assert.equal(runtime.transport.snapshot().httpAttempts, 2);
  assert.ok(calls.every(call => call.redirect === 'error' && call.hasSignal));
  assertNoSecret(recommendation, KEY);
});

test('official client 429 stops at one attempt and never starts the next workflow', async () => {
  let count = 0;
  const runtime = await createCandidateRuntime({ policy: POLICY, secret: KEY, budget: new MemoryAttemptBudget(),
    fetchImplementation: async () => { count += 1; return response({ error: KEY }, { status: 429 }); } });
  const find = runtime.tools.find(tool => tool.name === 'qloo_find_tags');
  const result = await find.execute('tags_1', { query: 'science fiction', semantic: true, limit: 3 });
  assert.equal(result.details.error.code, 'LIVE_BOUNDARY_STOP');
  await find.execute('tags_2', { query: 'science fiction', semantic: true, limit: 3 });
  assert.equal(count, 1);
  assert.equal(runtime.transport.snapshot().httpAttempts, 1);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('actual canonical STDIO advertises only the three allowed tools without provider requests', async () => {
  let count = 0;
  const runtime = await createCandidateRuntime({ policy: POLICY, secret: KEY, budget: new MemoryAttemptBudget(),
    fetchImplementation: async () => { count += 1; return response(TAG_DATA); } });
  const input = new PassThrough(); const messages = [];
  const server = runtime.start({ input, writeOut: line => messages.push(JSON.parse(line)) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qloo_capabilities', arguments: {} } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const listed = messages.find(message => message.id === 2).result.tools.map(tool => tool.name);
  assert.deepEqual(listed, ['qloo_capabilities', 'qloo_recommend', 'qloo_find_tags']);
  const definitions = messages.find(message => message.id === 2).result.tools;
  const findSchema = definitions.find(tool => tool.name === 'qloo_find_tags').inputSchema;
  assert.deepEqual(findSchema.required, ['query', 'semantic', 'limit']);
  assert.equal(findSchema.properties.limit.maximum, 3);
  assert.equal(findSchema.properties.semantic.const, true);
  const recommendSchema = definitions.find(tool => tool.name === 'qloo_recommend').inputSchema;
  assert.deepEqual(recommendSchema.required, ['target_type', 'signal_tags', 'limit', 'explain']);
  assert.equal(recommendSchema.additionalProperties, false);
  assert.equal(recommendSchema.properties.signal_tags.maxItems, 1);
  const capabilities = messages.find(message => message.id === 3).result.structuredContent;
  assert.deepEqual(capabilities.adapter.supported_operation_ids, ['recommend', 'find_tags']);
  assert.equal(capabilities.adapter.ready, false); // Intentionally supports 2 of 9 canonical workflows.
  assert.equal(count, 0);
  server.close(); input.end();
});

test('redirect responses and redirect exceptions are terminal with no follow-up', async () => {
  for (const implementation of [async () => response({}, { status: 302, headers: { location: 'https://other.invalid' } }),
    async () => { throw new TypeError('fetch failed with ' + KEY); }]) {
    let count = 0;
    const { transport } = setup(async (...args) => { count += 1; return implementation(...args); });
    await assert.rejects(transport.fetch(tagUrl(), INIT), /_STOP/);
    await assert.rejects(transport.fetch(tagUrl(), INIT), /SESSION_STOPPED_STOP/);
    assert.equal(count, 1);
  }
});

test('one-attempt budget rejects the second workflow before native fetch', async () => {
  let count = 0;
  const { transport } = setup(async () => { count += 1; return response(TAG_DATA); },
    { budget: new MemoryAttemptBudget(1), policy: { ...POLICY, httpAttemptBudget: 1 } });
  await transport.fetch(tagUrl(), INIT);
  await assert.rejects(transport.fetch(recoUrl(), INIT), /BUDGET_EXHAUSTED_STOP/);
  assert.equal(count, 1);
  assert.equal(transport.snapshot().httpAttempts, 1);
});

test('policy and injected ledger limits must agree before any fake HTTP attempt', () => {
  let count = 0;
  assert.throws(() => setup(async () => { count += 1; return response(TAG_DATA); },
    { policy: { ...POLICY, httpAttemptBudget: 1 }, budget: new MemoryAttemptBudget(2) }), /BUDGET_POLICY_MISMATCH_STOP/);
  assert.equal(count, 0);
});

test('budget reservations survive construction of another process budget object', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qloo-candidate-budget-'));
  try {
    const path = join(directory, 'budget.private.json');
    const first = new FileAttemptBudget(path, 2); first.reserve('/v2/tags');
    const second = new FileAttemptBudget(path, 2); assert.equal(second.snapshot().attempts, 1);
    second.reserve('/v2/insights');
    assert.throws(() => first.reserve('/v2/tags'), /BUDGET_EXHAUSTED_STOP/);
    assert.throws(() => new FileAttemptBudget(path, 4), /BUDGET_LIMIT_CHANGED_STOP/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('exact origin, path, method and query prevent all invalid request variants before fetch', async () => {
  const invalid = [
    ['https://hackathon.api.qloo.com.evil.invalid/v2/tags', INIT],
    ['https://user@hackathon.api.qloo.com/v2/tags', INIT],
    ['http://hackathon.api.qloo.com/v2/tags', INIT],
    ['https://hackathon.api.qloo.com:444/v2/tags', INIT],
    [new URL('/search?query=x', ORIGIN), INIT],
    [new URL(tagUrl().href + '#fragment'), INIT],
    [new URL(tagUrl().href + '&take=3'), INIT],
    [new URL(tagUrl().href + '&extra=1'), INIT],
    [tagUrl(), { ...INIT, method: 'POST' }],
    [new Request(tagUrl()), INIT],
    [recoUrl(), INIT],
  ];
  for (const [url, init] of invalid) {
    let count = 0;
    const { transport } = setup(async () => { count += 1; return response(TAG_DATA); });
    await assert.rejects(transport.fetch(url, init), /_STOP/);
    assert.equal(count, 0);
    assert.equal(transport.snapshot().attempts, 0);
  }
});

test('timeout covers a fetch implementation that ignores the abort signal', async () => {
  const { transport } = setup(() => new Promise(() => {}), { timeoutMs: 15 });
  await assert.rejects(transport.fetch(tagUrl(), INIT), /REQUEST_TIMEOUT_STOP/);
  assert.equal(transport.snapshot().attempts, 1);
  assert.equal(transport.snapshot().httpAttempts, 1);
});

test('pinned provider cap accepts a valid recommendation above 64KiB and drops unknown fields', async () => {
  const large = { ...ENTITY_DATA, ignored_provider_metadata: { description: 'x'.repeat(128 * 1024) } };
  const runtime = await createCandidateRuntime({ policy: POLICY, secret: KEY, budget: new MemoryAttemptBudget(),
    fetchImplementation: async url => response(url.pathname === '/v2/tags' ? TAG_DATA : large) });
  await runtime.tools.find(tool => tool.name === 'qloo_find_tags').execute('large_tags',
    { query: 'science fiction', semantic: true, limit: 3 });
  const recommended = await runtime.tools.find(tool => tool.name === 'qloo_recommend').execute('large_reco',
    { target_type: 'movie', signal_tags: [TAG], limit: 1, explain: true });
  assert.equal(recommended.details.status, 'ok');
  assert.equal(recommended.details.results[0].entity_id, ENTITY_DATA.results.entities[0].entity_id);
  assert.equal(recommended.details.results[0].affinity, 0.75);
  assert.equal(JSON.stringify(recommended).includes('ignored_provider_metadata'), false);
  assert.ok(JSON.stringify(recommended).length < 65536);
  assert.equal(MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(runtime.clientOptions.maxResponseBytes, MAX_BYTES);
  assert.equal(runtime.transport.snapshot().httpAttempts, 2);
});

test('generic entity type requires the selected subtype and preserves both returned fields', async () => {
  // Synthetic IDs and labels only; structure observed in a private response.
  for (const [type, subtype, accepted] of [
    ['urn:entity', 'urn:entity:movie', true],
    ['urn:entity:movie', 'urn:entity:movie', true],
    ['urn:entity:movie', undefined, true],
    ['urn:entity', undefined, false],
    ['urn:entity', 'urn:entity:book', false],
    ['urn:entity:movie', 'urn:entity:book', false],
  ]) {
    const row = { entity_id: '12345678-1234-1234-9234-123456789abc',
      name: 'Synthetic typed movie fixture', type, ...(subtype === undefined ? {} : { subtype }) };
    const runtime = await createCandidateRuntime({ policy: POLICY, secret: KEY, budget: new MemoryAttemptBudget(),
      fetchImplementation: async url => response(url.pathname === '/v2/tags' ? TAG_DATA : { results: { entities: [row] } }) });
    await runtime.tools.find(tool => tool.name === 'qloo_find_tags').execute('typed_tags',
      { query: 'science fiction', semantic: true, limit: 3 });
    const result = await runtime.tools.find(tool => tool.name === 'qloo_recommend').execute('typed_reco',
      { target_type: 'movie', signal_tags: [TAG], limit: 1, explain: true });
    assert.equal(result.details.status, accepted ? 'ok' : 'error');
    if (accepted) {
      assert.equal(result.details.results[0].type, type);
      assert.equal(result.details.results[0].subtype, subtype);
    } else assert.equal(runtime.transport.snapshot().stopped, true);
    assert.equal(runtime.transport.snapshot().httpAttempts, 2);
  }
});

test('stream bytes are bounded at the provider cap with numeric-only length audit', async () => {
  const base = JSON.stringify({ ...TAG_DATA, padding: '' });
  for (const size of [MAX_BYTES, MAX_BYTES + 1]) {
    const body = JSON.stringify({ ...TAG_DATA, padding: 'x'.repeat(size - Buffer.byteLength(base)) });
    const audit = [];
    const { transport } = setup(async () => response(body), { audit: record => audit.push(record) });
    if (size === MAX_BYTES) assert.ok((await transport.fetch(tagUrl(), INIT)).ok);
    else await assert.rejects(transport.fetch(tagUrl(), INIT), /RESPONSE_SIZE_STOP/);
    assert.deepEqual(audit.find(record => record.event === 'LENGTH'), { event: 'LENGTH', attempt: 1, readBytes: size });
  }
  const audit = [];
  const { transport } = setup(async () => response(JSON.stringify(TAG_DATA),
    { headers: { 'content-type': 'application/json', 'content-length': String(MAX_BYTES + 1) } }),
    { audit: record => audit.push(record) });
  await assert.rejects(transport.fetch(tagUrl(), INIT), /RESPONSE_SIZE_STOP/);
  assert.deepEqual(audit.find(record => record.event === 'LENGTH'), {
    event: 'LENGTH', attempt: 1, contentLength: MAX_BYTES + 1, readBytes: 0 });
  const misleadingAudit = [];
  const tooLarge = JSON.stringify({ ...TAG_DATA, padding: 'x'.repeat(MAX_BYTES + 1 - Buffer.byteLength(base)) });
  const misleading = setup(async () => response(tooLarge, {
    headers: { 'content-type': 'application/json', 'content-length': '1' } }),
    { audit: record => misleadingAudit.push(record) });
  await assert.rejects(misleading.transport.fetch(tagUrl(), INIT), /RESPONSE_SIZE_STOP/);
  assert.deepEqual(misleadingAudit.find(record => record.event === 'LENGTH'), {
    event: 'LENGTH', attempt: 1, contentLength: 1, readBytes: MAX_BYTES + 1 });
  assert.deepEqual(cleanAuditRecord({ event: 'LENGTH', attempt: 1, contentLength: 100,
    readBytes: 120, rawHeader: KEY, body: KEY }), {
    event: 'LENGTH', attempt: 1, contentLength: 100, readBytes: 120 });
});

test('reflected key in bodies, nested encoded JSON, headers or exceptions never reaches output', async () => {
  for (const fake of [
    async () => response({ ...TAG_DATA, debug: KEY }),
    async () => response({ ...TAG_DATA, debug: JSON.stringify({ key: KEY }) }),
    async () => response(TAG_DATA, { headers: { 'content-type': 'application/json', 'x-debug': KEY } }),
    async () => { throw new Error(KEY); },
  ]) {
    const audit = [];
    const { transport } = setup(fake, { audit: row => audit.push(row) });
    try { await transport.fetch(tagUrl(), INIT); assert.fail('must stop'); }
    catch (error) { assert.equal(error.message.includes(KEY), false); }
    assert.equal(JSON.stringify(audit).includes(KEY), false);
    assert.equal(transport.snapshot().attempts, 1);
  }
});

test('uppercase STOP-shaped upstream exceptions cannot inject raw key-shaped audit codes', async () => {
  const secret = 'SYNTHETIC_SECRET_STOP'; const audit = [];
  const transport = createBoundedTransport({ policy: POLICY, secret, budget: new MemoryAttemptBudget(),
    fetchImplementation: async () => { throw new Error(secret); }, audit: row => audit.push(row) });
  await assert.rejects(transport.fetch(tagUrl(), { method: 'GET', headers: { 'X-Api-Key': secret } }), /UPSTREAM_FAILURE_STOP/);
  assert.equal(JSON.stringify(audit).includes(secret), false);
});

test('a percent-encoded key in a decoded query is rejected before request reservation', async () => {
  const secret = 'SYNTHETIC KEY?'; let count = 0;
  const transport = createBoundedTransport({ policy: POLICY, secret, budget: new MemoryAttemptBudget(),
    fetchImplementation: async () => { count += 1; return response(TAG_DATA); } });
  const url = tagUrl(); url.searchParams.set('filter.query', secret);
  await assert.rejects(transport.fetch(url, { method: 'GET', headers: { 'X-Api-Key': secret } }), /SECRET_REFLECTION_STOP/);
  assert.equal(count, 0);
  assert.equal(transport.snapshot().attempts, 0);
});

test('invalid JSON, non-JSON and error-shaped 200 responses stop without a synthetic fallback', async () => {
  for (const fake of [async () => response('{bad'),
    async () => response(TAG_DATA, { headers: { 'content-type': 'text/html' } }),
    async () => response({ error: 'provider error', results: { tags: [] } })]) {
    const { transport } = setup(fake);
    await assert.rejects(transport.fetch(tagUrl(), INIT), /_STOP/);
    assert.equal(transport.snapshot().stopped, true);
  }
});

test('expired access is rejected again at request time', async () => {
  const policy = { ...POLICY };
  let count = 0;
  const { transport } = setup(async () => { count += 1; return response(TAG_DATA); }, { policy });
  policy.expiresAt = '2000-01-01T00:00:00Z';
  await assert.rejects(transport.fetch(tagUrl(), INIT), /UPSTREAM_FAILURE_STOP/);
  assert.equal(count, 0);
});

after(() => { assert.equal(networkGuard.attempts, 0); });

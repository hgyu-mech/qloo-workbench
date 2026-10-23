// Node 24.19 fetch/AbortController: https://nodejs.org/download/release/v24.19.0/docs/api/globals.html
import { requireAccess } from './access-policy.mjs';

export const ORIGIN = 'https://hackathon.api.qloo.com';
// Pinned @qloo/qloo-harness 0.1.26 QlooClient default, not an unbounded body.
export const MAX_BYTES = 5 * 1024 * 1024;
export const RATE_HEADER_NAMES = Object.freeze(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TAG = /^urn:tag:[A-Za-z0-9:._-]{1,240}$/;
const STOP_CODES = new Set(['RESPONSE_DEPTH_STOP', 'SECRET_REFLECTION_STOP', 'REQUEST_URL_STOP',
  'REQUEST_BOUNDARY_STOP', 'REQUEST_QUERY_STOP', 'UNVERIFIED_TAG_STOP', 'PROVIDER_SCHEMA_STOP',
  'TRANSPORT_CONFIGURATION_STOP', 'SESSION_STOPPED_STOP', 'CONCURRENT_REQUEST_STOP', 'WORKFLOW_ORDER_STOP',
  'AUTH_HEADER_STOP', 'CORRELATION_ID_STOP', 'REQUEST_TIMEOUT_STOP', 'REQUEST_ABORTED_STOP',
  'REDIRECT_STOP', 'HTTP_STATUS_STOP', 'CONTENT_TYPE_STOP', 'RESPONSE_SIZE_STOP', 'PROVIDER_JSON_STOP',
  'BUDGET_EXHAUSTED_STOP', 'BUDGET_STORAGE_STOP', 'BUDGET_POLICY_MISMATCH_STOP', 'UPSTREAM_FAILURE_STOP', 'PRIVATE_CAPTURE_STOP']);
const normalize = value => value.normalize('NFKC').toLowerCase();

export function assertNoSecret(value, secret, depth = 0) {
  // Canonical MCP content contains JSON text inside a structured tool result.
  if (depth > 16) throw new Error('RESPONSE_DEPTH_STOP');
  if (typeof value === 'string') {
    if (secret && normalize(value).includes(normalize(secret))) throw new Error('SECRET_REFLECTION_STOP');
    if (/^\s*[\[{]/.test(value)) {
      let nested;
      try { nested = JSON.parse(value); } catch { return; }
      assertNoSecret(nested, secret, depth + 1);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoSecret(item, secret, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoSecret(key, secret, depth + 1); assertNoSecret(item, secret, depth + 1);
    }
  }
}

function text(value, max = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\p{C}<>]/u.test(value) && !/https?:\/\//i.test(value);
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function fail(code) { throw new Error(code); }

export function boundedInputSchema(name) {
  const limit = { type: 'integer', minimum: 1, maximum: 3 };
  if (name === 'qloo_find_tags') return { type: 'object', additionalProperties: false,
    required: ['query', 'semantic', 'limit'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 80 }, semantic: { const: true }, limit } };
  if (name === 'qloo_recommend') return { type: 'object', additionalProperties: false,
    required: ['target_type', 'signal_tags', 'limit', 'explain'], properties: {
      target_type: { type: 'string', enum: ['movie', 'book', 'artist'] },
      signal_tags: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', pattern: TAG.source } },
      limit, explain: { const: true } } };
  return { type: 'object', properties: {}, additionalProperties: false };
}

export function validateToolArguments(name, args) {
  if (name === 'qloo_find_tags') {
    if (!exactKeys(args, ['query', 'semantic', 'limit']) || !text(args.query, 80)
        || args.semantic !== true || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 3) fail('TOOL_ARGUMENTS_STOP');
    return;
  }
  if (name === 'qloo_recommend') {
    if (!exactKeys(args, ['target_type', 'signal_tags', 'limit', 'explain'])
        || !['movie', 'book', 'artist'].includes(args.target_type)
        || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 3
        || args.explain !== true || !Array.isArray(args.signal_tags) || args.signal_tags.length !== 1
        || typeof args.signal_tags[0] !== 'string' || !TAG.test(args.signal_tags[0])) fail('TOOL_ARGUMENTS_STOP');
    return;
  }
  fail('TOOL_NOT_ALLOWED_STOP');
}

function validateUrl(input, init, seenTags) {
  if (!(typeof input === 'string' || input instanceof URL)) fail('REQUEST_URL_STOP');
  let url;
  try { url = new URL(input); } catch { fail('REQUEST_URL_STOP'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash
      || !['/v2/tags', '/v2/insights'].includes(url.pathname)
      || init?.method !== 'GET' || init.body !== undefined) fail('REQUEST_BOUNDARY_STOP');
  const expected = url.pathname === '/v2/tags'
    ? ['filter.query', 'feature.semantic_search', 'take']
    : ['filter.type', 'signal.interests.tags', 'operator.signal.interests.tags', 'feature.explainability', 'take'];
  const entries = [...url.searchParams];
  if (entries.length !== expected.length || expected.some(key => url.searchParams.getAll(key).length !== 1)
      || entries.some(([key]) => !expected.includes(key)) || !/^[1-3]$/.test(url.searchParams.get('take'))) fail('REQUEST_QUERY_STOP');
  if (url.pathname === '/v2/tags') {
    if (!text(url.searchParams.get('filter.query'), 80) || url.searchParams.get('feature.semantic_search') !== 'true') fail('REQUEST_QUERY_STOP');
  } else if (!['urn:entity:movie', 'urn:entity:book', 'urn:entity:artist'].includes(url.searchParams.get('filter.type'))
      || url.searchParams.get('operator.signal.interests.tags') !== 'intersection'
      || url.searchParams.get('feature.explainability') !== 'true'
      || !seenTags.has(url.searchParams.get('signal.interests.tags'))) fail('UNVERIFIED_TAG_STOP');
  return url;
}

function projectPayload(value, path, selectedType, limit) {
  if (!value || typeof value !== 'object' || value.error !== undefined || value.errors !== undefined) fail('PROVIDER_SCHEMA_STOP');
  const key = path === '/v2/tags' ? 'tags' : 'entities';
  const rows = Array.isArray(value.results) ? value.results : value.results?.[key];
  if (!Array.isArray(rows) || rows.length > limit) fail('PROVIDER_SCHEMA_STOP');
  const ids = new Set();
  const projected = rows.map(row => {
    if (!row || typeof row !== 'object' || !text(row.name)) fail('PROVIDER_SCHEMA_STOP');
    const id = key === 'tags' ? row.id ?? row.tag_id : row.entity_id ?? row.id;
    if (typeof id !== 'string' || !(key === 'tags' ? TAG : UUID).test(id) || ids.has(id)) fail('PROVIDER_SCHEMA_STOP');
    ids.add(id);
    if (key === 'entities') {
      // Official response example uses generic type plus the concrete subtype:
      // https://github.com/qloo/docs-public/blob/main/reference/basic-insights-use-case.md
      if (row.type === 'urn:entity') {
        if (row.subtype !== selectedType) fail('PROVIDER_SCHEMA_STOP');
      } else if (row.type !== undefined && row.type !== selectedType) fail('PROVIDER_SCHEMA_STOP');
      if (row.subtype !== undefined && row.subtype !== selectedType) fail('PROVIDER_SCHEMA_STOP');
    }
    const output = key === 'tags' ? { id, name: row.name } : { entity_id: id, name: row.name };
    for (const field of ['type', 'subtype']) {
      if (row[field] !== undefined) {
        if (!text(row[field], 128)) fail('PROVIDER_SCHEMA_STOP');
        output[field] = row[field];
      }
    }
    const affinity = row.affinity ?? row.query?.affinity;
    if (affinity !== undefined) {
      if (typeof affinity !== 'number' || !Number.isFinite(affinity)) fail('PROVIDER_SCHEMA_STOP');
      output.affinity = affinity;
    }
    return output;
  });
  // Raw metadata, URLs, descriptions and arbitrary explainability do not cross this candidate boundary.
  return { results: { [key]: projected } };
}

export function createBoundedTransport({ policy, secret, fetchImplementation, budget, timeoutMs = 15000,
  audit = () => {}, captureValidatedPayload }) {
  requireAccess(policy);
  if (typeof secret !== 'string' || !secret || typeof fetchImplementation !== 'function'
      || !budget || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
      || (captureValidatedPayload !== undefined && typeof captureValidatedPayload !== 'function')) fail('TRANSPORT_CONFIGURATION_STOP');
  if (budget.snapshot().limit !== policy.httpAttemptBudget) fail('BUDGET_POLICY_MISMATCH_STOP');
  const seenTags = new Set();
  let inFlight = false;
  let stopped = false;
  let completedStages = 0;
  let httpAttempts = 0;
  const stop = () => { stopped = true; budget.stop(); };
  async function boundedFetch(input, init = {}) {
    let timer;
    let reader;
    let controller;
    let contentLength;
    let total = 0;
    let lengthReady = false;
    try {
      requireAccess(policy);
      if (stopped || budget.snapshot().stopped) fail('SESSION_STOPPED_STOP');
      if (budget.snapshot().limit !== policy.httpAttemptBudget) fail('BUDGET_POLICY_MISMATCH_STOP');
      if (budget.snapshot().attempts >= policy.httpAttemptBudget) fail('BUDGET_EXHAUSTED_STOP');
      if (inFlight) fail('CONCURRENT_REQUEST_STOP');
      const url = validateUrl(input, init, seenTags);
      if ((completedStages === 0 && url.pathname !== '/v2/tags')
          || (completedStages === 1 && url.pathname !== '/v2/insights') || completedStages > 1) fail('WORKFLOW_ORDER_STOP');
      const incomingHeaders = new Headers(init.headers);
      if (incomingHeaders.get('x-api-key') !== secret) fail('AUTH_HEADER_STOP');
      const correlation = incomingHeaders.get('x-correlation-id');
      if (correlation && !/^[A-Za-z0-9_-]{1,64}$/.test(correlation)) fail('CORRELATION_ID_STOP');
      assertNoSecret(url.toString(), secret);
      assertNoSecret([...url.searchParams], secret);
      if (correlation) assertNoSecret(correlation, secret);
      budget.reserve(url.pathname);
      audit({ event: 'ATTEMPT_RESERVED', attempt: budget.snapshot().attempts });
      inFlight = true;
      controller = new AbortController();
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('REQUEST_TIMEOUT_STOP')); }, timeoutMs);
      });
      const operation = (async () => {
        httpAttempts += 1;
        const response = await fetchImplementation(url, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal,
          headers: { Accept: 'application/json', 'X-Api-Key': secret,
                     ...(correlation ? { 'X-Correlation-Id': correlation } : {}) },
        });
        if (stopped || signal.aborted) fail('REQUEST_ABORTED_STOP');
        audit({ event: 'HTTP_STATUS', attempt: budget.snapshot().attempts, status: response.status });
        if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) fail('REDIRECT_STOP');
        if (response.status >= 300 && response.status < 400) fail('REDIRECT_STOP');
        if (response.status !== 200) fail('HTTP_STATUS_STOP');
        for (const value of response.headers.values()) assertNoSecret(value, secret);
        const rateHeaders = {};
        for (const name of RATE_HEADER_NAMES) {
          const value = response.headers.get(name);
          if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value) && Number.isSafeInteger(Number(value))) {
            rateHeaders[name] = Number(value);
          }
        }
        // Raw numeric provider hints only: no inference of period, unit,
        // monthly balance, expiry or permission to spend beyond this session.
        audit({ event: 'RATE_HEADERS', attempt: budget.snapshot().attempts, rateHeaders });
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('CONTENT_TYPE_STOP');
        const length = response.headers.get('content-length');
        lengthReady = true;
        if (length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) contentLength = Number(length);
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail('RESPONSE_SIZE_STOP');
        if (!response.body) fail('PROVIDER_SCHEMA_STOP');
        reader = response.body.getReader();
        const chunks = [];
        for (;;) {
          const item = await reader.read();
          if (stopped || signal.aborted) fail('REQUEST_ABORTED_STOP');
          if (item.done) break;
          total += item.value.byteLength;
          if (total > MAX_BYTES) fail('RESPONSE_SIZE_STOP');
          chunks.push(item.value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail('PROVIDER_JSON_STOP'); }
        assertNoSecret(payload, secret);
        // Trusted host callback only. The complete decoded payload (including
        // object keys) has passed reflection checks; no HTTP headers are passed.
        if (captureValidatedPayload) {
          try { await captureValidatedPayload(url.pathname, payload); }
          catch { fail('PRIVATE_CAPTURE_STOP'); }
        }
        const projected = projectPayload(payload, url.pathname, url.searchParams.get('filter.type'), Number(url.searchParams.get('take')));
        if (url.pathname === '/v2/tags') {
          for (const row of projected.results.tags) seenTags.add(row.id);
          if (seenTags.size === 0) stop();
        }
        completedStages += 1;
        return new Response(JSON.stringify(projected), { status: 200, headers: { 'content-type': 'application/json' } });
      })();
      return await Promise.race([operation, timeout]);
    } catch (error) {
      stop();
      const code = STOP_CODES.has(error?.message) && !normalize(error.message).includes(normalize(secret))
        ? error.message : 'UPSTREAM_FAILURE_STOP';
      try { audit({ event: 'STOP', attempt: budget.snapshot().attempts, code }); } catch {}
      throw new Error(code);
    } finally {
      if (lengthReady) {
        // Only numerical size evidence is retained; no body/header text.
        const lengthRecord = { event: 'LENGTH', attempt: budget.snapshot().attempts, readBytes: total };
        if (contentLength !== undefined) lengthRecord.contentLength = contentLength;
        try { audit(lengthRecord); } catch {}
      }
      clearTimeout(timer);
      controller?.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
      inFlight = false;
    }
  }
  return { fetch: boundedFetch, stop, snapshot: () => ({ ...budget.snapshot(), httpAttempts }) };
}

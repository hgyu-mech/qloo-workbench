// Public launcher contract; default is disabled. Parent owns access verification.
import { appendFileSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requireAccess, REVIEW_BASIS, COST_CERTAINTY, REVIEW_FACTS } from './access-policy.mjs';
import { FileAttemptBudget } from './attempt-budget.mjs';
import { createCandidateRuntime } from './canonical-live-entry.mjs';
import { ORIGIN, RATE_HEADER_NAMES } from './bounded-transport.mjs';

export function cleanAuditRecord(record) {
  if (!['ATTEMPT_RESERVED', 'HTTP_STATUS', 'RATE_HEADERS', 'LENGTH', 'STOP'].includes(record.event)
      || !Number.isInteger(record.attempt) || record.attempt < 0 || record.attempt > 4) {
    throw new Error('AUDIT_RECORD_STOP');
  }
  const clean = { event: record.event, attempt: record.attempt };
  if (Number.isInteger(record.status)) clean.status = record.status;
  if (typeof record.code === 'string' && /^[A-Z_]+_STOP$/.test(record.code)) clean.code = record.code;
  if (record.event === 'RATE_HEADERS') {
    clean.rateHeaders = {};
    for (const name of RATE_HEADER_NAMES) {
      const value = record.rateHeaders?.[name];
      if (Number.isSafeInteger(value) && value >= 0 && value <= 999999999999999) clean.rateHeaders[name] = value;
    }
  }
  if (record.event === 'LENGTH') {
    for (const name of ['contentLength', 'readBytes']) {
      const value = record[name];
      if (Number.isSafeInteger(value) && value >= 0) clean[name] = value;
    }
  }
  return clean;
}

export function parseLauncherEnvironment(env) {
  const budget = Number(env.QLOO_MAX_HTTP_ATTEMPTS);
  let policy = { enabled: true, freeAccessConfirmed: true,
    evidenceReference: 'private-policy-validated-by-parent',
    expiresAt: env.QLOO_FREE_ACCESS_EXPIRES_AT, httpAttemptBudget: budget };
  if (env.QLOO_ACCESS_BASIS !== undefined) {
    if (env.QLOO_ACCESS_BASIS !== REVIEW_BASIS || env.QLOO_FREE_ACCESS_CONFIRMED !== undefined
        || env.QLOO_COST_CERTAINTY !== COST_CERTAINTY) throw new Error('REVIEWED_EVENT_ACCESS_STOP');
    policy = { ...policy, accessBasis: REVIEW_BASIS, freeAccessConfirmed: false,
      costCertainty: env.QLOO_COST_CERTAINTY, reviewedAt: env.QLOO_REVIEWED_AT,
      reviewRecordSha256: env.QLOO_REVIEW_RECORD_SHA256,
      ...Object.fromEntries(Object.entries(REVIEW_FACTS).map(([name, variable]) => [name, env[variable] === 'yes'])) };
  } else if (env.QLOO_FREE_ACCESS_CONFIRMED !== 'yes') throw new Error('FREE_ACCESS_NOT_CONFIRMED');
  requireAccess(policy);
  if (policy.accessBasis !== REVIEW_BASIS && env.QLOO_PRIVATE_RESPONSE_DIRECTORY !== undefined) {
    throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
  }
  if (!isAbsolute(env.QLOO_HARNESS_DIR ?? '') || !isAbsolute(env.QLOO_TRANSPORT_AUDIT ?? '')
      || env.QLOO_BASE_URL !== ORIGIN || env.QLOO_TRUSTED_BASE_URL !== ORIGIN) throw new Error('LAUNCHER_CONFIGURATION_STOP');
  let policyDirectory;
  let captureDirectory;
  if (policy.accessBasis === REVIEW_BASIS) {
    if (!isAbsolute(env.QLOO_POLICY_DIRECTORY ?? '') || !isAbsolute(env.QLOO_REVIEW_RECORD_PATH ?? '')) {
      throw new Error('REVIEW_RECORD_BOUNDARY_STOP');
    }
    const directory = realpathSync(env.QLOO_POLICY_DIRECTORY);
    const recordPath = realpathSync(env.QLOO_REVIEW_RECORD_PATH);
    const within = relative(directory, recordPath);
    if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)
        || !statSync(recordPath).isFile() || statSync(recordPath).size < 1 || statSync(recordPath).size > 65536) {
      throw new Error('REVIEW_RECORD_BOUNDARY_STOP');
    }
    const digest = createHash('sha256').update(readFileSync(recordPath)).digest('hex');
    const expectedAudit = resolve(directory, 'reviewed-event-' + digest + '.http-attempts.private.jsonl');
    if (digest !== policy.reviewRecordSha256 || resolve(env.QLOO_TRANSPORT_AUDIT) !== expectedAudit) {
      throw new Error('REVIEW_RECORD_BINDING_STOP');
    }
    policyDirectory = directory;
    if (env.QLOO_PRIVATE_RESPONSE_DIRECTORY !== undefined) {
      const expectedCapture = resolve(directory, 'private', 'responses-' + digest);
      if (!isAbsolute(env.QLOO_PRIVATE_RESPONSE_DIRECTORY)
          || resolve(env.QLOO_PRIVATE_RESPONSE_DIRECTORY) !== expectedCapture) throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
      captureDirectory = expectedCapture;
    }
  }
  return { policy, harnessRoot: pathToFileURL(env.QLOO_HARNESS_DIR.replace(/[\\/]$/, '') + '/'),
           auditPath: env.QLOO_TRANSPORT_AUDIT, policyDirectory, captureDirectory };
}

export function createPrivatePayloadCapture(config) {
  if (config.captureDirectory === undefined) return undefined;
  requireAccess(config.policy);
  if (config.policy.accessBasis !== REVIEW_BASIS || !isAbsolute(config.policyDirectory ?? '')) {
    throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
  }
  const directory = realpathSync(config.policyDirectory);
  const privateDirectory = resolve(directory, 'private');
  const expected = resolve(privateDirectory, 'responses-' + config.policy.reviewRecordSha256);
  if (resolve(config.captureDirectory) !== expected) throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  if (realpathSync(privateDirectory) !== privateDirectory) throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
  mkdirSync(expected, { recursive: true, mode: 0o700 });
  if (realpathSync(expected) !== expected) throw new Error('PRIVATE_CAPTURE_BOUNDARY_STOP');
  return (path, payload) => {
    try {
      if (realpathSync(privateDirectory) !== privateDirectory || realpathSync(expected) !== expected) throw Error();
      const name = path === '/v2/tags' ? 'tags' : path === '/v2/insights' ? 'insights' : null;
      if (!name) throw Error();
      const bytes = Buffer.from(JSON.stringify(payload));
      const metadata = { schema: 'qloo-private-decoded-payload-v1', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      writeFileSync(resolve(expected, name + '.json'), bytes, { flag: 'wx', mode: 0o600 });
      writeFileSync(resolve(expected, name + '.meta.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    } catch { throw new Error('PRIVATE_CAPTURE_STOP'); }
  };
}

export async function main(env = process.env) {
  // No key read and no file creation before this gate succeeds.
  const config = parseLauncherEnvironment(env);
  const captureValidatedPayload = createPrivatePayloadCapture(config);
  const secret = env.QLOO_API_KEY;
  const budget = new FileAttemptBudget(config.auditPath + '.budget.json', config.policy.httpAttemptBudget);
  const audit = record => {
    // Fixed enum/code and numeric values only. No URL/query/body/header/key.
    const clean = cleanAuditRecord(record);
    appendFileSync(config.auditPath, JSON.stringify(clean) + '\n', { mode: 0o600 });
  };
  const runtime = await createCandidateRuntime({ ...config, secret, budget, audit, captureValidatedPayload,
                                                fetchImplementation: globalThis.fetch.bind(globalThis) });
  return runtime.start();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) { process.stderr.write('QLOO_LAUNCHER_ARGUMENTS_STOP\n'); process.exitCode = 1; }
  else { main().catch(() => { process.stderr.write('QLOO_LIVE_CANDIDATE_DISABLED_OR_STOPPED\n'); process.exitCode = 1; }); }
}

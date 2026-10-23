// Version-bound candidate; NOT activated and never reads a credential itself.
// Official workflow: https://github.com/qloo/qloo-hackathon-kit/tree/main/starter/mcp-client
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ACCESS_POLICY, requireAccess } from './access-policy.mjs';
import { createBoundedTransport, validateToolArguments, boundedInputSchema, assertNoSecret, ORIGIN, MAX_BYTES } from './bounded-transport.mjs';

const DEFAULT_HARNESS = process.env.QLOO_HARNESS_DIR
  ? pathToFileURL(process.env.QLOO_HARNESS_DIR.replace(/[\\/]+$/, '') + '/')
  : new URL('../node_modules/@qloo/qloo-harness/', import.meta.url);
export async function createCandidateRuntime({ policy = ACCESS_POLICY, secret, fetchImplementation, budget,
                                              harnessRoot = DEFAULT_HARNESS, timeoutMs = 15000, audit,
                                              captureValidatedPayload } = {}) {
  // Gate BEFORE imports, env/key lookup, budget creation or any provider operation.
  requireAccess(policy);
  const metadata = JSON.parse(await readFile(new URL('package.json', harnessRoot), 'utf8'));
  if (metadata.name !== '@qloo/qloo-harness' || metadata.version !== '0.1.26') throw new Error('PINNED_RUNTIME_CHANGED');
  const [{ QlooClient }, { createQlooTools }, { startCanonicalMcpServer }] = await Promise.all([
    import(new URL('dist/chunks/chunk-ESNY4EJL.js', harnessRoot)),
    import(new URL('dist/qloo-tools.js', harnessRoot)),
    import(new URL('dist/mcp.js', harnessRoot)),
  ]);
  const transport = createBoundedTransport({ policy, secret, fetchImplementation, budget, timeoutMs, audit,
                                            captureValidatedPayload });
  const client = new QlooClient({ apiKey: secret, baseUrl: ORIGIN, allowCustomBaseUrl: true,
    maxAttempts: 1, timeoutMs, maxResponseBytes: MAX_BYTES, fetch: transport.fetch });
  const allowedNames = new Set(['qloo_capabilities', 'qloo_find_tags', 'qloo_recommend']);
  const tools = createQlooTools({ client }).filter(tool => allowedNames.has(tool.name)).map(tool => {
    if (tool.name === 'qloo_capabilities') return tool;
    return { ...tool, async execute(id, args, ...rest) {
      try {
        validateToolArguments(tool.name, args);
        const output = await tool.execute(id, args, ...rest);
        assertNoSecret(output, secret);
        const result = output.details;
        if (!['ok', 'empty'].includes(result?.status)) throw new Error('WORKFLOW_RESULT_STOP');
        return output;
      } catch {
        transport.stop();
        const result = { schema_version: '1.0-preview.1', operation: tool.name.slice(5), status: 'error',
          summary: 'This Qloo workflow stopped without an automatic fallback.', results: [], result_count: 0,
          error: { code: 'LIVE_BOUNDARY_STOP', layer: 'product', retryable: false,
                   recovery: 'Inspect the private attempt receipt before authorizing another workflow.' },
          execution: { transport: 'direct', transport_name: 'Qloo bounded candidate',
                       correlation_id: /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'local', duration_ms: 0 } };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
    } };
  });
  return { tools, transport, clientOptions: { maxAttempts: 1, timeoutMs, maxResponseBytes: MAX_BYTES },
    start(options = {}) {
      const writeOut = options.writeOut ?? (line => process.stdout.write(line));
      const filteredOutput = line => {
        try {
          const message = JSON.parse(line);
          if (Array.isArray(message.result?.tools)) {
            message.result = { tools: message.result.tools.filter(tool => allowedNames.has(tool.name))
              .map(tool => ({ ...tool, inputSchema: boundedInputSchema(tool.name) })) };
          }
          assertNoSecret(message, secret);
          writeOut(JSON.stringify(message) + '\n');
        } catch {
          transport.stop();
          writeOut(JSON.stringify({ jsonrpc: '2.0', id: null,
            error: { code: -32603, message: 'LIVE_OUTPUT_BOUNDARY_STOP' } }) + '\n');
        }
      };
      return startCanonicalMcpServer({ ...options, tools, env: {}, serverVersion: '0.1.26', writeOut: filteredOutput });
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Real activation/credential launcher intentionally absent while access conditions remain unconfirmed.
  try { requireAccess(ACCESS_POLICY); throw new Error('ACTIVATION_LAUNCHER_NOT_IMPLEMENTED'); }
  catch { process.stderr.write('Qloo candidate disabled: free access and activation are not confirmed.\n'); process.exitCode = 1; }
}

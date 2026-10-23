// Offline test process only. Never imports the live entry with an enabled policy.
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
export const networkGuard = { attempts: 0 };
const deny = () => { networkGuard.attempts += 1; throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
for (const [name, keys] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:http2', ['connect']], ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']], ['node:dgram', ['createSocket']],
]) { const value = require(name); for (const key of keys) value[key] = deny; }
require('node:net').Socket.prototype.connect = deny;
const dns = require('node:dns');
for (const name of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = deny;
for (const name of Object.keys(dns.promises)) if (typeof dns.promises[name] === 'function') dns.promises[name] = deny;
globalThis.fetch = deny;
globalThis.WebSocket = deny;
syncBuiltinESMExports();

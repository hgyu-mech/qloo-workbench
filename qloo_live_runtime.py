"""Private access-policy gate and a portable client for the pinned Qloo MCP.

Policy records describe a reviewed access basis, not provider billing controls.
The reviewed-event schema records an inference, never a no-overage guarantee.
No key is read and no child is started before the policy gate passes.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
from urllib.parse import urlsplit


REVIEW_BASIS = 'event-entitlement-no-price-notice'
COST_CERTAINTY = 'inferred-not-provider-guarantee'
REVIEW_FACTS = {
    'eventKeyIssued': 'QLOO_EVENT_KEY_ISSUED',
    'userZeroSpendAuthorized': 'QLOO_USER_ZERO_SPEND_AUTHORIZED',
    'noFeeNoticeInIssuance': 'QLOO_NO_FEE_NOTICE_IN_ISSUANCE',
    'noPaymentFieldsInIssuanceForm': 'QLOO_NO_PAYMENT_FIELDS_IN_ISSUANCE_FORM',
    'noPaidConversion': 'QLOO_NO_PAID_CONVERSION',
}


class LiveAccessError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load_access_policy(path, *, now=None):
    try:
        raw = Path(path).read_bytes()
        if len(raw) > 8192:
            raise ValueError()
        record = json.loads(raw)
        common = {'schema', 'providerEvidence', 'verifiedAt', 'validUntil',
                  'maxHttpAttempts', 'monthlyQuota', 'rateLimitPerSecond', 'providerExactExpiry'}
        if type(record) is not dict:
            raise ValueError()
        reviewed_event = record.get('schema') == 'qloo-reviewed-event-v2'
        if reviewed_event:
            allowed = common | {'reviewBasis', 'costCertainty', 'reviewRecord'} | set(REVIEW_FACTS)
            if (set(record) != allowed or record['reviewBasis'] != REVIEW_BASIS
                    or record['costCertainty'] != COST_CERTAINTY
                    or any(record[name] is not True for name in REVIEW_FACTS)
                    or type(record['maxHttpAttempts']) is not int
                    or record['maxHttpAttempts'] != 2):
                raise ValueError()
        elif (set(record) != common | {'complimentaryConfirmed', 'noOverageChargesConfirmed'}
              or record.get('schema') != 'qloo-event-access-v1'
              or record['complimentaryConfirmed'] is not True
              or record['noOverageChargesConfirmed'] is not True
              or type(record['maxHttpAttempts']) is not int
              or not 1 <= record['maxHttpAttempts'] <= 4):
            raise ValueError()
        evidence = record['providerEvidence']
        if type(evidence) is not str or len(evidence) > 500:
            raise ValueError()
        url = urlsplit(evidence)
        trusted = (url.scheme == 'https' and url.port in (None, 443)
                   and not url.username and not url.password
                   and not url.query and not url.fragment
                   and (url.hostname in {'docs.qloo.com', 'www.qloo.com', 'qloo.devpost.com'}
                        or (url.hostname == 'github.com' and url.path.startswith('/qloo/'))))
        if not trusted:
            raise ValueError()
        clock = now or datetime.datetime.now(datetime.timezone.utc)
        expiry = datetime.datetime.fromisoformat(record['validUntil'])
        verified = datetime.datetime.fromisoformat(record['verifiedAt'])
        if (expiry.tzinfo is None or verified.tzinfo is None
                or expiry <= clock or verified > clock or verified >= expiry):
            raise ValueError()
        if reviewed_event and expiry - verified > datetime.timedelta(minutes=30):
            raise ValueError()
        for name in ('monthlyQuota', 'rateLimitPerSecond'):
            value = record[name]
            if value is not None and (type(value) is not int or value <= 0):
                raise ValueError()
        # An unpublished provider expiry can remain null; validUntil is a
        # conservative local cutoff backed by the supplied evidence.
        if record['providerExactExpiry'] is not None:
            provider_expiry = datetime.datetime.fromisoformat(record['providerExactExpiry'])
            if provider_expiry.tzinfo is None or expiry > provider_expiry:
                raise ValueError()
        if reviewed_event:
            review = record['reviewRecord']
            if (type(review) is not dict or set(review) != {'path', 'sha256'}
                    or type(review['path']) is not str or not 1 <= len(review['path']) <= 512
                    or type(review['sha256']) is not str or len(review['sha256']) != 64
                    or any(char not in '0123456789abcdef' for char in review['sha256'])):
                raise ValueError()
            parent = Path(path).resolve().parent
            relative = Path(review['path'])
            if relative.is_absolute():
                raise ValueError()
            evidence_path = (parent / relative).resolve()
            if not evidence_path.is_relative_to(parent) or not evidence_path.is_file():
                raise ValueError()
            with evidence_path.open('rb') as evidence_file:
                evidence_bytes = evidence_file.read(65537)
            if (not evidence_bytes or len(evidence_bytes) > 65536
                    or hashlib.sha256(evidence_bytes).hexdigest() != review['sha256']):
                raise ValueError()
            # The reviewed bytes bind the judgement to its receipt. They are not
            # proof of provider-wide billing behavior; no raw evidence is logged.
            record['_policyDirectory'] = str(parent)
            record['_reviewRecordPath'] = str(evidence_path)
            record['_auditPath'] = str(parent / (
                'reviewed-event-' + review['sha256'] + '.http-attempts.private.jsonl'))
        return record
    except Exception:
        raise LiveAccessError('FREE_ACCESS_NOT_VERIFIED') from None


def selected_credential(environ):
    supplied = environ.get('QLOO_API_KEY')
    if supplied is not None:
        if (not supplied or len(supplied) > 1024
                or any(ord(char) < 33 or ord(char) > 126 for char in supplied)):
            raise LiveAccessError('CREDENTIAL_FORMAT_INVALID')
        return supplied
    try:
        from qloo_connector import read_windows_credential
        secret = read_windows_credential()
        try:
            return secret._value
        finally:
            secret.close()
    except Exception:
        raise LiveAccessError('CREDENTIAL_NOT_READY') from None


def make_child_environment(parent, secret, home, package, policy, audit):
    names = {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
             'LOCALAPPDATA', 'PATH', 'PATHEXT', 'COMSPEC'}
    result = {key: value for key, value in parent.items() if key.upper() in names}
    result.update({'QLOO_API_KEY': secret, 'QLOO_HOME': str(home),
                   'QLOO_BASE_URL': 'https://hackathon.api.qloo.com',
                   'QLOO_TRUSTED_BASE_URL': 'https://hackathon.api.qloo.com',
                   'QLOO_HARNESS_DIR': str(package),
                   'QLOO_FREE_ACCESS_EXPIRES_AT': policy['validUntil'],
                   'QLOO_MAX_HTTP_ATTEMPTS': str(policy['maxHttpAttempts']),
                   'QLOO_TRANSPORT_AUDIT': str(audit), 'NO_COLOR': '1'})
    if policy.get('schema') == 'qloo-reviewed-event-v2':
        result.update({'QLOO_ACCESS_BASIS': policy['reviewBasis'],
                       'QLOO_COST_CERTAINTY': policy['costCertainty'],
                       'QLOO_REVIEWED_AT': policy['verifiedAt'],
                       'QLOO_POLICY_DIRECTORY': policy['_policyDirectory'],
                       'QLOO_REVIEW_RECORD_PATH': policy['_reviewRecordPath'],
                       'QLOO_REVIEW_RECORD_SHA256': policy['reviewRecord']['sha256'],
                       'QLOO_TRANSPORT_AUDIT': policy['_auditPath'],
                       'QLOO_PRIVATE_RESPONSE_DIRECTORY': str(Path(policy['_policyDirectory'])
                           / 'private' / ('responses-' + policy['reviewRecord']['sha256']))})
        result.update({environment: 'yes' for environment in REVIEW_FACTS.values()})
    else:
        result['QLOO_FREE_ACCESS_CONFIRMED'] = 'yes'
    return result


def decode_protected_response(line, secret, request_id):
    if line is None or len(line) > 1048576:
        raise LiveAccessError('MCP_RESPONSE_INVALID')
    decoded = line.decode('utf-8')
    patterns = (secret, json.dumps(secret)[1:-1]) if secret else ()
    if any(pattern in decoded for pattern in patterns):
        raise LiveAccessError('CREDENTIAL_REFLECTION_BLOCKED')
    result = json.loads(decoded)
    normalized = json.dumps(result, ensure_ascii=False)
    if any(pattern in normalized for pattern in patterns):
        raise LiveAccessError('CREDENTIAL_REFLECTION_BLOCKED')
    if (not isinstance(result, dict) or result.get('id') != request_id
            or result.get('jsonrpc') != '2.0' or 'error' in result or 'result' not in result):
        raise LiveAccessError('MCP_RESPONSE_INVALID')
    return result['result']


class CanonicalMcpBackend:
    """A serialized MCP client. Constructing it does not read credentials."""
    ALLOWED = {'qloo_capabilities', 'qloo_find_tags', 'qloo_recommend'}

    def __init__(self, policy_path, *, environ=None, credential_reader=None):
        self._policy_path = policy_path
        self.policy = load_access_policy(policy_path)
        self.environ = dict(os.environ if environ is None else environ)
        self._credential_reader = credential_reader or selected_credential
        self._child = None
        self._secret = None
        self._counter = 0
        self._calls = 0
        self._stopped = False
        self._lines = queue.Queue()
        self._lock = threading.Lock()

    def _start(self):
        root = Path(__file__).resolve().parent
        package = Path(self.environ.get('QLOO_HARNESS_DIR', root / 'node_modules/@qloo/qloo-harness')).resolve()
        try:
            metadata = json.loads((package / 'package.json').read_text(encoding='utf-8'))
            if metadata.get('name') != '@qloo/qloo-harness' or metadata.get('version') != '0.1.26':
                raise ValueError()
            entry = root / 'live/entry.mjs'
            if not entry.is_file():
                raise ValueError()
        except Exception:
            raise LiveAccessError('PINNED_HARNESS_NOT_READY') from None
        secret = self._credential_reader(self.environ)
        # The environment is passed only to this backend process; no .env,
        # user-wide environment, MCP config or command-line key is written.
        self._secret = secret
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        home = root / 'private' / ('run-' + stamp + '-' + str(os.getpid()))
        home.mkdir(parents=True, exist_ok=False)
        env = make_child_environment(self.environ, secret, home, package, self.policy,
                                     home / 'http-attempts.private.jsonl')
        node = self.environ.get('QLOO_NODE_PATH', 'node')
        self._child = subprocess.Popen([node, str(entry)], cwd=home, env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, bufsize=0,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        env.pop('QLOO_API_KEY', None)
        child = self._child
        def read_lines():
            try:
                while True:
                    line = child.stdout.readline(1048577)
                    if not line:
                        break
                    self._lines.put(line)
            except (ValueError, OSError):
                pass
            finally:
                self._lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()
        initialized = self._request('initialize', {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'QlooWorkbench', 'version': '1.0.0'}})
        if initialized.get('protocolVersion') != '2024-11-05':
            raise LiveAccessError('MCP_PROTOCOL_MISMATCH')
        self._write({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def _write(self, record):
        self._child.stdin.write((json.dumps(record) + '\n').encode('utf-8'))
        self._child.stdin.flush()

    def _request(self, method, params):
        self._counter += 1
        request_id = self._counter
        self._write({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
        line = self._lines.get(timeout=25)
        return decode_protected_response(line, self._secret, request_id)

    def call(self, name, arguments):
        if name not in self.ALLOWED or type(arguments) is not dict:
            raise LiveAccessError('TOOL_NOT_ALLOWED')
        with self._lock:
            if self._stopped or self._calls >= 4:
                raise LiveAccessError('LIVE_BACKEND_STOPPED')
            try:
                self.policy = load_access_policy(self._policy_path)
                if self._child is None:
                    self._start()
                self._calls += 1
                result = self._request('tools/call', {'name': name, 'arguments': arguments})
                structured = result.get('structuredContent', {})
                if result.get('isError') or structured.get('status') == 'error':
                    self._stopped = True
                return result
            except LiveAccessError:
                self._stopped = True
                self.close()
                raise
            except Exception:
                self._stopped = True
                self.close()
                raise LiveAccessError('LIVE_BACKEND_FAILED') from None

    def close(self):
        self._stopped = True
        if self._child is not None:
            child = self._child
            try:
                child.stdin.close()
                child.wait(timeout=3)
            except Exception:
                try:
                    child.kill()
                    child.wait(timeout=3)
                except Exception:
                    pass
            finally:
                for pipe in (child.stdin, child.stdout):
                    try:
                        pipe.close()
                    except Exception:
                        pass
                self._child = None
        self._secret = None

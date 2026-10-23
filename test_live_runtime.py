import datetime
import json
from pathlib import Path
import tempfile
import unittest
import contextlib
import io
import hashlib
from unittest.mock import patch

import qloo_live_runtime as runtime


class LiveRuntimePolicyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / 'policy.json'
        self.now = datetime.datetime(2026, 10, 23, tzinfo=datetime.timezone.utc)
        self.record = {'schema': 'qloo-event-access-v1', 'complimentaryConfirmed': True,
            'noOverageChargesConfirmed': True,
            'providerEvidence': 'https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide',
            'verifiedAt': '2026-10-22T00:00:00+00:00', 'validUntil': '2026-10-24T00:00:00+00:00',
            'maxHttpAttempts': 4, 'monthlyQuota': None, 'rateLimitPerSecond': None,
            'providerExactExpiry': None}

    def tearDown(self):
        self.folder.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.record), encoding='utf-8')

    def reviewed_event(self):
        evidence = self.path.parent / 'review.private.json'
        evidence.write_text('Offline synthetic review record; not provider assurance.', encoding='utf-8')
        now = datetime.datetime.now(datetime.timezone.utc)
        self.record = {'schema': 'qloo-reviewed-event-v2',
            'reviewBasis': 'event-entitlement-no-price-notice',
            'costCertainty': 'inferred-not-provider-guarantee',
            'eventKeyIssued': True, 'userZeroSpendAuthorized': True,
            'noFeeNoticeInIssuance': True, 'noPaymentFieldsInIssuanceForm': True,
            'noPaidConversion': True,
            'providerEvidence': 'https://qloo.devpost.com/rules',
            'verifiedAt': (now - datetime.timedelta(seconds=5)).isoformat(),
            'validUntil': (now + datetime.timedelta(minutes=10)).isoformat(),
            'maxHttpAttempts': 2, 'monthlyQuota': None, 'rateLimitPerSecond': None,
            'providerExactExpiry': None,
            'reviewRecord': {'path': evidence.name,
                             'sha256': hashlib.sha256(evidence.read_bytes()).hexdigest()}}
        self.write()
        return evidence

    def test_reviewed_event_accepts_unknown_numbers_without_claiming_guarantee(self):
        self.reviewed_event()
        loaded = runtime.load_access_policy(self.path)
        self.assertEqual(loaded['schema'], 'qloo-reviewed-event-v2')
        self.assertNotIn('noOverageChargesConfirmed', loaded)
        self.assertIsNone(loaded['monthlyQuota'])
        self.assertIsNone(loaded['providerExactExpiry'])

    def test_reviewed_event_missing_or_false_facts_stop_before_key_or_child(self):
        self.reviewed_event()
        facts = ('eventKeyIssued', 'userZeroSpendAuthorized', 'noFeeNoticeInIssuance',
                 'noPaymentFieldsInIssuanceForm', 'noPaidConversion')
        original = dict(self.record)
        for name in facts:
            for value in (False, 'true', None):
                self.record = {**original, name: value}
                self.write()
                with patch.object(runtime, 'selected_credential') as credential, \
                     patch.object(runtime.subprocess, 'Popen') as child:
                    with self.assertRaises(runtime.LiveAccessError):
                        runtime.CanonicalMcpBackend(self.path)
                    credential.assert_not_called()
                    child.assert_not_called()
            self.record = dict(original)
            self.record.pop(name)
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path)

    def test_reviewed_event_rejects_wrong_basis_budget_or_long_cutoff(self):
        self.reviewed_event()
        original = dict(self.record)
        cases = [('reviewBasis', 'provider-guaranteed'), ('costCertainty', 'free-guarantee'),
                 ('maxHttpAttempts', 1), ('maxHttpAttempts', 3),
                 ('validUntil', (datetime.datetime.now(datetime.timezone.utc)
                                + datetime.timedelta(minutes=31)).isoformat())]
        for name, value in cases:
            self.record = {**original, name: value}
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path)

    def test_reviewed_event_record_is_hash_bound_and_cannot_escape_policy_parent(self):
        evidence = self.reviewed_event()
        evidence.write_text('changed review', encoding='utf-8')
        with self.assertRaises(runtime.LiveAccessError):
            runtime.load_access_policy(self.path)
        self.reviewed_event()
        for path in (str(evidence.resolve()), '../outside.private.json'):
            original = self.record['reviewRecord']['path']
            self.record['reviewRecord']['path'] = path
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path)
            self.record['reviewRecord']['path'] = original

    def test_reviewed_event_child_uses_honest_basis_and_shared_review_budget_path(self):
        self.reviewed_event()
        loaded = runtime.load_access_policy(self.path)
        first = runtime.make_child_environment({}, 'synthetic', Path('home-one'),
            Path('package'), loaded, Path('different-first-audit'))
        second = runtime.make_child_environment({}, 'synthetic', Path('home-two'),
            Path('package'), loaded, Path('different-second-audit'))
        self.assertNotIn('QLOO_FREE_ACCESS_CONFIRMED', first)
        self.assertEqual(first['QLOO_ACCESS_BASIS'], self.record['reviewBasis'])
        self.assertEqual(first['QLOO_COST_CERTAINTY'], self.record['costCertainty'])
        self.assertEqual(first['QLOO_TRANSPORT_AUDIT'], second['QLOO_TRANSPORT_AUDIT'])
        self.assertEqual(Path(first['QLOO_TRANSPORT_AUDIT']).parent, self.path.parent.resolve())
        self.assertIn(self.record['reviewRecord']['sha256'], first['QLOO_TRANSPORT_AUDIT'])
        self.assertEqual(first['QLOO_MAX_HTTP_ATTEMPTS'], '2')
        self.assertEqual(Path(first['QLOO_PRIVATE_RESPONSE_DIRECTORY']), self.path.parent.resolve()
            / 'private' / ('responses-' + self.record['reviewRecord']['sha256']))

    def test_unverified_cost_policy_stops_before_key_or_process(self):
        self.record['complimentaryConfirmed'] = False
        self.write()
        with patch.object(runtime, 'selected_credential') as credential, \
             patch.object(runtime.subprocess, 'Popen') as child:
            with self.assertRaises(runtime.LiveAccessError):
                runtime.CanonicalMcpBackend(self.path)
            credential.assert_not_called()
            child.assert_not_called()

    def test_missing_policy_stops_before_key_or_process(self):
        with patch.object(runtime, 'selected_credential') as credential, \
             patch.object(runtime.subprocess, 'Popen') as child:
            with self.assertRaises(runtime.LiveAccessError):
                runtime.CanonicalMcpBackend(self.path)
            credential.assert_not_called()
            child.assert_not_called()

    def test_unpublished_numbers_are_not_fabricated(self):
        self.write()
        loaded = runtime.load_access_policy(self.path, now=self.now)
        self.assertIsNone(loaded['monthlyQuota'])
        self.assertIsNone(loaded['rateLimitPerSecond'])
        self.assertIsNone(loaded['providerExactExpiry'])

    def test_expired_future_and_naive_records_are_rejected(self):
        for field, value in [('validUntil', '2026-10-22T00:00:00+00:00'),
                             ('verifiedAt', '2026-10-24T00:00:00+00:00'),
                             ('validUntil', '2026-10-24T00:00:00')]:
            before = self.record[field]
            self.record[field] = value
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path, now=self.now)
            self.record[field] = before

    def test_evidence_host_cannot_embed_credentials_or_override_port(self):
        for value in ('https://docs.qloo.com.evil.invalid/anything',
                      'https://secret@docs.qloo.com/reference/anything',
                      'https://docs.qloo.com:444/reference/anything',
                      'https://github.com/unrelated/repo'):
            self.record['providerEvidence'] = value
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path, now=self.now)

    def test_attempt_budget_is_a_bounded_integer(self):
        for value in (0, 5, True, '4'):
            self.record['maxHttpAttempts'] = value
            self.write()
            with self.assertRaises(runtime.LiveAccessError):
                runtime.load_access_policy(self.path, now=self.now)

    def test_child_environment_is_isolated_and_does_not_mutate_parent(self):
        parent = {'PATH': 'approved', 'QLOO_API_KEY': 'wrong-parent',
                  'OPENAI_API_KEY': 'unrelated-synthetic', 'NODE_OPTIONS': 'unapproved'}
        child = runtime.make_child_environment(parent, 'selected-synthetic', Path('home'),
                                               Path('package'), self.record, Path('audit'))
        self.assertEqual(child['QLOO_API_KEY'], 'selected-synthetic')
        self.assertNotIn('OPENAI_API_KEY', child)
        self.assertNotIn('NODE_OPTIONS', child)
        self.assertNotIn('QLOO_PRIVATE_RESPONSE_DIRECTORY', child)
        self.assertEqual(child['QLOO_BASE_URL'], child['QLOO_TRUSTED_BASE_URL'])
        self.assertEqual(child['QLOO_FREE_ACCESS_EXPIRES_AT'], self.record['validUntil'])
        self.assertEqual(parent['QLOO_API_KEY'], 'wrong-parent')

    def test_environment_key_rejects_header_control_characters(self):
        with self.assertRaises(runtime.LiveAccessError):
            runtime.selected_credential({'QLOO_API_KEY': 'synthetic\r\nX-Other: value'})

    def test_json_unicode_escaped_credential_reflection_is_blocked(self):
        fake = 'SYNTHETIC-SELECTED-KEY'
        line = b'{"jsonrpc":"2.0","id":1,"result":{"text":"\\u0053YNTHETIC-SELECTED-KEY"}}'
        self.assertNotIn(fake.encode(), line)
        with self.assertRaises(runtime.LiveAccessError) as error:
            runtime.decode_protected_response(line, fake, 1)
        self.assertEqual(error.exception.code, 'CREDENTIAL_REFLECTION_BLOCKED')

    def test_closed_backend_never_reopens_or_reads_credentials(self):
        self.write()
        with patch.object(runtime, 'load_access_policy', return_value=self.record):
            backend = runtime.CanonicalMcpBackend(self.path)
        backend.close()
        with patch.object(backend, '_start') as start:
            with self.assertRaises(runtime.LiveAccessError) as error:
                backend.call('qloo_find_tags', {'query': 'fixture'})
            self.assertEqual(error.exception.code, 'LIVE_BACKEND_STOPPED')
            start.assert_not_called()

    def test_invalid_launcher_arguments_do_not_pollute_mcp_stdout(self):
        import qloo_workbench_mcp
        output, diagnostic = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostic):
            status = qloo_workbench_mcp.main(['--not-a-valid-option'])
        self.assertEqual(status, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(json.loads(diagnostic.getvalue())['status'], 'INVALID_ARGUMENTS')

    def test_live_launcher_gate_has_no_protocol_or_credential_side_effect(self):
        import qloo_workbench_mcp
        self.record['complimentaryConfirmed'] = False
        self.write()
        output, diagnostic = io.StringIO(), io.StringIO()
        with patch.object(runtime, 'selected_credential') as credential, \
             patch.object(runtime.subprocess, 'Popen') as child, \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostic):
            status = qloo_workbench_mcp.main(['--mode', 'live', '--policy', str(self.path)])
        self.assertEqual(status, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(json.loads(diagnostic.getvalue())['status'], 'FREE_ACCESS_NOT_VERIFIED')
        credential.assert_not_called()
        child.assert_not_called()


if __name__ == '__main__':
    unittest.main()

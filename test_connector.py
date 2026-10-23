"""Offline boundary tests. Never access Windows credentials or the network."""
import contextlib
import ctypes
import io
import json
import ssl
import unittest
from unittest.mock import patch

import check_connection as cli
import qloo_connector as qc

FAKE_KEY = "FAKE-TEST-ONLY-NOT-A-REAL-QLOO-KEY"


class FakeResponse:
    def __init__(self, status):
        self.status = status
        self.body_read = False

    def read(self, *args):
        self.body_read = True
        raise RuntimeError(FAKE_KEY)


class FakeConnection:
    def __init__(self, host, port, *, timeout, context):
        self.host, self.port, self.timeout, self.context = host, port, timeout, context
        self.calls = []
        self.closed = False
        self.debuglevel = None
        self.response = FakeResponse(200)
        self.error = None

    def set_debuglevel(self, level):
        self.debuglevel = level

    def request(self, method, path, headers):
        self.calls.append((method, path, headers))
        if self.error:
            raise self.error

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.connections = []
        self.secrets = []

    def credential(self):
        secret = qc._decode_secret(bytearray(FAKE_KEY.encode("utf-16-le")))
        self.secrets.append(secret)
        return secret

    def factory(self, *args, **kwargs):
        connection = FakeConnection(*args, **kwargs)
        self.connections.append(connection)
        return connection

    def run_live(self, status=200, error=None):
        def factory(*args, **kwargs):
            connection = self.factory(*args, **kwargs)
            connection.response.status = status
            connection.error = error
            return connection
        return qc.check_connection(live=True, cost_confirmed=True,
                                   credential_reader=self.credential,
                                   connection_factory=factory)

    def test_default_reads_locally_but_does_not_call_network(self):
        result = qc.check_connection(credential_reader=self.credential,
                                     connection_factory=self.factory)
        self.assertEqual(result.status, "LOCAL_READY_NETWORK_NOT_RUN")
        self.assertTrue(result.credential_ready)
        self.assertFalse(result.request_attempted)
        self.assertEqual(self.connections, [])
        self.assertIsNone(self.secrets[0]._value)

    def test_cost_gate_precedes_credentials_and_network(self):
        result = qc.check_connection(live=True, credential_reader=self.credential,
                                     connection_factory=self.factory)
        self.assertEqual(result.status, "COST_CONFIRMATION_REQUIRED")
        self.assertEqual(self.secrets, [])
        self.assertEqual(self.connections, [])

    def test_fixed_destination_header_and_tls_no_query_key(self):
        result = self.run_live()
        connection = self.connections[0]
        self.assertEqual((connection.host, connection.port),
                         ("hackathon.api.qloo.com", 443))
        self.assertEqual(connection.debuglevel, 0)
        self.assertTrue(connection.context.check_hostname)
        self.assertEqual(connection.context.verify_mode, ssl.CERT_REQUIRED)
        method, path, headers = connection.calls[0]
        self.assertEqual((method, path), ("GET", "/search?query=Matrix&take=1"))
        self.assertNotIn(FAKE_KEY, path)
        self.assertEqual(headers["X-Api-Key"], FAKE_KEY)
        self.assertEqual(result.status, "API_RESPONDED")
        self.assertTrue(connection.closed)
        self.assertFalse(connection.response.body_read)

    def test_all_redirects_stop_after_one_request_without_body(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                result = self.run_live(status=status)
                self.assertEqual(result.status, "REDIRECT_BLOCKED")
                self.assertEqual(len(self.connections[-1].calls), 1)
                self.assertFalse(self.connections[-1].response.body_read)
                self.assertTrue(self.connections[-1].closed)

    def test_http_failures_are_bounded_and_never_read_reflected_body(self):
        for status, expected in ((401, "AUTH_REJECTED"), (403, "AUTH_REJECTED"),
                                 (402, "PAYMENT_REQUIRED_STOP"),
                                 (429, "RATE_LIMITED_STOP"), (500, "HTTP_ERROR")):
            with self.subTest(status=status):
                result = self.run_live(status=status)
                self.assertEqual(result.status, expected)
                self.assertEqual(result.http_status, status)
                self.assertEqual(len(self.connections[-1].calls), 1)
                self.assertFalse(self.connections[-1].response.body_read)

    def test_exceptions_never_reach_stdout_stderr_or_result(self):
        for error, expected in ((RuntimeError(FAKE_KEY), "NETWORK_ERROR"),
                                (ssl.SSLError(FAKE_KEY), "TLS_ERROR"),
                                (TimeoutError(FAKE_KEY), "NETWORK_TIMEOUT")):
            with self.subTest(expected=expected):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    result = self.run_live(error=error)
                self.assertEqual(result.status, expected)
                self.assertEqual(out.getvalue(), "")
                self.assertEqual(err.getvalue(), "")
                self.assertNotIn(FAKE_KEY, json.dumps(result.as_dict()))
                self.assertTrue(self.connections[-1].closed)
                self.assertIsNone(self.secrets[-1]._value)

    def test_credential_exception_and_unknown_codes_are_sanitized(self):
        for error in (RuntimeError(FAKE_KEY), qc.ConnectorError(FAKE_KEY)):
            def reader():
                raise error
            result = qc.check_connection(credential_reader=reader,
                                         connection_factory=self.factory)
            self.assertEqual(result.status, "CREDENTIAL_READ_FAILED")
            self.assertNotIn(FAKE_KEY, repr(result))
            self.assertEqual(self.connections, [])

    def test_utf16_rejects_invalid_empty_oversized_and_header_injection(self):
        for blob in (b"", b"a", b"\x00\xd8", b"x" * 4098,
                     "a\rb".encode("utf-16-le"), "a\nb".encode("utf-16-le"),
                     "a\x00b".encode("utf-16-le"), " a".encode("utf-16-le")):
            with self.subTest(length=len(blob)):
                with self.assertRaises(qc.ConnectorError):
                    qc._decode_secret(bytearray(blob))

    def fake_pointer(self, blob, **overrides):
        buffer = (ctypes.c_ubyte * len(blob))(*blob)
        value = qc._CREDENTIALW()
        value.Type, value.TargetName, value.UserName = 1, qc.TARGET, qc.USERNAME
        value.CredentialBlobSize = len(blob)
        value.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
        for key, content in overrides.items():
            setattr(value, key, content)
        return ctypes.pointer(value), buffer

    def test_credential_pointer_is_freed_on_success_and_decode_failure(self):
        for blob in (FAKE_KEY.encode("utf-16-le"), b"\x00\xd8"):
            pointer, buffer = self.fake_pointer(blob)
            freed = []
            try:
                secret = qc._consume_credential(pointer, freed.append)
                self.assertNotIn(FAKE_KEY, repr(secret))
                secret.close()
            except qc.ConnectorError:
                pass
            self.assertEqual(len(freed), 1)

    def test_identity_size_and_null_pointer_fail_closed_and_free(self):
        for overrides in ({"Type": 2}, {"TargetName": "different-target"},
                          {"UserName": "different-user"},
                          {"CredentialBlobSize": 999999},
                          {"CredentialBlob": ctypes.POINTER(ctypes.c_ubyte)()}):
            pointer, buffer = self.fake_pointer(FAKE_KEY.encode("utf-16-le"), **overrides)
            freed = []
            with self.assertRaises(qc.ConnectorError):
                qc._consume_credential(pointer, freed.append)
            self.assertEqual(len(freed), 1)

    def test_cli_rejects_secret_arguments_without_echo_or_reader(self):
        out = io.StringIO()
        check = unittest.mock.Mock()
        with contextlib.redirect_stdout(out):
            code = cli.main(["--key", FAKE_KEY], checker=check)
        self.assertEqual(code, 1)
        check.assert_not_called()
        self.assertNotIn(FAKE_KEY, out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["status"], "INVALID_ARGUMENTS")

    def test_safe_serialization_schema_and_closed_secret(self):
        result = self.run_live()
        self.assertEqual(set(result.as_dict()),
                         {"status", "credentialReady", "requestAttempted", "httpStatus"})
        self.assertNotIn(FAKE_KEY, str(result))
        self.assertNotIn(FAKE_KEY, str(self.secrets[0]))
        self.assertIsNone(self.secrets[0]._value)

    def test_windows_denial_session_and_absence_are_distinguished_without_secret(self):
        for code, expected in ((5, "CREDENTIAL_ACCESS_DENIED"),
                                (1312, "CREDENTIAL_SESSION_UNAVAILABLE"),
                                (1168, "CREDENTIAL_NOT_FOUND")):
            with self.subTest(code=code):
                api = unittest.mock.Mock()
                api.CredReadW.return_value = 0
                with patch.object(qc.os, "name", "nt"), \
                     patch.object(qc.ctypes, "WinDLL", return_value=api, create=True), \
                     patch.object(qc.ctypes, "get_last_error", return_value=code, create=True):
                    result = qc.check_connection()
                self.assertEqual(result.status, expected)
                self.assertFalse(result.request_attempted)
                api.CredReadW.assert_called_once()
                self.assertEqual(api.CredReadW.call_args.args[:3], (qc.TARGET, 1, 0))
                api.CredFree.assert_not_called()

    def test_windows_backend_failure_has_no_exception_payload(self):
        with patch.object(qc.os, "name", "nt"), \
             patch.object(qc.ctypes, "WinDLL", side_effect=RuntimeError(FAKE_KEY), create=True):
            result = qc.check_connection()
        self.assertEqual(result.status, "CREDENTIAL_BACKEND_UNAVAILABLE")
        self.assertNotIn(FAKE_KEY, json.dumps(result.as_dict()))
        self.assertFalse(result.request_attempted)

    def test_free_is_called_even_when_buffer_wipe_fails(self):
        class WipeFailure(bytearray):
            def __setitem__(self, key, value):
                raise RuntimeError(FAKE_KEY)
        pointer, buffer = self.fake_pointer(FAKE_KEY.encode("utf-16-le"))
        freed = []
        with patch.object(qc, "bytearray", WipeFailure, create=True):
            with self.assertRaises(RuntimeError):
                qc._consume_credential(pointer, freed.append)
        self.assertEqual(len(freed), 1)

    def test_cli_import_failure_has_status_only_and_no_traceback(self):
        import builtins
        original_import = builtins.__import__
        def failing_import(name, *args, **kwargs):
            if name == "qloo_connector":
                raise ImportError(FAKE_KEY)
            return original_import(name, *args, **kwargs)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(builtins, "__import__", side_effect=failing_import), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main([])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["status"], "INTERNAL_ERROR")
        self.assertNotIn(FAKE_KEY, out.getvalue())
        self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

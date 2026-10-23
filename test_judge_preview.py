"""Real loopback HTTP tests; no external network, credentials, or live Qloo."""

import http.client
import json
import socket
import threading
import unittest

from judge_preview import BODY_LIMIT, MODE_NOTICE, REQUEST_TIMEOUT, SESSION_LIMIT, PreviewServer


class JudgePreviewTests(unittest.TestCase):
    def setUp(self):
        self.server = PreviewServer(0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.cookie = None
        self.csrf = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())
        self.assertEqual({}, self.server.sessions)

    def request(self, method="GET", path="/api/session", payload=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        request_headers = {}
        if self.cookie:
            request_headers["Cookie"] = self.cookie
        if method == "POST":
            request_headers.update({"Origin": self.server.origin, "Content-Type": "application/json", "X-Preview-CSRF": self.csrf or ""})
        request_headers.update(headers or {})
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        content = response.read()
        response_headers = dict(response.getheaders())
        if "Set-Cookie" in response_headers:
            self.cookie = response_headers["Set-Cookie"].split(";", 1)[0]
        parsed = json.loads(content) if response_headers.get("Content-Type", "").startswith("application/json") else content.decode()
        if isinstance(parsed, dict) and parsed.get("csrf"):
            self.csrf = parsed["csrf"]
        status = response.status
        connection.close()
        return status, parsed, response_headers

    def initialize(self):
        status, body, _headers = self.request()
        self.assertEqual(200, status)
        self.assertEqual(MODE_NOTICE, body["mode_notice"])
        return body

    def tool(self, name, arguments):
        status, body, _headers = self.request("POST", "/api/tool", {"name": name, "arguments": arguments})
        self.assertEqual(200, status)
        return body["result"], body["readiness"]

    def resolve_and_confirm(self):
        resolved, _ = self.tool("taste_resolve", {"query": "quiet and curious"})
        self.assertEqual("needs_confirmation", resolved["status"])
        confirmed, readiness = self.tool("taste_confirm", {"resolution_id": resolved["resolution_id"], "selected_tag_id": resolved["candidates"][1]["id"]})
        self.assertEqual("confirmed", confirmed["status"])
        self.assertEqual(1, readiness["backend_calls"])
        return confirmed

    def test_page_and_session_security_headers(self):
        status, html, headers = self.request(path="/")
        self.assertEqual(200, status)
        self.assertIn(MODE_NOTICE, html)
        self.assertNotIn("__CSP_NONCE__", html)
        self.assertNotIn("innerHTML", html)
        self.assertNotIn("http://", html)
        self.assertNotIn("https://", html)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn("Domain", headers["Set-Cookie"])
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual("no-store", headers["Cache-Control"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_actual_http_confirm_recommend_cache_and_reset(self):
        self.initialize()
        confirmed = self.resolve_and_confirm()
        args = {"receipt": confirmed["receipt"], "target_type": "movie", "limit": 3}
        result, readiness = self.tool("taste_recommend", args)
        self.assertEqual("ok", result["status"])
        self.assertEqual(3, len(result["shortlist"]))
        self.assertFalse(result["cached_receipt_replay"])
        self.assertEqual(2, readiness["backend_calls"])
        self.assertIn("Invented offline fixture", result["canonical"]["provenance"]["source"])
        cached, readiness = self.tool("taste_recommend", args)
        self.assertTrue(cached["cached_receipt_replay"])
        self.assertEqual(2, readiness["backend_calls"])
        old_cookie, old_csrf = self.cookie, self.csrf
        status, reset, _ = self.request("POST", "/api/reset", {})
        self.assertEqual(200, status)
        self.assertNotEqual(old_cookie, self.cookie)
        self.assertNotEqual(old_csrf, self.csrf)
        self.assertEqual(0, reset["readiness"]["backend_calls"])
        result, _ = self.tool("taste_recommend", args)
        self.assertEqual("invalid_receipt", result["error"]["code"])
        self.assertEqual(1, len(self.server.sessions))
        status, _, _ = self.request("POST", "/api/reset", {}, headers={"Cookie": old_cookie, "X-Preview-CSRF": old_csrf})
        self.assertEqual(403, status)

    def test_all_categories_and_receipt_target_binding(self):
        self.initialize()
        for target in ("movie", "book", "artist"):
            confirmed = self.resolve_and_confirm() if target == "movie" else None
            if confirmed is None:
                self.request("POST", "/api/reset", {})
                confirmed = self.resolve_and_confirm()
            result, _ = self.tool("taste_recommend", {"receipt": confirmed["receipt"], "target_type": target, "limit": 3})
            self.assertEqual(3, len(result["shortlist"]))
            self.assertTrue(all(item["type"] == "urn:entity:" + target for item in result["shortlist"]))
            other, _ = self.tool("taste_recommend", {"receipt": confirmed["receipt"], "target_type": "book" if target != "book" else "movie", "limit": 3})
            self.assertEqual("receipt_already_used", other["error"]["code"])

    def test_host_origin_csrf_and_cross_site_denied(self):
        self.initialize()
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Origin": "null"}, {"X-Preview-CSRF": "wrong"}, {"X-Preview-CSRF": "é"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, response_headers = self.request("POST", "/api/reset", {}, headers=headers)
                self.assertEqual(403, status)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
        status, _, _ = self.request(headers={"Host": "localhost:" + str(self.server.server_port)})
        self.assertEqual(403, status)

    def test_missing_origin_and_missing_session_denied(self):
        self.initialize()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("POST", "/api/reset", body=b"{}", headers={"Content-Type": "application/json", "Cookie": self.cookie, "X-Preview-CSRF": self.csrf})
        response = connection.getresponse()
        self.assertEqual(403, response.status)
        response.read()
        connection.close()
        self.cookie = None
        status, _, _ = self.request("POST", "/api/reset", {})
        self.assertEqual(403, status)

    def test_malformed_json_and_content_type(self):
        self.initialize()
        for raw in (b"[]", b"not-json", b'{"a":1,"a":2}', b'{"x":NaN}', b'{"x":"\xff"}'):
            with self.subTest(raw=raw):
                self.assertEqual(400, self.request("POST", "/api/tool", raw=raw)[0])
        self.assertEqual(415, self.request("POST", "/api/reset", {}, headers={"Content-Type": "text/plain"})[0])

    def test_body_limit_transfer_encoding_and_duplicate_length(self):
        self.initialize()
        self.assertEqual(413, self.request("POST", "/api/tool", raw=b"x" * (BODY_LIMIT + 1))[0])
        self.assertEqual(400, self.request("POST", "/api/reset", {}, headers={"Transfer-Encoding": "chunked"})[0])
        self.assertEqual(400, self.request("POST", "/api/reset", {}, headers={"Content-Length": "-1"})[0])
        self.assertEqual(400, self.request("POST", "/api/reset", {}, headers={"Content-Length": "9" * 4301})[0])
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.putrequest("POST", "/api/reset")
        for name, value in (("Origin", self.server.origin), ("Content-Type", "application/json"), ("Content-Length", "2"), ("Content-Length", "2")):
            connection.putheader(name, value)
        connection.endheaders(b"{}")
        response = connection.getresponse()
        self.assertEqual(400, response.status)
        response.read()
        connection.close()

    def test_tool_whitelist_arguments_and_tampered_choice(self):
        self.initialize()
        for payload in ({"name": "qloo_recommend", "arguments": {}}, {"name": "taste_readiness", "arguments": {}, "live": True}, {"name": "taste_readiness", "arguments": []}):
            self.assertEqual(400, self.request("POST", "/api/tool", payload)[0])
        resolved, _ = self.tool("taste_resolve", {"query": "<img src=x onerror=alert(1)>"})
        result, readiness = self.tool("taste_confirm", {"resolution_id": resolved["resolution_id"], "selected_tag_id": "urn:tag:not-offered"})
        self.assertEqual("tag_not_in_candidates", result["error"]["code"])
        self.assertEqual(1, readiness["backend_calls"])
        result, _ = self.tool("taste_resolve", {"query": "x" * 81})
        self.assertEqual("invalid_arguments", result["error"]["code"])

    def test_separate_cookie_session_cannot_use_receipt(self):
        self.initialize()
        confirmed = self.resolve_and_confirm()
        self.cookie = None
        self.initialize()
        result, _ = self.tool("taste_recommend", {"receipt": confirmed["receipt"], "target_type": "movie"})
        self.assertEqual("invalid_receipt", result["error"]["code"])

    def test_non_routes_and_methods_not_served(self):
        for path in ("/../taste_product.py", "/web/judge.html", "/?live=true", "/favicon.ico"):
            self.assertEqual(404, self.request(path=path)[0])
        self.assertEqual(405, self.request("OPTIONS", "/api/tool")[0])

    def test_expired_session_and_timeout_configuration(self):
        self.initialize()
        token = self.cookie.split("=", 1)[1]
        self.server.sessions[token]["expires"] = 0
        self.assertEqual(403, self.request("POST", "/api/reset", {})[0])
        self.assertNotIn(token, self.server.sessions)
        self.assertEqual("127.0.0.1", self.server.server_address[0])
        # A truncated body is rejected instead of being parsed as a full request.
        connection = socket.create_connection(self.server.server_address, timeout=5)
        request = ("POST /api/reset HTTP/1.0\r\nHost: " + self.server.expected_host + "\r\nOrigin: " + self.server.origin + "\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}").encode()
        connection.sendall(request)
        connection.shutdown(socket.SHUT_WR)
        response = connection.recv(4096)
        self.assertIn(b"400 Bad Request", response)
        connection.close()

    def test_stalled_body_hits_socket_timeout(self):
        connection = socket.create_connection(self.server.server_address, timeout=REQUEST_TIMEOUT + 3)
        request = ("POST /api/reset HTTP/1.0\r\nHost: " + self.server.expected_host + "\r\nOrigin: " + self.server.origin + "\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}").encode()
        connection.sendall(request)
        response = connection.recv(4096)
        self.assertIn(b"408 Request Timeout", response)
        connection.close()

    def test_explicit_reset_recovers_expired_session_without_backend_call(self):
        self.initialize()
        confirmed = self.resolve_and_confirm()
        expired_cookie, expired_csrf = self.cookie, self.csrf
        expired_token = self.cookie.split("=", 1)[1]
        expired_app = self.server.sessions[expired_token]["app"]
        self.server.sessions[expired_token]["expires"] = 0
        status, error, _ = self.request("POST", "/api/reset", {})
        self.assertEqual(403, status)
        self.assertEqual("session_required", error["error"])
        self.assertTrue(expired_app.closed)
        # Matches the browser's explicit Reset sequence: session refresh, then
        # reset. Neither request resolves a phrase or requests recommendations.
        status, refreshed, _ = self.request()
        self.assertEqual(200, status)
        self.assertNotEqual(expired_cookie, self.cookie)
        self.assertNotEqual(expired_csrf, self.csrf)
        self.assertEqual(0, refreshed["readiness"]["backend_calls"])
        refreshed_cookie = self.cookie
        status, reset, _ = self.request("POST", "/api/reset", {})
        self.assertEqual(200, status)
        self.assertNotEqual(refreshed_cookie, self.cookie)
        self.assertEqual(0, reset["readiness"]["backend_calls"])
        self.assertEqual(1, len(self.server.sessions))
        result, readiness = self.tool("taste_recommend", {"receipt": confirmed["receipt"], "target_type": "movie"})
        self.assertEqual("invalid_receipt", result["error"]["code"])
        self.assertEqual(0, readiness["backend_calls"])

    def test_memory_session_capacity_is_bounded(self):
        for _ in range(SESSION_LIMIT):
            self.cookie = None
            self.initialize()
        self.cookie = None
        self.assertEqual(503, self.request()[0])
        self.assertEqual(SESSION_LIMIT, len(self.server.sessions))


if __name__ == "__main__":
    unittest.main()

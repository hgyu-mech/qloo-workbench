"""Loopback-only browser preview using invented fixtures, never a live backend.

Run: python judge_preview.py --port 8765
Open the printed 127.0.0.1 URL. Ctrl+C stops the process and discards sessions.
This is not a production server, LLM host, or verified live judging endpoint.

HTTP lifecycle follows Python 3.12's documented server/handler interfaces:
https://docs.python.org/3.12/library/http.server.html
Cookie parsing/attributes: https://docs.python.org/3.12/library/http.cookies.html
Socket timeout: https://docs.python.org/3.12/library/socket.html#socket.socket.settimeout
"""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading
import time

from taste_product import FixtureBackend, TasteWorkbench


COOKIE_NAME = "taste_preview_session"
BODY_LIMIT = 8192
SESSION_LIMIT = 32
SESSION_TTL = 900
REQUEST_TIMEOUT = 3
ALLOWED_TOOLS = frozenset(("taste_resolve", "taste_confirm", "taste_recommend", "taste_readiness"))
MODE_NOTICE = "Invented offline fixtures / not live Qloo"
PAGE = Path(__file__).resolve().parent / "web" / "judge.html"


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("Nonfinite JSON number")


class PreviewServer(ThreadingHTTPServer):
    """All state is ephemeral and all workbenches use FixtureBackend explicitly."""

    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, port=8765):
        if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
            raise ValueError("Invalid local port")
        self.sessions = {}
        self.state_lock = threading.RLock()
        super().__init__(("127.0.0.1", port), PreviewHandler)
        self.expected_host = "127.0.0.1:" + str(self.server_port)
        self.origin = "http://" + self.expected_host

    def _expire_locked(self):
        now = time.monotonic()
        for token, session in list(self.sessions.items()):
            if now >= session["expires"]:
                session["app"].close()
                del self.sessions[token]

    def new_session_locked(self):
        self._expire_locked()
        if len(self.sessions) >= SESSION_LIMIT:
            return None, None
        token = secrets.token_urlsafe(32)
        session = {
            "app": TasteWorkbench(backend=FixtureBackend(), data_source="fixture-canonical-v1", live=False),
            "csrf": secrets.token_urlsafe(32),
            "expires": time.monotonic() + SESSION_TTL,
        }
        self.sessions[token] = session
        return token, session

    def server_close(self):
        with self.state_lock:
            for session in self.sessions.values():
                session["app"].close()
            self.sessions.clear()
        super().server_close()


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "TastePreview"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT)
        self._body_consumed = False

    def log_message(self, _format, *_args):
        # No persistent request logs or user query logging.
        return

    def _respond(self, status, data, *, content_type="application/json; charset=utf-8", cookie=None, nonce=None):
        # Windows may reset a socket closed with an unread request body before
        # its error response reaches the client. Drain only a declared small
        # non-chunked body, with the same strict timeout and byte cap.
        if status >= 400 and self.command == "POST" and not self._body_consumed:
            lengths = self.headers.get_all("Content-Length", [])
            if not self.headers.get_all("Transfer-Encoding") and len(lengths) == 1 and len(lengths[0]) <= 10 and lengths[0].isascii() and lengths[0].isdigit() and 0 < int(lengths[0]) <= BODY_LIMIT:
                self._body_consumed = True
                try:
                    self.rfile.read(int(lengths[0]))
                except (OSError, TimeoutError):
                    pass
        body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=True, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        policy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'"
        if nonce:
            policy += "; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'"
        self.send_header("Content-Security-Policy", policy)
        if cookie:
            value = SimpleCookie()
            value[COOKIE_NAME] = cookie
            value[COOKIE_NAME]["httponly"] = True
            value[COOKIE_NAME]["samesite"] = "Strict"
            value[COOKIE_NAME]["path"] = "/"
            # No Domain/Expires/Max-Age: host-only session cookie. HTTP loopback
            # deliberately has no Secure attribute; never bind this server publicly.
            self.send_header("Set-Cookie", value.output(header="").strip())
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def _error(self, status, code):
        self._respond(status, {"error": code, "mode_notice": MODE_NOTICE})

    def _request_allowed(self, *, post=False):
        hosts = self.headers.get_all("Host", [])
        if hosts != [self.server.expected_host]:
            self._error(HTTPStatus.FORBIDDEN, "invalid_host")
            return False
        origins = self.headers.get_all("Origin", [])
        if (post and origins != [self.server.origin]) or (origins and origins != [self.server.origin]):
            self._error(HTTPStatus.FORBIDDEN, "invalid_origin")
            return False
        if self.headers.get("Sec-Fetch-Site", "") == "cross-site":
            self._error(HTTPStatus.FORBIDDEN, "cross_site_request")
            return False
        return True

    def _session_locked(self):
        self.server._expire_locked()
        cookies = self.headers.get_all("Cookie", [])
        if len(cookies) > 1:
            return None, None
        parsed = SimpleCookie()
        try:
            parsed.load(cookies[0] if cookies else "")
        except CookieError:
            return None, None
        morsel = parsed.get(COOKIE_NAME)
        token = morsel.value if morsel else None
        if not isinstance(token, str) or len(token) != 43:
            return None, None
        return token, self.server.sessions.get(token)

    def do_GET(self):
        if not self._request_allowed():
            return
        if self.path not in ("/", "/api/session"):
            self._error(HTTPStatus.NOT_FOUND, "not_found")
            return
        with self.server.state_lock:
            token, session = self._session_locked()
            set_cookie = None
            if session is None:
                token, session = self.server.new_session_locked()
                set_cookie = token
            if session is None:
                self._error(HTTPStatus.SERVICE_UNAVAILABLE, "local_session_capacity")
                return
            if self.path == "/api/session":
                self._respond(HTTPStatus.OK, {
                    "mode_notice": MODE_NOTICE, "csrf": session["csrf"],
                    "readiness": session["app"].readiness(), "session_ttl_seconds": SESSION_TTL,
                }, cookie=set_cookie)
            else:
                nonce = secrets.token_urlsafe(24)
                html = PAGE.read_text(encoding="utf-8").replace("__CSP_NONCE__", nonce).encode("utf-8")
                self._respond(HTTPStatus.OK, html, content_type="text/html; charset=utf-8", cookie=set_cookie, nonce=nonce)

    def do_POST(self):
        if not self._request_allowed(post=True):
            return
        if self.path not in ("/api/tool", "/api/reset"):
            self._error(HTTPStatus.NOT_FOUND, "not_found")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get_all("Transfer-Encoding") or len(lengths) != 1 or len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit():
            self._error(HTTPStatus.BAD_REQUEST, "invalid_body_length")
            return
        length = int(lengths[0])
        if length < 2 or length > BODY_LIMIT:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_limit")
            return
        content_types = self.headers.get_all("Content-Type", [])
        if len(content_types) != 1 or content_types[0].lower() not in ("application/json", "application/json; charset=utf-8"):
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "json_required")
            return
        try:
            self._body_consumed = True
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Truncated body")
            payload = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_strict_object)
            if not isinstance(payload, dict):
                raise ValueError("Object required")
        except TimeoutError:
            self._error(HTTPStatus.REQUEST_TIMEOUT, "body_timeout")
            return
        except (ValueError, UnicodeError, RecursionError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json")
            return
        with self.server.state_lock:
            token, session = self._session_locked()
            if session is None:
                self._error(HTTPStatus.FORBIDDEN, "session_required")
                return
            csrf_headers = self.headers.get_all("X-Preview-CSRF", [])
            if len(csrf_headers) != 1 or not csrf_headers[0].isascii() or not secrets.compare_digest(csrf_headers[0], session["csrf"]):
                self._error(HTTPStatus.FORBIDDEN, "invalid_csrf")
                return
            if self.path == "/api/reset":
                if payload:
                    self._error(HTTPStatus.BAD_REQUEST, "invalid_reset")
                    return
                session["app"].close()
                del self.server.sessions[token]
                fresh_token, fresh = self.server.new_session_locked()
                self._respond(HTTPStatus.OK, {
                    "mode_notice": MODE_NOTICE, "csrf": fresh["csrf"], "readiness": fresh["app"].readiness(),
                }, cookie=fresh_token)
                return
            if set(payload) != {"name", "arguments"} or not isinstance(payload["name"], str) or payload["name"] not in ALLOWED_TOOLS or not isinstance(payload["arguments"], dict):
                self._error(HTTPStatus.BAD_REQUEST, "invalid_tool_request")
                return
            result = session["app"].dispatch(payload["name"], payload["arguments"])
            self._respond(HTTPStatus.OK, {
                "mode_notice": MODE_NOTICE, "result": result, "readiness": session["app"].readiness(),
            })

    def do_OPTIONS(self):
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed")

    def do_PUT(self):
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed")

    def do_DELETE(self):
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local offline-fixture browser preview. No Qloo API, credentials, or LLM calls.")
    parser.add_argument("--port", type=int, default=8765)
    arguments = parser.parse_args(argv)
    with PreviewServer(arguments.port) as server:
        print(MODE_NOTICE, flush=True)
        print(server.origin + "/", flush=True)
        print("Local preview only. Ctrl+C stops the server and discards sessions.", flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

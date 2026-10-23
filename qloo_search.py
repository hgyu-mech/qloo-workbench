"""Offline search adapter contract, NOT a verified Qloo wire schema.

No network or credential backend is used here. Existing connection-check code
and its cost gate remain independent. A caller-supplied fixture transport is
trusted test code, not a sandbox and never an argument supplied by a web user.
Returned names are untrusted data; consumers must render them as text and must
not turn them into model instructions, HTML, shell commands, or URLs.
"""

import io
import json
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlencode

MAX_RESPONSE_BYTES = 65536
MAX_RESULTS = 5
MAX_QUERY_CHARS = 80
MAX_NAME_CHARS = 160
MAX_JSON_DEPTH = 8
CONTRACT = "offline-search-fixture-v1"
_UUID = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\Z")
_TYPE = re.compile(r"urn:entity:[a-z][a-z_]{0,31}\Z")


class _InvalidResponse(Exception):
    """Internal validation signal. Never carries response content."""


@dataclass(frozen=True, repr=False)
class SearchEntity:
    entity_id: str
    name: str
    types: tuple[str, ...]

    def as_dict(self):
        return {"entityId": self.entity_id, "name": self.name,
                "types": list(self.types)}

    def __repr__(self):
        return "<untrusted search entity>"


@dataclass(frozen=True, repr=False)
class SearchResult:
    status: str
    entities: tuple[SearchEntity, ...] = ()
    transport_attempted: bool = False
    http_status: int | None = None

    def as_dict(self):
        return {"status": self.status, "source": "offline-fixture",
                "contract": CONTRACT, "apiVerified": False,
                "requestAttempted": False,
                "transportAttempted": self.transport_attempted,
                "httpStatus": self.http_status,
                "entities": [entity.as_dict() for entity in self.entities]}

    def __repr__(self):
        return "<offline search result>"


class FixtureResponse:
    """Memory-only response suitable for deterministic offline previews."""

    def __init__(self, body, *, status=200, content_type="application/json"):
        self.status = status
        self.content_type = content_type
        self._body = io.BytesIO(body)
        self.closed = False

    def read(self, size):
        return self._body.read(size)

    def close(self):
        self.closed = True
        self._body.close()


class FixtureTransport:
    """No HTTP, sockets, files, environment or stored credentials are accessed."""

    def __init__(self, body, *, status=200, content_type="application/json"):
        self._body = body
        self._status = status
        self._content_type = content_type

    def open(self, path):
        # The path is deliberately neither retained nor printed.
        return FixtureResponse(self._body, status=self._status,
                               content_type=self._content_type)


def _plain_text(value, limit):
    if type(value) is not str or not value or len(value) > limit:
        return False
    if value != value.strip() or any(unicodedata.category(c).startswith("C")
                                     for c in value):
        return False
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return not any(mark in normalized for mark in
                   ("<", ">", "javascript:", "data:", "http:", "https:"))


def _normalized(value):
    return unicodedata.normalize("NFKC", value).casefold()


def _protected_values(values):
    if type(values) not in (tuple, list) or len(values) > 16:
        raise _InvalidResponse()
    if any(type(v) is not str or not v or len(v) > 4096 for v in values):
        raise _InvalidResponse()
    return tuple(_normalized(v) for v in values)


def _check_depth(text):
    depth = 0
    in_string = escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise _InvalidResponse()
        elif char in "]}":
            depth -= 1


def _object_without_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise _InvalidResponse()
        value[key] = item
    return value


def _reject_constant(value):
    raise _InvalidResponse()


def _extract(body, take, protected):
    # Only this explicit fixture shape is supported. Do not guess alternative
    # providers, endpoints or response envelopes from similar API examples.
    text = body.decode("utf-8", errors="strict")
    _check_depth(text)
    payload = json.loads(text, object_pairs_hook=_object_without_duplicates,
                         parse_constant=_reject_constant)
    if type(payload) is not dict or type(payload.get("results")) is not list:
        raise _InvalidResponse()
    if "success" in payload and payload["success"] is not True:
        raise _InvalidResponse()
    rows = payload["results"]
    if len(rows) > take:
        raise _InvalidResponse()
    projected = []
    seen = set()
    for row in rows:
        if type(row) is not dict:
            raise _InvalidResponse()
        entity_id, name, types = (row.get("entity_id"), row.get("name"),
                                  row.get("types"))
        if (type(entity_id) is not str or not _UUID.fullmatch(entity_id)
                or not _plain_text(name, MAX_NAME_CHARS)
                or type(types) is not list or not 1 <= len(types) <= 3
                or any(type(t) is not str or not _TYPE.fullmatch(t) for t in types)
                or len(set(types)) != len(types)):
            raise _InvalidResponse()
        entity_id = entity_id.lower()
        if entity_id in seen:
            raise _InvalidResponse()
        # Apply protection to every returned string, not only display names.
        # protected_values must include any credential or private prompt that
        # the surrounding trusted test/backend wants forbidden in output.
        if any(token in _normalized(value) for token in protected
               for value in (entity_id, name, *types)):
            raise _InvalidResponse()
        seen.add(entity_id)
        projected.append(SearchEntity(entity_id, name, tuple(types)))
    return tuple(projected)


def search_entities(query, *, take=5, transport=None, protected_values=(),
                    live=False, cost_confirmed=False):
    """Exercise the search adapter with a trusted, memory-only fake transport.

    Live search is deliberately unavailable, even with cost_confirmed=True.
    A cost flag is an acknowledgement, not a provider billing/credit cap.
    Unknown fields (including echoed query/prompt/error metadata) are discarded.
    A name may legitimately equal the short search term; it remains untrusted
    display text. Private full prompts belong in protected_values, not query.
    """
    if type(live) is not bool or type(cost_confirmed) is not bool:
        return SearchResult("INVALID_ARGUMENTS")
    if live:
        return SearchResult("LIVE_SEARCH_NOT_ENABLED" if cost_confirmed else
                            "COST_CONFIRMATION_REQUIRED")
    if (type(take) is not int or not 1 <= take <= MAX_RESULTS
            or not _plain_text(query, MAX_QUERY_CHARS)):
        return SearchResult("INVALID_ARGUMENTS")
    try:
        protected = _protected_values(protected_values)
    except _InvalidResponse:
        return SearchResult("INVALID_ARGUMENTS")
    # Do not send a protected value through even a fixture request path.
    if any(token in _normalized(query) for token in protected):
        return SearchResult("INVALID_ARGUMENTS")
    if transport is None:
        return SearchResult("OFFLINE_TRANSPORT_REQUIRED")
    response = None
    status = None
    attempted = False
    try:
        path = "/search?" + urlencode({"query": query, "take": take})
        attempted = True
        response = transport.open(path)
        if type(response.status) is not int or not 100 <= response.status <= 599:
            return SearchResult("RESPONSE_SCHEMA_INVALID", (), attempted)
        status = response.status
        if status != 200:
            code = ("REDIRECT_BLOCKED" if 300 <= status < 400 else
                    "AUTH_REJECTED" if status in (401, 403) else
                    "PAYMENT_REQUIRED_STOP" if status == 402 else
                    "RATE_LIMITED_STOP" if status == 429 else
                    "HTTP_ERROR")
            return SearchResult(code, (), attempted, status)
        content_type = response.content_type
        if (type(content_type) is not str or len(content_type) > 128
                or content_type.split(";", 1)[0].strip().lower() !=
                "application/json"):
            return SearchResult("CONTENT_TYPE_REJECTED", (), attempted, status)
        chunks = []
        size = 0
        while size <= MAX_RESPONSE_BYTES:
            chunk = response.read(MAX_RESPONSE_BYTES + 1 - size)
            if type(chunk) is not bytes:
                return SearchResult("RESPONSE_SCHEMA_INVALID", (), attempted, status)
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                return SearchResult("RESPONSE_TOO_LARGE", (), attempted, status)
            if not chunk:
                break
            chunks.append(chunk)
        body = b"".join(chunks)
        try:
            entities = _extract(body, take, protected)
        except (UnicodeError, ValueError, RecursionError, _InvalidResponse):
            return SearchResult("RESPONSE_SCHEMA_INVALID", (), attempted, status)
        return SearchResult("OFFLINE_RESULTS_READY", entities, attempted, status)
    except Exception:
        # Never serialize response data, exception strings, paths or tracebacks.
        return SearchResult("OFFLINE_TRANSPORT_ERROR", (), attempted, status)
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass

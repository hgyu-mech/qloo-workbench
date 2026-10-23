"""Server-only Qloo connection check; no credential writes or secret output."""

import ctypes
import http.client
import os
import ssl
from dataclasses import dataclass

HOST = "hackathon.api.qloo.com"
PORT = 443
PATH = "/search?query=Matrix&take=1"
TARGET = "Codex/Qloo/AgenticHackathon"
USERNAME = "QLOO_API_KEY"
TIMEOUT_SECONDS = 15
MAX_BLOB_BYTES = 4096


class ConnectorError(Exception):
    """Only predefined, non-sensitive codes cross the module boundary."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


class _Secret:
    """Short-lived secret container; its string representations are redacted."""

    __slots__ = ("_value",)

    def __init__(self, value):
        self._value = value

    def __repr__(self):
        return "<Qloo credential: redacted>"

    __str__ = __repr__

    def close(self):
        # Python strings cannot promise guaranteed memory erasure.
        self._value = None


def _decode_secret(blob):
    if not blob or len(blob) > MAX_BLOB_BYTES or len(blob) % 2:
        raise ConnectorError("CREDENTIAL_FORMAT_INVALID")
    try:
        value = blob.decode("utf-16-le", errors="strict")
    except (UnicodeError, AttributeError):
        raise ConnectorError("CREDENTIAL_FORMAT_INVALID") from None
    if not value or len(value) > 1024 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ConnectorError("CREDENTIAL_FORMAT_INVALID")
    return _Secret(value)


class _FILETIME(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]


class _CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", ctypes.c_uint32), ("Type", ctypes.c_uint32),
        ("TargetName", ctypes.c_wchar_p), ("Comment", ctypes.c_wchar_p),
        ("LastWritten", _FILETIME), ("CredentialBlobSize", ctypes.c_uint32),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", ctypes.c_uint32), ("AttributeCount", ctypes.c_uint32),
        ("Attributes", ctypes.c_void_p), ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


def _consume_credential(pointer, free):
    """Also used with an in-memory fake structure by the offline tests."""
    raw = None
    try:
        cred = pointer.contents
        if cred.Type != 1 or cred.TargetName != TARGET or cred.UserName != USERNAME:
            raise ConnectorError("CREDENTIAL_IDENTITY_MISMATCH")
        size = int(cred.CredentialBlobSize)
        if not cred.CredentialBlob or size < 2 or size > MAX_BLOB_BYTES or size % 2:
            raise ConnectorError("CREDENTIAL_FORMAT_INVALID")
        raw = bytearray(cred.CredentialBlob[:size])
        return _decode_secret(raw)
    except ConnectorError:
        raise
    except Exception:
        raise ConnectorError("CREDENTIAL_READ_FAILED") from None
    finally:
        try:
            if raw is not None:
                raw[:] = b"\x00" * len(raw)
        finally:
            free(pointer)


def read_windows_credential():
    """Reads exactly one existing generic credential; never enumerates/writes."""
    if os.name != "nt":
        raise ConnectorError("WINDOWS_REQUIRED")
    try:
        api = ctypes.WinDLL("Advapi32.dll", use_last_error=True, winmode=0x00000800)
        pointer_type = ctypes.POINTER(_CREDENTIALW)
        api.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32,
                                 ctypes.c_uint32, ctypes.POINTER(pointer_type)]
        api.CredReadW.restype = ctypes.c_int
        api.CredFree.argtypes = [ctypes.c_void_p]
        api.CredFree.restype = None
        pointer = pointer_type()
        if not api.CredReadW(TARGET, 1, 0, ctypes.byref(pointer)):
            code = ctypes.get_last_error()
            statuses = {1168: "CREDENTIAL_NOT_FOUND",
                        1312: "CREDENTIAL_SESSION_UNAVAILABLE",
                        5: "CREDENTIAL_ACCESS_DENIED"}
            raise ConnectorError(statuses.get(code, "CREDENTIAL_READ_FAILED"))
        return _consume_credential(pointer, api.CredFree)
    except ConnectorError:
        raise
    except Exception:
        raise ConnectorError("CREDENTIAL_BACKEND_UNAVAILABLE") from None


@dataclass(frozen=True)
class CheckResult:
    status: str
    credential_ready: bool = False
    request_attempted: bool = False
    http_status: int | None = None

    def as_dict(self):
        return {"status": self.status, "credentialReady": self.credential_ready,
                "requestAttempted": self.request_attempted,
                "httpStatus": self.http_status}


def _request(secret, *, connection_factory=http.client.HTTPSConnection):
    """One fixed GET, no proxies, redirects, retry or response-body logging."""
    connection = None
    attempted = False
    try:
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        connection = connection_factory(HOST, PORT, timeout=TIMEOUT_SECONDS,
                                        context=context)
        # Do not allow debuglevel=1: http.client would print the auth header.
        connection.set_debuglevel(0)
        attempted = True
        connection.request("GET", PATH, headers={"X-Api-Key": secret._value,
                           "Accept": "application/json",
                           "User-Agent": "QlooLocalConnectionCheck/1.0",
                           "Connection": "close"})
        response = connection.getresponse()
        status = int(response.status)
        # The body may echo credentials or include arbitrary server content.
        # Do not read it, store it, forward it, or expose response headers.
        if 200 <= status < 300:
            code = "API_RESPONDED"
        elif 300 <= status < 400:
            code = "REDIRECT_BLOCKED"
        elif status in (401, 403):
            code = "AUTH_REJECTED"
        elif status == 402:
            code = "PAYMENT_REQUIRED_STOP"
        elif status == 429:
            code = "RATE_LIMITED_STOP"
        else:
            code = "HTTP_ERROR"
        return CheckResult(code, True, attempted, status)
    except ssl.SSLError:
        return CheckResult("TLS_ERROR", True, attempted)
    except TimeoutError:
        return CheckResult("NETWORK_TIMEOUT", True, attempted)
    except Exception:
        # Never serialize exception text, request objects or a traceback.
        return CheckResult("NETWORK_ERROR", True, attempted)
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def check_connection(*, live=False, cost_confirmed=False,
                     credential_reader=read_windows_credential,
                     connection_factory=http.client.HTTPSConnection):
    """Default is local readiness only; a live check needs an explicit cost gate."""
    if live and not cost_confirmed:
        return CheckResult("COST_CONFIRMATION_REQUIRED")
    secret = None
    try:
        secret = credential_reader()
        if not isinstance(secret, _Secret) or secret._value is None:
            return CheckResult("CREDENTIAL_READ_FAILED")
        if not live:
            return CheckResult("LOCAL_READY_NETWORK_NOT_RUN", True)
        return _request(secret, connection_factory=connection_factory)
    except ConnectorError as exc:
        allowed = {"WINDOWS_REQUIRED", "CREDENTIAL_NOT_FOUND", "CREDENTIAL_READ_FAILED",
                   "CREDENTIAL_FORMAT_INVALID", "CREDENTIAL_IDENTITY_MISMATCH",
                   "CREDENTIAL_SESSION_UNAVAILABLE", "CREDENTIAL_ACCESS_DENIED",
                   "CREDENTIAL_BACKEND_UNAVAILABLE"}
        return CheckResult(exc.code if exc.code in allowed else "CREDENTIAL_READ_FAILED")
    except Exception:
        return CheckResult("CREDENTIAL_READ_FAILED")
    finally:
        if isinstance(secret, _Secret):
            secret.close()

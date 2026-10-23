"""Run Python suites while making accidental network/credential access fail."""
import contextlib
import ctypes
import io
import json
import socket
import unittest
from unittest.mock import patch

import qloo_connector
import test_connector
import test_search
import test_workflow
import test_agent
import test_taste_product
import test_live_runtime


def main():
    suite = unittest.TestSuite([
        unittest.defaultTestLoader.loadTestsFromModule(test_connector),
        unittest.defaultTestLoader.loadTestsFromModule(test_search),
        unittest.defaultTestLoader.loadTestsFromModule(test_workflow),
        unittest.defaultTestLoader.loadTestsFromModule(test_agent),
        unittest.defaultTestLoader.loadTestsFromModule(test_taste_product),
        unittest.defaultTestLoader.loadTestsFromModule(test_live_runtime),
    ])
    log = io.StringIO()
    # Original tests that simulate WinDLL install their own nested mocks.
    # Any unmocked access must hit these guards and fail instead of executing.
    with patch.object(socket, "socket", side_effect=AssertionError("NETWORK_FORBIDDEN")) as net, \
         patch.object(ctypes, "WinDLL", side_effect=AssertionError("CREDENTIAL_BACKEND_FORBIDDEN"),
                      create=True) as creds:
        result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    print(log.getvalue(), end="")
    print(json.dumps({"testsRun": result.testsRun, "passed": result.wasSuccessful(),
                      "failures": len(result.failures), "errors": len(result.errors),
                      "networkGuardCalls": net.call_count,
                      "credentialGuardCalls": creds.call_count,
                      "apiCalls": 0, "realCredentialsRead": False}))
    return 0 if result.wasSuccessful() and not net.call_count and not creds.call_count else 1


if __name__ == "__main__":
    raise SystemExit(main())

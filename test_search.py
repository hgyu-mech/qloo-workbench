"""Regression cases for the local fixture contract, never live Qloo traffic."""
import contextlib
import io
import json
import unittest
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import qloo_search as qs

FAKE_KEY = "FAKE-TEST-ONLY-NOT-A-REAL-QLOO-KEY"
PRIVATE_PROMPT = "private prompt never for output"
ENTITY_ID = "369D1544-628B-4C21-95A0-1488117A308A"


def row(**changes):
    result = {"entity_id": ENTITY_ID, "name": "The Matrix",
              "types": ["urn:entity:movie"]}
    result.update(changes)
    return result


def encode(rows, **extra):
    return json.dumps({"results": rows, **extra}).encode("utf-8")


class TrackingResponse(qs.FixtureResponse):
    def __init__(self, *args, chunk_size=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.read_sizes = []
        self.chunk_size = chunk_size

    def read(self, size):
        self.read_sizes.append(size)
        return super().read(min(size, self.chunk_size) if self.chunk_size else size)


class TrackingTransport:
    def __init__(self, response):
        self.response = response
        self.paths = []

    def open(self, path):
        self.paths.append(path)
        return self.response


class SearchTests(unittest.TestCase):
    def run_body(self, body, **kwargs):
        response = TrackingResponse(body, **kwargs.pop("response_options", {}))
        transport = TrackingTransport(response)
        result = qs.search_entities("Matrix", transport=transport,
                                    protected_values=(FAKE_KEY, PRIVATE_PROMPT),
                                    **kwargs)
        self.assertTrue(response.closed)
        return result, response, transport

    def test_projection_drops_unknown_query_prompt_headers_and_urls(self):
        body = encode([row(properties={"url": "javascript:alert(1)",
                                       "prompt": PRIVATE_PROMPT},
                           debug=FAKE_KEY)], query=PRIVATE_PROMPT,
                      headers={"X-Api-Key": FAKE_KEY})
        result, response, transport = self.run_body(body)
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")
        data = result.as_dict()
        self.assertEqual(data["entities"], [{"entityId": ENTITY_ID.lower(),
                                           "name": "The Matrix",
                                           "types": ["urn:entity:movie"]}])
        self.assertFalse(data["apiVerified"])
        self.assertFalse(data["requestAttempted"])
        self.assertEqual(data["source"], "offline-fixture")
        self.assertNotIn(FAKE_KEY, json.dumps(data))
        self.assertNotIn(PRIVATE_PROMPT, json.dumps(data))
        self.assertEqual(len(transport.paths), 1)

    def test_live_stays_blocked_even_with_cost_flag_before_transport(self):
        transport = Mock()
        for cost, expected in ((False, "COST_CONFIRMATION_REQUIRED"),
                               (True, "LIVE_SEARCH_NOT_ENABLED")):
            result = qs.search_entities("Matrix", transport=transport,
                                        live=True, cost_confirmed=cost)
            self.assertEqual(result.status, expected)
            self.assertFalse(result.transport_attempted)
        transport.open.assert_not_called()

    def test_default_has_no_credential_or_transport_action(self):
        result = qs.search_entities("Matrix")
        self.assertEqual(result.status, "OFFLINE_TRANSPORT_REQUIRED")
        self.assertFalse(result.transport_attempted)

    def test_query_parameters_encoded_without_parameter_injection(self):
        query = "영화 & take=99?#"
        transport = TrackingTransport(TrackingResponse(encode([])))
        result = qs.search_entities(query, take=2, transport=transport)
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")
        path = urlsplit(transport.paths[0])
        self.assertEqual(path.path, "/search")
        self.assertEqual(path.fragment, "")
        self.assertEqual(parse_qs(path.query), {"query": [query], "take": ["2"]})

    def test_invalid_arguments_never_reach_transport(self):
        transport = Mock()
        cases = ({"query": ""}, {"query": "x" * 81}, {"query": "x\ny"},
                 {"query": "<script>"}, {"query": "\u202eevil"},
                 {"query": " x"}, {"query": None}, {"take": True},
                 {"take": 0}, {"take": 6}, {"take": 1.5},
                 {"live": "yes"}, {"cost_confirmed": 1},
                 {"protected_values": FAKE_KEY},
                 {"protected_values": ("",)},
                 {"protected_values": ("x" * 4097,)},
                 {"protected_values": tuple("p" for _ in range(17))})
        for changes in cases:
            with self.subTest(changes=list(changes)):
                args = {"query": "Matrix", "transport": transport, **changes}
                self.assertEqual(qs.search_entities(**args).status, "INVALID_ARGUMENTS")
        transport.open.assert_not_called()

    def test_protected_value_cannot_be_used_as_query(self):
        transport = Mock()
        result = qs.search_entities(FAKE_KEY.lower(), transport=transport,
                                    protected_values=(FAKE_KEY,))
        self.assertEqual(result.status, "INVALID_ARGUMENTS")
        transport.open.assert_not_called()

    def test_secret_and_private_prompt_rejected_in_every_projected_field(self):
        variants = [(row(name="Title " + FAKE_KEY.lower()), (FAKE_KEY,)),
                    (row(name=PRIVATE_PROMPT), (PRIVATE_PROMPT,)),
                    (row(entity_id=ENTITY_ID), (ENTITY_ID.lower(),)),
                    (row(types=["urn:entity:movie"]), ("urn:entity:movie",)),
                    (row(name="ＦＡＫＥ"), ("fake",))]
        for entity, protected in variants:
            transport = qs.FixtureTransport(encode([entity]))
            result = qs.search_entities("Matrix", transport=transport,
                                        protected_values=protected)
            self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")
            self.assertEqual(result.entities, ())

    def test_valid_empty_results_are_not_schema_failure(self):
        result, _, _ = self.run_body(encode([]))
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")
        self.assertEqual(result.entities, ())

    def test_legitimate_title_equal_to_query_is_untrusted_display_data(self):
        result = qs.search_entities("The Matrix",
                                    transport=qs.FixtureTransport(encode([row()])))
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")
        self.assertEqual(repr(result), "<offline search result>")
        self.assertEqual(repr(result.entities[0]), "<untrusted search entity>")

    def test_response_size_limit_and_fragmented_reads(self):
        valid = encode([row()])
        for body, expected in ((valid + b" " * (qs.MAX_RESPONSE_BYTES - len(valid)),
                                "OFFLINE_RESULTS_READY"),
                               (valid + b" " * (qs.MAX_RESPONSE_BYTES + 1 - len(valid)),
                                "RESPONSE_TOO_LARGE")):
            result, response, _ = self.run_body(body)
            self.assertEqual(result.status, expected)
            self.assertTrue(all(0 < n <= qs.MAX_RESPONSE_BYTES + 1
                                for n in response.read_sizes))
        result, response, _ = self.run_body(valid, response_options={"chunk_size": 7})
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")
        self.assertGreater(len(response.read_sizes), 2)
        # A valid JSON prefix does not hide malformed data in a later chunk.
        result, _, _ = self.run_body(valid + b"not-json",
                                     response_options={"chunk_size": len(valid)})
        self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")

    def test_invalid_utf8_json_duplicate_keys_nan_and_depth_fail_closed(self):
        bodies = (b"\xff", b"", b"not-json", b'{"results":[],"results":[]}',
                  b'{"results":[],"unused":NaN}',
                  b'{"results":[],"unused":' + b"[" * 9 + b"]" * 9 + b"}")
        for body in bodies:
            result, _, _ = self.run_body(body)
            self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")

    def test_schema_shape_wrong_field_types_and_oversized_names_rejected(self):
        entities = [None, [], {}, row(entity_id=123), row(entity_id="not-a-uuid"),
                    row(name=[]), row(name=""), row(name="n" * 161),
                    row(types="urn:entity:movie"), row(types=[]),
                    row(types=[True]), row(types=["urn:entity:movie"] * 2),
                    row(types=["urn:entity:movie", "urn:entity:book",
                               "urn:entity:artist", "urn:entity:place"])]
        bodies = [b"[]", b'{"results":{}}', b'{"results":[],"success":false}']
        bodies += [encode([entity]) for entity in entities]
        for body in bodies:
            result, _, _ = self.run_body(body)
            self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")

    def test_count_and_duplicate_ids_rejected_without_partial_success(self):
        for entities, take in (([row(), row()], 5), ([row(), row()], 1)):
            result, _, _ = self.run_body(encode(entities), take=take)
            self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")
            self.assertEqual(result.entities, ())

    def test_markup_control_bidi_and_url_names_rejected(self):
        for name in ("<svg onload=evil>", "title\r\nheader", "a\x00b",
                     "safe\u202eevil", "javascript:evil", "DATA:text/html,evil",
                     "https://example.com", "＜script＞", " title"):
            result, _, _ = self.run_body(encode([row(name=name)]))
            self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")

    def test_all_non_200_statuses_close_without_body_reads(self):
        for status, expected in ((204, "HTTP_ERROR"), (301, "REDIRECT_BLOCKED"),
                                 (302, "REDIRECT_BLOCKED"), (307, "REDIRECT_BLOCKED"),
                                 (308, "REDIRECT_BLOCKED"), (401, "AUTH_REJECTED"),
                                 (403, "AUTH_REJECTED"), (402, "PAYMENT_REQUIRED_STOP"),
                                 (429, "RATE_LIMITED_STOP"), (500, "HTTP_ERROR")):
            result, response, transport = self.run_body(FAKE_KEY.encode(),
                                                        response_options={"status": status})
            self.assertEqual(result.status, expected)
            self.assertEqual(response.read_sizes, [])
            self.assertEqual(len(transport.paths), 1)

    def test_content_type_rejected_before_read(self):
        for value in ("text/html", "application/json" + "x" * 129, None):
            result, response, _ = self.run_body(encode([]),
                                                response_options={"content_type": value})
            self.assertEqual(result.status, "CONTENT_TYPE_REJECTED")
            self.assertEqual(response.read_sizes, [])
        result, _, _ = self.run_body(encode([]),
                                     response_options={"content_type": "application/json; charset=utf-8"})
        self.assertEqual(result.status, "OFFLINE_RESULTS_READY")

    def test_transport_exception_and_bad_read_never_reach_output(self):
        for operation in ("open", "read", "close"):
            response = TrackingResponse(encode([]))
            transport = TrackingTransport(response)
            def fail(*args):
                raise RuntimeError(FAKE_KEY + PRIVATE_PROMPT)
            target = transport if operation == "open" else response
            setattr(target, operation, fail)
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                result = qs.search_entities("Matrix", transport=transport)
            self.assertEqual(out.getvalue() + err.getvalue(), "")
            self.assertNotIn(FAKE_KEY, json.dumps(result.as_dict()))
            self.assertEqual(result.status, "OFFLINE_RESULTS_READY" if operation == "close"
                             else "OFFLINE_TRANSPORT_ERROR")
            if operation == "read":
                self.assertTrue(response.closed)
        response = TrackingResponse(encode([]))
        response.read = lambda size: "not-bytes"
        result = qs.search_entities("Matrix", transport=TrackingTransport(response))
        self.assertEqual(result.status, "RESPONSE_SCHEMA_INVALID")
        self.assertTrue(response.closed)

    def test_result_output_schema_is_bounded_and_does_not_include_request(self):
        result, _, _ = self.run_body(encode([row()]))
        self.assertEqual(set(result.as_dict()),
                         {"status", "source", "contract", "apiVerified", "requestAttempted",
                          "transportAttempted", "httpStatus", "entities"})
        serialized = json.dumps(result.as_dict(), ensure_ascii=True)
        self.assertLess(len(serialized), 1024)
        self.assertNotIn("/search?", serialized)
        self.assertNotIn("protected_values", serialized)


if __name__ == "__main__":
    unittest.main()

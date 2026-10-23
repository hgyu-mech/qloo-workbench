"""Product-flow acceptance cases, never real API data or user credentials."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

import qloo_search
import qloo_workbench as cli
import qloo_workflow as workflow


class WorkflowTests(unittest.TestCase):
    def test_user_input_changes_result_order_with_auditable_reasons(self):
        calm = workflow.run_workflow("space", category="movie", mood="calm")
        energetic = workflow.run_workflow("space", category="movie", mood="energetic")
        self.assertEqual(calm["recommendations"][0]["entity"]["name"], "Orbit Lantern")
        self.assertEqual(energetic["recommendations"][0]["entity"]["name"], "Rocket Parade")
        self.assertIn("Matches the requested mood", energetic["recommendations"][0]["reasons"][1])
        self.assertIn("tag is absent", energetic["recommendations"][1]["reasons"][1])
        self.assertEqual(energetic, workflow.run_workflow("space", mood="energetic"))
        self.assertEqual(len(calm["plan"]), 3)
        self.assertFalse(calm["verification"]["modelOrAgentExecuted"])
        multi = workflow.run_workflow("space adventure", mood="calm")
        self.assertEqual(multi["recommendations"][0]["entity"]["name"], "Rocket Parade")
        self.assertIn("2 requested keyword(s)", multi["recommendations"][0]["reasons"][0])
        self.assertIn("keyword-overlap count", multi["plan"][1])

    def test_category_limit_and_existing_adapter_are_used(self):
        original = qloo_search.search_entities
        with patch.object(qloo_search, "search_entities", wraps=original) as adapter:
            result = workflow.run_workflow("robot", category="book", limit=1)
        adapter.assert_called_once()
        self.assertIsInstance(adapter.call_args.kwargs["transport"], qloo_search.FixtureTransport)
        self.assertEqual(result["recommendations"][0]["entity"]["name"], "Paper Automaton")
        self.assertEqual(result["recommendations"][0]["entity"]["types"], ["urn:entity:book"])
        self.assertFalse(result["apiVerified"])
        self.assertFalse(result["requestAttempted"])
        self.assertEqual(result["source"], "offline-fixture")

    def test_no_match_is_explicit_without_invented_fallback(self):
        result = workflow.run_workflow("unmatchedkeyword")
        self.assertEqual(result["status"], "NO_MATCHES")
        self.assertEqual(result["recommendations"], [])
        self.assertIn("No result was invented", result["emptyState"])
        self.assertNotIn("unmatchedkeyword", json.dumps(result))

    def test_invalid_inputs_and_live_gate_do_not_open_transport(self):
        with patch.object(qloo_search.FixtureTransport, "open", side_effect=AssertionError) as opened:
            for changes in ({"category": "unknown"}, {"mood": "unknown"},
                            {"limit": True}, {"limit": 6}, {"query": "bad\ninput"}):
                args = {"query": "space", **changes}
                self.assertEqual(workflow.run_workflow(**args)["status"], "INVALID_ARGUMENTS")
            for cost, status in ((False, "COST_CONFIRMATION_REQUIRED"),
                                  (True, "LIVE_SEARCH_NOT_ENABLED")):
                self.assertEqual(workflow.run_workflow("space", live=True,
                                                       cost_confirmed=cost)["status"], status)
        opened.assert_not_called()

    def test_cli_human_and_json_result_paths_and_synthetic_provenance(self):
        for json_mode in (False, True):
            out = io.StringIO()
            args = ["--query", "space", "--mood", "energetic"]
            if json_mode:
                args.append("--json")
            with contextlib.redirect_stdout(out):
                code = cli.main(args)
            self.assertEqual(code, 0)
            text = out.getvalue()
            self.assertIn("SYNTHETIC / NO LIVE", text)
            self.assertIn("Rocket Parade", text)
            self.assertIn("synthetic-catalog-v1", text)
            if json_mode:
                result = json.loads(text)
                self.assertTrue(all(item["synthetic"] and not item["apiVerified"]
                                    for item in result["recommendations"]))
            else:
                self.assertIn("Why:", text)
                self.assertIn("API NOT VERIFIED", text)
        exact = workflow.run_workflow("Orbit Lantern")
        self.assertEqual(exact["recommendations"][0]["entity"]["name"], "Orbit Lantern")
        self.assertFalse(exact["inputSummary"]["rawQueryFieldIncluded"])
        self.assertFalse(exact["inputSummary"]["querySaved"])

    def test_cli_unknown_arguments_do_not_echo_and_unexpected_errors_are_fixed(self):
        marker = "FAKE-PRIVATE-ARGUMENT-ONLY"
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(["--query", "space", "--unknown", marker])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["status"], "INVALID_ARGUMENTS")
        self.assertNotIn(marker, out.getvalue() + err.getvalue())
        self.assertEqual(err.getvalue(), "")
        out = io.StringIO()
        with patch.object(cli, "run_workflow", side_effect=RuntimeError(marker)), \
             contextlib.redirect_stdout(out):
            code = cli.main(["--query", "space"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["status"], "INTERNAL_ERROR")
        self.assertNotIn(marker, out.getvalue())

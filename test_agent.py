"""CPU fixtures for tool contracts, bounded retries and citation integrity."""
import contextlib
import copy
import io
import json
import unittest
from unittest.mock import Mock, patch

import qloo_agent as agent
import qloo_workbench as cli
import qloo_workflow as workflow

ARGS = {"query": "space", "category": "movie", "mood": "curious", "limit": 3}
MARKER = "FAKE-PRIVATE-ERROR-ONLY"


class AgentTests(unittest.TestCase):
    def response(self):
        return agent.FixtureBackend().search(dict(ARGS))

    def backend(self, response=None):
        backend = Mock()
        backend.search.return_value = self.response() if response is None else response
        return backend

    def test_definition_is_strict_and_cannot_mutate_registry(self):
        definition = agent.tool_definition()
        self.assertEqual(definition["function"]["name"], "qloo_search")
        schema = definition["function"]["parameters"]
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(ARGS))
        definition["function"]["name"] = "evil"
        self.assertEqual(agent.tool_definition()["function"]["name"], "qloo_search")

    def test_existing_workflow_is_reused_and_citations_are_entity_specific(self):
        with patch.object(workflow, "run_workflow", wraps=workflow.run_workflow) as original:
            result = agent.run_agent("space", mood="energetic")
        original.assert_called_once()
        self.assertEqual(result["status"], "AGENT_PLAN_READY")
        self.assertEqual(result["recommendations"][0]["entity"]["name"], "Rocket Parade")
        proof = {p["id"]: p for p in result["evidence"]}
        for item in result["recommendations"]:
            self.assertTrue(item["evidenceIds"])
            for cid in item["evidenceIds"]:
                self.assertEqual(proof[cid]["entityId"], item["entity"]["entityId"])
                self.assertEqual(proof[cid]["matchedKeywords"], ["space"])
                self.assertTrue(proof[cid]["synthetic"])
                self.assertFalse(proof[cid]["apiVerified"])
        self.assertTrue(result["orchestratorExecuted"])
        self.assertFalse(result["modelExecuted"])
        self.assertFalse(result["requestAttempted"])
        self.assertFalse(result["apiVerified"])

    def test_invalid_or_unknown_tool_arguments_do_not_call_backend(self):
        backend = self.backend()
        tool = agent.SearchTool(backend)
        cases = [None, [], {}, {**ARGS, "extra": "ignored?"}, {**ARGS, "limit": True},
                 {**ARGS, "limit": 6}, {**ARGS, "category": "unknown"},
                 {**ARGS, "query": " bad"}, {**ARGS, "query": "x\ny"},
                 {**ARGS, "query": "<script>"}, {**ARGS, "query": "x" * 81},
                 '{"query":"space","query":"robot"}', '{"unused":NaN}',
                 "[" * 2000]
        for args in cases:
            with self.subTest(args_type=type(args).__name__):
                self.assertEqual(tool.dispatch("qloo_search", args)["status"], "INVALID_ARGUMENTS")
        self.assertEqual(tool.dispatch("exec", ARGS)["status"], "UNKNOWN_TOOL")
        backend.search.assert_not_called()

    def test_json_arguments_are_accepted_and_input_is_not_echoed(self):
        result = agent.SearchTool().dispatch("qloo_search", json.dumps(ARGS))
        self.assertEqual(result["status"], "RESULTS_READY")
        self.assertNotIn("arguments", result)
        self.assertNotIn("query", result)
        self.assertEqual(result["attempts"], 1)

    def test_evidence_missing_wrong_source_or_fabricated_entity_rejects_whole_result(self):
        valid = self.response()
        variants = []
        missing = copy.deepcopy(valid); missing["evidence"].pop(); variants.append(missing)
        wrong = copy.deepcopy(valid); wrong["evidence"][0]["source"] = "live-qloo"; variants.append(wrong)
        synthetic = copy.deepcopy(valid); synthetic["evidence"][0]["synthetic"] = False; variants.append(synthetic)
        tags = copy.deepcopy(valid); tags["evidence"][0]["moodTags"] = ["energetic"]; variants.append(tags)
        unknown = copy.deepcopy(valid); unknown["entities"][0]["name"] = "Invented new title"; variants.append(unknown)
        duplicate = copy.deepcopy(valid); duplicate["evidence"][1] = duplicate["evidence"][0]; variants.append(duplicate)
        extra = copy.deepcopy(valid); extra["evidence"].append(extra["evidence"][0]); variants.append(extra)
        for value in variants:
            backend = self.backend(value)
            result = agent.SearchTool(backend).dispatch("qloo_search", ARGS)
            self.assertEqual(result["status"], "EVIDENCE_MISSING_OR_INVALID")
            self.assertEqual(result["recommendations"], [])
            self.assertEqual(result["evidence"], [])
            backend.search.assert_called_once()

    def test_schema_and_untrusted_names_do_not_enter_agent_output(self):
        for mutate in (lambda p: p.update(debug=MARKER),
                       lambda p: p["entities"][0].update(name="<script>"),
                       lambda p: p["entities"][0].update(types=[]),
                       lambda p: p["entities"][0].update(entityId="not-uuid")):
            response = self.response();mutate(response)
            result = agent.run_agent("space", tool=agent.SearchTool(self.backend(response)))
            self.assertEqual(result["status"], "RESPONSE_CONTRACT_INVALID")
            self.assertEqual(result["recommendations"], [])
            self.assertNotIn(MARKER, json.dumps(result))

    def test_timeout_retries_once_and_records_recovery(self):
        backend = self.backend()
        backend.search.side_effect = [TimeoutError(MARKER), self.response()]
        result = agent.run_agent("space", tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "AGENT_PLAN_READY")
        tool_result = result["toolMessages"][0]["result"]
        self.assertEqual(result["backendAttempts"], 2)
        self.assertEqual(tool_result["retries"], 1)
        self.assertEqual([p["status"]for p in tool_result["trace"]], ["TEMPORARY_FAILURE", "RESULTS_READY"])
        self.assertNotIn(MARKER, json.dumps(result))

    def test_persistent_temporary_failure_stops_at_two_attempts(self):
        backend = self.backend();backend.search.side_effect = ConnectionError(MARKER)
        result = agent.run_agent("space", tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "TEMPORARY_FAILURE")
        self.assertEqual(backend.search.call_count, 2)
        self.assertEqual(result["backendAttempts"], 2)
        self.assertEqual(result["recommendations"], [])

    def test_auth_payment_rate_and_redirect_failures_never_retry(self):
        for code in ("AUTH_REJECTED", "PAYMENT_REQUIRED_STOP", "RATE_LIMITED_STOP", "REDIRECT_BLOCKED"):
            backend = self.backend();backend.search.side_effect = agent.BackendFailure(code)
            result = agent.run_agent("space", tool=agent.SearchTool(backend))
            self.assertEqual(result["status"], code)
            backend.search.assert_called_once()

    def test_backend_exceptions_are_sanitized_and_do_not_write_logs(self):
        backend = self.backend();backend.search.side_effect = RuntimeError(MARKER)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = agent.run_agent("space", tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "BACKEND_ERROR")
        self.assertEqual(out.getvalue() + err.getvalue(), "")
        self.assertNotIn(MARKER, json.dumps(result))
        backend.search.assert_called_once()

    def test_missing_evidence_is_not_retried_or_replaced_with_invented_answer(self):
        response = self.response();response["evidence"] = []
        backend = self.backend(response)
        result = agent.run_agent("space", tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "EVIDENCE_MISSING_OR_INVALID")
        self.assertEqual(result["recommendations"], [])
        backend.search.assert_called_once()

    def test_plans_are_fully_checked_before_any_tool_execution(self):
        valid = {"id": "one", "name": "qloo_search", "arguments": dict(ARGS)}
        invalid = [None, [], [valid] * 4, [valid, valid],
                   [{**valid, "id": "bad\nid"}], [{**valid, "name": "exec"}],
                   [{**valid, "arguments": {**ARGS, "category": "book"}}],
                   [valid, {**valid, "id": "two", "arguments": {**ARGS, "limit": 5}}]]
        backend = self.backend()
        for calls in invalid:
            planner = Mock();planner.plan.return_value = calls
            result = agent.run_agent("space", planner=planner, tool=agent.SearchTool(backend))
            self.assertEqual(result["status"], "PLAN_REJECTED")
            self.assertEqual(result["backendAttempts"], 0)
        backend.search.assert_not_called()

    def test_planner_exception_is_fixed_and_never_calls_backend(self):
        planner = Mock();planner.plan.side_effect = RuntimeError(MARKER)
        backend = self.backend()
        result = agent.run_agent("space", planner=planner, tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "PLAN_REJECTED")
        self.assertNotIn(MARKER, json.dumps(result))
        backend.search.assert_not_called()

    def test_three_calls_share_four_attempt_budget(self):
        planner = Mock();planner.plan.return_value = [
            {"id": str(i), "name": "qloo_search", "arguments": dict(ARGS)} for i in range(3)]
        backend = self.backend();backend.search.side_effect = TimeoutError(MARKER)
        result = agent.run_agent("space", planner=planner, tool=agent.SearchTool(backend))
        self.assertEqual(backend.search.call_count, 4)
        self.assertEqual(result["backendAttempts"], 4)
        self.assertEqual(result["toolMessages"][-1]["result"]["status"], "ATTEMPT_BUDGET_EXHAUSTED")

    def test_success_and_failure_are_both_visible_in_partial_results(self):
        planner = Mock();planner.plan.return_value = [
            {"id": str(i), "name": "qloo_search", "arguments": dict(ARGS)} for i in range(2)]
        backend = self.backend();backend.search.side_effect = [self.response(), agent.BackendFailure("AUTH_REJECTED")]
        result = agent.run_agent("space", planner=planner, tool=agent.SearchTool(backend))
        self.assertEqual(result["status"], "PARTIAL_RESULTS")
        self.assertTrue(result["recommendations"])
        self.assertEqual(result["toolMessages"][1]["result"]["status"], "AUTH_REJECTED")

    def test_empty_results_and_mood_absence_stay_explicit(self):
        empty = agent.run_agent("unknownkeyword")
        self.assertEqual(empty["status"], "NO_MATCHES")
        self.assertEqual(empty["evidence"], [])
        self.assertIn("No result was invented", agent.render_agent_text(empty))
        result = agent.run_agent("Orbit Lantern", mood="energetic", limit=1)
        self.assertFalse(result["evidence"][0]["moodTagPresent"])
        self.assertIn("absent", result["recommendations"][0]["reasons"][1])

    def test_category_limit_and_duplicate_calls_never_duplicate_results(self):
        result = agent.run_agent("robot", category="book", limit=1)
        self.assertEqual(result["recommendations"][0]["entity"]["name"], "Paper Automaton")
        planner = Mock();planner.plan.return_value = [
            {"id": str(i), "name": "qloo_search", "arguments": dict(ARGS)} for i in range(2)]
        result = agent.run_agent("space", planner=planner)
        self.assertEqual(len(result["recommendations"]), 2)
        self.assertEqual(len(result["evidence"]), 2)

    def test_live_gate_precedes_planner_and_backend_even_with_cost_flag(self):
        planner, backend = Mock(), self.backend()
        for cost, status in ((False, "COST_CONFIRMATION_REQUIRED"), (True, "LIVE_SEARCH_NOT_ENABLED")):
            result = agent.run_agent("space", live=True, cost_confirmed=cost,
                                     planner=planner, tool=agent.SearchTool(backend))
            self.assertEqual(result["status"], status)
        planner.plan.assert_not_called();backend.search.assert_not_called()

    def test_fatal_failure_stops_remaining_plan(self):
        for prefix_success in (False, True):
            for status in ("AUTH_REJECTED", "PAYMENT_REQUIRED_STOP", "RATE_LIMITED_STOP",
                           "REDIRECT_BLOCKED", "BACKEND_ERROR",
                           "RESPONSE_CONTRACT_INVALID", "EVIDENCE_MISSING_OR_INVALID"):
                with self.subTest(prefix_success=prefix_success, status=status):
                    planner = Mock()
                    planner.plan.return_value = [
                        {"id": str(i), "name": "qloo_search", "arguments": dict(ARGS)}
                        for i in range(3)]
                    if status == "RESPONSE_CONTRACT_INVALID":
                        failure = {"unexpected": True}
                    elif status == "EVIDENCE_MISSING_OR_INVALID":
                        failure = self.response()
                        failure["evidence"] = []
                    else:
                        failure = agent.BackendFailure(status)
                    backend = self.backend()
                    backend.search.side_effect = (([self.response()] if prefix_success else [])
                                                  + [failure, self.response(), self.response()])
                    result = agent.run_agent("space", planner=planner,
                                             tool=agent.SearchTool(backend))
                    expected_calls = 2 if prefix_success else 1
                    self.assertEqual(backend.search.call_count, expected_calls)
                    self.assertEqual(result["backendAttempts"], expected_calls)
                    self.assertEqual(len(result["toolMessages"]), expected_calls)
                    self.assertEqual(result["toolMessages"][-1]["result"]["status"], status)
                    self.assertEqual(result["status"], "PARTIAL_RESULTS" if prefix_success else status)
                    self.assertEqual(bool(result["recommendations"]), prefix_success)
    def test_cli_agent_human_json_and_live_stops(self):
        for structured in (False, True):
            out = io.StringIO()
            args = ["--query", "space", "--agent"] + (["--json"]if structured else [])
            with contextlib.redirect_stdout(out):
                code = cli.main(args)
            self.assertEqual(code, 0)
            self.assertIn("SYNTHETIC / NO LIVE", out.getvalue())
            self.assertIn("synthetic-catalog-v1:", out.getvalue())
            if structured:
                self.assertFalse(json.loads(out.getvalue())["modelExecuted"])
            else:
                self.assertIn("Model executed: NO", out.getvalue())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["--query", "space", "--agent", "--json", "--live", "--cost-confirmed"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["status"], "LIVE_SEARCH_NOT_ENABLED")


if __name__ == "__main__":
    unittest.main()

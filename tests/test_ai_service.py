"""Offline tests for the server-side AI provider adapter.

These tests never contact a real model service and never use a real API key.
"""
from __future__ import annotations

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-service"))
import ai_service


class FakeResponse:
    def __init__(self, body: bytes = b"", lines: list[bytes] | None = None):
        self.body = body
        self.lines = lines or []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body

    def __iter__(self):
        return iter(self.lines)


class AIServiceTests(unittest.TestCase):
    def test_sourceheng_dictionary_and_structured_scope_are_loaded(self):
        self.assertEqual(ai_service.PROJECT_DICTIONARY["project"]["name"], "源衡智控")
        self.assertIn("15分钟", ai_service.PROJECT_DICTIONARY["timeGranularity"])
        result = ai_service._normalize(
            {"answer": "暂无足够数据", "dataQuality": {"status": "不足", "missingCount": 1, "abnormalCount": 0}},
            "暂无足够数据",
            [],
            {"context": {"region": "华东", "timeRange": "近30天"}},
            "查看华东近30天每天的负荷趋势",
        )
        self.assertEqual(result["intent"], "趋势分析")
        self.assertEqual(result["scope"]["region"], "华东")
        self.assertEqual(result["scope"]["granularity"], "日")
        self.assertEqual(result["dataQuality"]["status"], "不足")

    def test_local_insights_turn_imported_rows_into_metrics_and_suggestions(self):
        rows = [
            {"timestamp": "2026-11-11T16:00", "load_kw": 900, "price_yuan_mwh": 650, "renewable_kw": 20},
            {"timestamp": "2026-11-11T17:00", "load_kw": 1200, "price_yuan_mwh": 700, "renewable_kw": 10},
            {"timestamp": "2026-11-11T23:00", "load_kw": 500, "price_yuan_mwh": 220, "renewable_kw": 0},
        ]
        data = {"getHistoricalMetrics": {"rows": rows, "source": "enterprise_interval"}, "getProductionTasks": {"rows": []}, "getStorageStatus": {"enabled": False}}
        result = ai_service._local_insights("如何降低明天最大负荷并给出建议", data)
        self.assertEqual(result["dataQuality"]["status"], "良好")
        self.assertTrue(any(item["label"] == "峰值负荷" for item in result["metrics"]))
        self.assertGreaterEqual(len(result["suggestions"]), 2)
        self.assertTrue(all(item["needHumanReview"] for item in result["suggestions"]))

    def test_suggestion_questions_select_optimization_tool(self):
        self.assertIn("compareOptimizationPlans", ai_service._select_tools("请给出降低明天最大负荷的建议"))

    def test_historical_tool_honors_requested_time_range(self):
        rows = [{"timestamp": f"2026-11-{day:02d}T{hour:02d}:00", "load_kw": 100, "price_yuan_mwh": 300} for day in range(1, 11) for hour in range(24)]
        with patch.object(ai_service.business, "interval_rows", return_value=rows), patch.object(ai_service.business, "datasets", return_value={"rows": len(rows)}):
            result = ai_service.getHistoricalMetrics(12, {"context": {"timeRange": "近7天"}})
        self.assertEqual(result["summary"]["sampleHours"], 168)
        self.assertEqual(result["summary"]["dataStart"], "2026-11-04T00:00")

    def test_historical_tool_accepts_legacy_time_context_and_question_range(self):
        rows = [{"timestamp": f"2026-11-{day:02d}T{hour:02d}:00", "load_kw": 100, "price_yuan_mwh": 300} for day in range(1, 11) for hour in range(24)]
        with patch.object(ai_service.business, "interval_rows", return_value=rows), patch.object(ai_service.business, "datasets", return_value={"rows": len(rows)}):
            result = ai_service.getHistoricalMetrics(12, {"context": {"time": "今日"}, "messages": [{"role": "user", "content": "查看近7天负荷趋势"}]})
        self.assertEqual(result["summary"]["sampleHours"], 168)
        self.assertEqual(result["summary"]["dataStart"], "2026-11-04T00:00")

    def test_review_task_tool_is_only_a_human_confirmation_proposal(self):
        result = ai_service.createReviewTask(12, {"question": "复核明日储能方案"})
        self.assertFalse(result["created"])
        self.assertTrue(result["requiresHumanConfirmation"])
        self.assertIn("不能未经确认", result["message"])

    def test_extended_read_tools_use_backend_functions(self):
        with patch.object(ai_service.business, "profile", return_value={"values": {"tasks": [{"id": "T1", "name": "灌装", "powerKw": 80}]}}), \
             patch.object(ai_service.business, "bills", return_value=[{"id": 1, "status": "PENDING"}]), \
             patch.object(ai_service.business, "calculate", return_value={"baselineCost": 100, "scenarios": [{"code": "S4", "status": "FEASIBLE", "saving": 8}]}):
            tasks = ai_service.getProductionTasks(12, {})
            bills = ai_service.getBills(12, {})
            plans = ai_service.compareOptimizationPlans(12, {})
        self.assertEqual(tasks["rows"][0]["name"], "灌装")
        self.assertEqual(bills["rows"][0]["status"], "PENDING")
        self.assertEqual(plans["rows"][0]["code"], "S4")

    def test_provider_json_uses_smallest_output_cap_and_does_not_return_key(self):
        captured = {}
        payload = {
            "choices": [{"message": {"content": '{"answer":"ok","confidence":0.8}'}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4},
        }

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse(json.dumps(payload).encode("utf-8"))

        with patch.object(ai_service, "AI_API_KEY", "test-only-secret"), \
             patch.object(ai_service, "AI_BASE_URL", "https://example.invalid/compatible-mode/v1"), \
             patch.object(ai_service, "AI_MAX_TOKENS_REQUEST", 7), \
             patch.object(ai_service, "AI_MAX_OUTPUT_TOKENS", 20), \
             patch("urllib.request.urlopen", fake_urlopen):
            text, usage = ai_service._provider_request("qwen3.7-plus", [{"role": "user", "content": "问"}], False)

        sent = json.loads(captured["request"].data.decode("utf-8"))
        self.assertEqual(sent["max_tokens"], 7)
        self.assertEqual(usage["completion_tokens"], 4)
        self.assertEqual(json.loads(text)["answer"], "ok")
        self.assertNotIn("test-only-secret", text)
        self.assertNotIn("test-only-secret", json.dumps(payload))

    def test_provider_stream_emits_deltas(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"第一段"}}]}\n'.encode("utf-8"),
            'data: {"choices":[{"delta":{"content":"第二段"}}]}\n'.encode("utf-8"),
            b'data: {"usage":{"total_tokens":9}}\n',
            b"data: [DONE]\n",
        ]
        chunks = []
        with patch.object(ai_service, "AI_API_KEY", "test-only-secret"), \
             patch.object(ai_service, "AI_BASE_URL", "https://example.invalid/v1"), \
             patch("urllib.request.urlopen", lambda *_args, **_kwargs: FakeResponse(lines=lines)):
            text, usage = ai_service._provider_request(
                "qwen3.7-plus", [{"role": "user", "content": "问"}], True, chunks.append
            )
        self.assertEqual(text, "第一段第二段")
        self.assertEqual(chunks, ["第一段", "第二段"])
        self.assertEqual(usage["total_tokens"], 9)

    def test_provider_errors_are_safe_and_non_retryable(self):
        error = urllib.error.HTTPError("https://example.invalid", 429, "rate", {}, io.BytesIO())
        with patch.object(ai_service, "AI_API_KEY", "test-only-secret"), \
             patch.object(ai_service, "AI_BASE_URL", "https://example.invalid/v1"), \
             patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(ai_service.AIProblem) as caught:
                ai_service._provider_request("qwen3.7-plus", [{"role": "user", "content": "问"}], False)
        self.assertEqual(caught.exception.code, "AI_QUOTA_OR_RATE_LIMIT")
        self.assertNotIn("test-only-secret", str(caught.exception))

    def test_chat_normalizes_structured_provider_result(self):
        user = {"id": 9, "workspaceId": 12, "role": "OWNER", "workspaceRole": "OWNER"}
        provider_result = {
            "answer": "当前负荷稳定",
            "summary": "稳定",
            "metrics": [{"label": "负荷", "value": 120}],
            "analysis": ["系统计算结果"],
            "risks": [],
            "suggestions": ["继续观察"],
            "confidence": 0.92,
            "needHumanReview": True,
        }
        with patch.object(ai_service, "_blocked_reason", return_value=""), \
             patch.object(ai_service, "_build_data", return_value=({"getRealtimeMetrics": {"available": True}}, [{"name": "实时能源指标", "source": "test", "updatedAt": "now"}])), \
             patch.object(ai_service, "_provider_request", return_value=(json.dumps(provider_result), {"total_tokens": 8})), \
             patch.object(ai_service, "_record_usage") as record:
            result = ai_service.chat(user, {"messages": [{"role": "user", "content": "当前负荷如何？"}]})
        self.assertEqual(result["answer"], "当前负荷稳定")
        self.assertEqual(result["confidence"], 0.92)
        self.assertTrue(result["needHumanReview"])
        self.assertEqual(result["mode"], "model")
        self.assertEqual(result["model"], ai_service.AI_PRIMARY_MODEL)
        self.assertNotIn("test-only-secret", json.dumps(result))
        record.assert_called_once()

    def test_chat_blocks_before_provider_when_local_limit_is_reached(self):
        user = {"id": 9, "workspaceId": 12, "role": "OWNER", "workspaceRole": "OWNER"}
        with patch.object(ai_service, "_blocked_reason", return_value="平台已达到每日Token上限"), \
             patch.object(ai_service, "_record_usage") as record, \
             patch.object(ai_service, "_provider_request") as provider:
            with self.assertRaises(ai_service.AIProblem) as caught:
                ai_service.chat(user, {"messages": [{"role": "user", "content": "分析今天负荷"}]})
        self.assertEqual(caught.exception.code, "AI_LOCAL_LIMIT")
        provider.assert_not_called()
        record.assert_called_once()

    def test_chat_returns_data_backed_local_fallback_when_provider_is_unavailable(self):
        user = {"id": 9, "workspaceId": 12, "role": "OWNER", "workspaceRole": "OWNER"}
        with patch.object(ai_service, "AI_API_KEY", ""), \
             patch.object(ai_service, "AI_BASE_URL", ""), \
             patch.object(ai_service, "_usage_totals", return_value={"userRequests": 0, "userTokens": 0, "totalRequests": 0, "totalTokens": 0}), \
             patch.object(ai_service, "_build_data", return_value=({"getRegionalLoad": {"available": False}}, [{"name": "区域负荷", "source": "enterprise_interval", "updatedAt": "now"}])), \
             patch.object(ai_service, "_record_usage") as record:
            result = ai_service.chat(user, {"messages": [{"role": "user", "content": "今天哪个区域负荷最高？"}]})
        self.assertEqual(result["mode"], "local")
        self.assertEqual(result["model"], "local-rules")
        self.assertIn("暂无足够", result["answer"])
        self.assertTrue(result["needHumanReview"])
        record.assert_called_once()

    def test_budget_stop_threshold_is_checked_before_provider(self):
        user = {"id": 9, "workspaceId": 12, "role": "OWNER", "workspaceRole": "OWNER"}
        with patch.object(ai_service, "AI_API_KEY", "test-only-secret"), \
             patch.object(ai_service, "AI_BASE_URL", "https://example.invalid/v1"), \
             patch.object(ai_service, "AI_COST_PROTECTION", True), \
             patch.object(ai_service, "AI_STOP_ON_LOCAL_LIMIT", True), \
             patch.object(ai_service, "AI_STOP_PERCENT", 90), \
             patch.object(ai_service, "AI_DAILY_TOKEN_USER", 100), \
             patch.object(ai_service, "AI_DAILY_TOKEN_TOTAL", 100), \
             patch.object(ai_service, "_usage_totals", return_value={"userRequests": 0, "userTokens": 0, "totalRequests": 2, "totalTokens": 89}):
            reason = ai_service._blocked_reason(user, {"messages": []}, 2)
        self.assertEqual(reason, "平台已达到每日Token上限")


if __name__ == "__main__":
    unittest.main()

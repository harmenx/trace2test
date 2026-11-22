"""Pytest cases exported by trace2test.

Python is optional. The checks here follow the YAML cases: recorded tool
results are replayed from fixtures, and the model is whatever
OpenAI-compatible endpoint OPENAI_BASE_URL points at.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

CASES = json.loads("[{\"id\":\"order-and-balance\",\"name\":\"order-and-balance\",\"input\":{\"messages\":[{\"role\":\"system\",\"content\":\"You are a support agent. Use tools before answering. Do not invent order status or balances.\"},{\"role\":\"user\",\"content\":\"What's the status of order A-1001 and the gift-card balance for customer c_9?\"}],\"tools\":[{\"name\":\"lookup_order\",\"description\":\"Look up the status of an order by id\",\"parameters\":{\"type\":\"object\",\"properties\":{\"orderId\":{\"type\":\"string\"}},\"required\":[\"orderId\"],\"additionalProperties\":false}},{\"name\":\"get_balance\",\"description\":\"Look up a customer's gift-card balance\",\"parameters\":{\"type\":\"object\",\"properties\":{\"customerId\":{\"type\":\"string\"}},\"required\":[\"customerId\"],\"additionalProperties\":false}}]},\"fixtures\":[{\"id\":\"call_lookup_order\",\"name\":\"lookup_order\",\"arguments\":{\"orderId\":\"A-1001\"},\"result\":{\"orderId\":\"A-1001\",\"status\":\"shipped\",\"eta\":\"2026-04-02\",\"carrier\":\"UPS\",\"customerId\":\"c_9\"},\"match\":\"subset\"},{\"id\":\"call_get_balance\",\"name\":\"get_balance\",\"arguments\":{\"customerId\":\"c_9\"},\"result\":{\"customerId\":\"c_9\",\"currency\":\"USD\",\"amount\":25},\"match\":\"subset\"}],\"assertions\":{\"toolSequence\":{\"mode\":\"ordered\",\"expected\":[{\"name\":\"lookup_order\",\"arguments\":{\"orderId\":\"A-1001\"},\"match\":\"subset\"},{\"name\":\"get_balance\",\"arguments\":{\"customerId\":\"c_9\"},\"match\":\"subset\"}]},\"finalAnswer\":[{\"type\":\"contains\",\"value\":\"2026-04-02\"},{\"type\":\"regex\",\"pattern\":\"\\\\$25\\\\.00\",\"flags\":\"i\"},{\"type\":\"contains\",\"value\":\"UPS\"}]}},{\"id\":\"order-status\",\"name\":\"order-status\",\"input\":{\"messages\":[{\"role\":\"system\",\"content\":\"You look up orders. Reply with a JSON object and nothing else.\"},{\"role\":\"user\",\"content\":\"What is the status of order A-1001? Reply with JSON.\"}],\"tools\":[{\"name\":\"lookup_order\",\"description\":\"Look up the status of an order by id\",\"parameters\":{\"type\":\"object\",\"properties\":{\"orderId\":{\"type\":\"string\"}},\"required\":[\"orderId\"]}}]},\"fixtures\":[{\"id\":\"call_lookup_order\",\"name\":\"lookup_order\",\"arguments\":{\"orderId\":\"A-1001\"},\"result\":{\"orderId\":\"A-1001\",\"status\":\"shipped\",\"eta\":\"2026-04-02\",\"carrier\":\"UPS\",\"customerId\":\"c_9\"},\"match\":\"subset\"}],\"assertions\":{\"toolSequence\":{\"mode\":\"ordered\",\"expected\":[{\"name\":\"lookup_order\",\"arguments\":{\"orderId\":\"A-1001\"},\"match\":\"subset\"}]},\"finalAnswer\":[{\"type\":\"json-schema\",\"schema\":{\"type\":\"object\",\"additionalProperties\":true,\"required\":[\"orderId\",\"status\",\"eta\",\"carrier\"],\"properties\":{\"orderId\":{\"type\":\"string\",\"const\":\"A-1001\"},\"status\":{\"type\":\"string\",\"const\":\"shipped\"},\"eta\":{\"type\":\"string\",\"const\":\"2026-04-02\"},\"carrier\":{\"type\":\"string\",\"const\":\"UPS\"}}}}]}},{\"id\":\"weather-in-paris\",\"name\":\"Weather in Paris?\",\"input\":{\"messages\":[{\"role\":\"system\",\"content\":\"You are a weather assistant. Use get_weather before answering.\"},{\"role\":\"user\",\"content\":\"Weather in Paris?\"}],\"tools\":[{\"name\":\"get_weather\",\"description\":\"Get the current weather in a city\",\"parameters\":{\"type\":\"object\",\"properties\":{\"location\":{\"type\":\"string\",\"description\":\"City name\"}},\"required\":[\"location\"],\"additionalProperties\":false}}]},\"fixtures\":[{\"id\":\"call_weather_paris\",\"name\":\"get_weather\",\"arguments\":{\"location\":\"Paris\"},\"result\":\"rainy, 57°F\",\"match\":\"subset\"}],\"assertions\":{\"toolSequence\":{\"mode\":\"ordered\",\"expected\":[{\"name\":\"get_weather\",\"arguments\":{\"location\":\"Paris\"},\"match\":\"subset\"}]},\"finalAnswer\":[{\"type\":\"regex\",\"pattern\":\"57\\\\s*°\\\\s*F\",\"flags\":\"i\"},{\"type\":\"contains\",\"value\":\"Paris\"}]}}]")

def test_order_and_balance():
    """order-and-balance"""
    run_case("order-and-balance")

def test_order_status():
    """order-status"""
    run_case("order-status")

def test_weather_in_paris():
    """Weather in Paris?"""
    run_case("weather-in-paris")

def run_case(case_id):
    case = next(item for item in CASES if item["id"] == case_id)
    model = os.environ.get("TRACE2TEST_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
    messages = [dict(message) for message in case["input"]["messages"]]
    actual = []
    final = None
    used = set()
    failures = []
    for _step in range(8):
        message = complete(model, messages, case["input"]["tools"])
        messages.append(message)
        calls = message.get("tool_calls") or []
        if not calls:
            final = message.get("content")
            break
        for call in calls:
            name = call["function"]["name"]
            arguments = parse_args(call["function"].get("arguments"))
            actual.append({"name": name, "arguments": arguments})
            fixture = take_fixture(case["fixtures"], name, arguments, used)
            if fixture is None:
                failures.append(f"no fixture matched {name}({json.dumps(arguments, sort_keys=True)})")
                result = {"error": f"No fixture matched {name}"}
            else:
                result = fixture["result"]
            messages.append({
                "role": "tool",
                "name": name,
                "tool_call_id": call.get("id") or name,
                "content": result if isinstance(result, str) else json.dumps(result),
            })
    else:
        failures.append("stopped after 8 model calls without a final answer")

    sequence = case["assertions"]["toolSequence"]
    ok, detail = score_tools(sequence, actual)
    if not ok:
        failures.append(detail)
    for assertion in case["assertions"].get("finalAnswer") or []:
        ok, detail = score_final(final, assertion)
        if not ok:
            failures.append(detail)
    if failures:
        raise AssertionError(case_id + "\n" + "\n".join(failures))


def complete(model, messages, tools):
    base = (os.environ.get("OPENAI_BASE_URL") or os.environ.get("TRACE2TEST_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("TRACE2TEST_API_KEY") or ""
    body = {"model": model, "messages": messages, "temperature": 0}
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description") or "",
                    "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
                },
            }
            for tool in tools
        ]
    request = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode())
    return payload["choices"][0]["message"]


def parse_args(value):
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{") or text.startswith("["):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return {} if value is None else value


def take_fixture(fixtures, name, arguments, used):
    for index, fixture in enumerate(fixtures):
        if index in used or fixture["name"] != name:
            continue
        if args_match(fixture.get("arguments"), arguments, fixture.get("match") or "subset"):
            used.add(index)
            return fixture
    return None


def score_tools(sequence, actual):
    expected = sequence.get("expected") or []
    mode = sequence.get("mode") or "ordered"
    cursor = 0
    matched = 0
    for call in expected:
        while cursor < len(actual):
            candidate = actual[cursor]
            cursor += 1
            if candidate["name"] == call["name"] and args_match(call.get("arguments"), candidate["arguments"], call.get("match") or "subset"):
                matched += 1
                break
    passed = matched == len(expected) and (mode != "exact" or len(actual) == len(expected))
    if mode != "exact" and len(expected) == 0 and len(actual) > 0:
        passed = False
    if passed:
        return True, ""
    wanted = ", ".join(call["name"] for call in expected) or "(none)"
    seen = ", ".join(call["name"] for call in actual) or "(none)"
    return False, f"tool sequence: expected [{wanted}], got [{seen}]"


def score_final(output, assertion):
    if output is None:
        return False, "model did not return a final answer"
    kind = assertion["type"]
    if kind == "exact":
        if output.strip() == assertion["value"]:
            return True, ""
        return False, "final answer did not match exactly"
    if kind == "contains":
        if assertion["value"] in output:
            return True, ""
        return False, "missing " + json.dumps(assertion["value"])
    if kind == "regex":
        if re.search(assertion["pattern"], output, re_flags(assertion.get("flags") or "")):
            return True, ""
        return False, "did not match /" + assertion["pattern"] + "/"
    if kind == "json-schema":
        try:
            value = json.loads(output.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
        except json.JSONDecodeError as error:
            return False, "final answer is not JSON: " + str(error)
        ok, detail = schema_ok(value, assertion["schema"])
        if ok:
            return True, ""
        return False, "json schema: " + detail
    return False, "unknown assertion " + kind


def re_flags(text):
    flags = 0
    if "i" in text:
        flags |= re.IGNORECASE
    if "m" in text:
        flags |= re.MULTILINE
    if "s" in text:
        flags |= re.DOTALL
    return flags


def schema_ok(value, schema):
    if not isinstance(schema, dict):
        return True, ""
    if "const" in schema and not loosely_equal(value, schema["const"]):
        return False, "expected " + json.dumps(schema["const"])
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            return False, "expected an object"
        for key in schema.get("required") or []:
            if key not in value:
                return False, "missing " + key
        for key, child in (schema.get("properties") or {}).items():
            if key in value:
                ok, detail = schema_ok(value[key], child)
                if not ok:
                    return False, key + ": " + detail
        return True, ""
    if expected == "array":
        if not isinstance(value, list):
            return False, "expected an array"
        if "minItems" in schema and len(value) < schema["minItems"]:
            return False, "array is shorter than minItems"
        if "items" in schema:
            for index, item in enumerate(value):
                ok, detail = schema_ok(item, schema["items"])
                if not ok:
                    return False, f"[{index}]: " + detail
        return True, ""
    if expected == "string" and not isinstance(value, str):
        return False, "expected a string"
    if expected == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
        return False, "expected an integer"
    if expected == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        return False, "expected a number"
    if expected == "boolean" and not isinstance(value, bool):
        return False, "expected a boolean"
    if expected == "null" and value is not None:
        return False, "expected null"
    return True, ""


def args_match(expected, actual, mode):
    if mode == "any":
        return True
    if mode == "exact":
        return loosely_equal(expected if expected is not None else {}, actual if actual is not None else {})
    return subset_match(expected if expected is not None else {}, actual if actual is not None else {})


def subset_match(expected, actual):
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and subset_match(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) != len(actual):
            return False
        return all(subset_match(item, actual[index]) for index, item in enumerate(expected))
    return loosely_equal(expected, actual)


def loosely_equal(left, right):
    if left == right and not isinstance(left, bool) and not isinstance(right, bool):
        return True
    if type(left) is type(right) and left == right:
        return True
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, str) and right.strip():
        try:
            return float(right) == left
        except ValueError:
            return False
    if isinstance(right, (int, float)) and isinstance(left, str) and left.strip():
        try:
            return float(left) == right
        except ValueError:
            return False
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(loosely_equal(item, right[index]) for index, item in enumerate(left))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(loosely_equal(left[key], right[key]) for key in left)
    return False

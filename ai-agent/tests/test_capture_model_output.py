from unittest.mock import Mock

import pytest

from app.capture.schemas import ExtractionResult
from app.capture.steps import ask_model
from app.llm import InvalidModelOutput, LLMError


def test_malformed_response_retries_with_the_capture_schema():
    llm = Mock()
    llm.generate_json.side_effect = [InvalidModelOutput("Invalid JSON"), {"events": []}]
    result = ask_model(llm, "Extract events", "No activity today.", ExtractionResult)
    assert result.events == []
    first, retry = llm.generate_json.call_args_list
    assert first.kwargs["schema"] == retry.kwargs["schema"] == ExtractionResult.model_json_schema()
    assert "Return corrected JSON" in retry.args[1]


def test_provider_failure_does_not_trigger_a_format_retry():
    llm = Mock()
    llm.generate_json.side_effect = LLMError("Unavailable")
    with pytest.raises(LLMError, match="Unavailable"):
        ask_model(llm, "Extract events", "The crane stopped.", ExtractionResult)
    llm.generate_json.assert_called_once()


def test_extraction_expands_only_reported_details_into_typed_fields():
    result = ExtractionResult.model_validate({"events": [{
        "suggested_category": "progress", "suggested_event_type": "production", "summary": "12 cubic metres poured",
        "details": [{"name": "quantity", "value": "12"}, {"name": "unit", "value": "m³"}],
    }]})
    event = result.events[0]
    assert event.quantity == 12 and event.unit == "m³" and event.injured_count is None
    assert "details" not in event.model_dump()
    # Each nullable site field in the provider schema used to add a separate grammar branch.
    definitions = ExtractionResult.model_json_schema()["$defs"]
    assert "quantity" not in definitions["ReportedEvent"]["properties"]
    assert "quantity" in definitions["DetailName"]["enum"]

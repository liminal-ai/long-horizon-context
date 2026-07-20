"""Ported from packages/lhc/test/tool-result-summary-inference.test.ts. Phase 1."""

from __future__ import annotations

from lhc import create_deterministic_inference_callbacks, init_lhc
from lhc.messages.internal.handlers import (
    ToolResultSummaryInput,
    ToolResultSummaryOpts,
    derive_tool_result_summary,
)
from lhc.shared_tech.derivation import (
    DerivationMetadata,
    HandlerRunContext,
    InferenceCallbacks,
    InferenceErr,
    InferenceOk,
    ProviderProvenance,
    SdkConfig,
)


def _make_run(inference_callbacks: InferenceCallbacks) -> HandlerRunContext:
    sdk = init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
        )
    )

    def _open_db():
        raise RuntimeError("deriveToolResultSummary tests do not read the database")

    return HandlerRunContext(
        thread_id="th_test",
        file_path="/tmp/tool-result-summary-test.sqlite",
        open_db=_open_db,
        inference_callbacks=inference_callbacks,
        clock=sdk.config.clock,
        config=sdk.config,
    )


_LARGE_CONTENT = "tool-output-token " * 600


async def test_forced_fallback_path_does_not_stamp_inferenceattempted() -> None:
    """forced fallback path does not stamp inferenceAttempted"""
    run = _make_run(create_deterministic_inference_callbacks())
    derived = await derive_tool_result_summary(
        run,
        "m4",
        ToolResultSummaryInput(
            tool_name="read_file",
            content=_LARGE_CONTENT,
            outcome="succeeded",
        ),
        ToolResultSummaryOpts(use_inference=False),
    )
    assert hasattr(derived, "write")
    if not hasattr(derived, "write"):
        return
    assert derived.write.metadata is not None
    assert derived.write.metadata == DerivationMetadata(outcome="succeeded")
    assert derived.write.metadata.inference_attempted is None


async def test_inference_path_stamps_success_metadata_when_inference_succeeds() -> None:
    """inference path stamps success metadata when inference succeeds"""
    base = create_deterministic_inference_callbacks()

    class _Callbacks:
        async def smooth_prompt(self, i):
            return await base.smooth_prompt(i)

        async def summarize_tool_result(self, i):
            return InferenceOk(
                text="summarized tool output",
                provenance=ProviderProvenance(
                    provider="openai", model="gpt-4o", prompt="tool-result-v2"
                ),
            )

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _Callbacks()
    run = _make_run(callbacks)
    derived = await derive_tool_result_summary(
        run,
        "m4",
        ToolResultSummaryInput(
            tool_name="read_file",
            content=_LARGE_CONTENT,
            outcome="failed",
        ),
        ToolResultSummaryOpts(use_inference=True),
    )
    assert hasattr(derived, "write")
    if not hasattr(derived, "write"):
        return
    meta = derived.write.metadata
    assert meta is not None
    assert meta.outcome == "failed"
    assert meta.inference_attempted is True
    assert meta.inference_succeeded is True
    assert meta.provenance == ProviderProvenance(
        provider="openai", model="gpt-4o", prompt="tool-result-v2"
    )


async def test_inference_path_returns_structured_failure_without_success_metadata() -> None:
    """inference path returns structured failure without success metadata"""
    base = create_deterministic_inference_callbacks()

    class _Callbacks:
        async def smooth_prompt(self, i):
            return await base.smooth_prompt(i)

        async def summarize_tool_result(self, i):
            return InferenceErr(reason="provider_failure: rate_limit: too many requests")

        async def compress_detailed_turn(self, i):
            return await base.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await base.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _Callbacks()
    run = _make_run(callbacks)
    derived = await derive_tool_result_summary(
        run,
        "m4",
        ToolResultSummaryInput(
            tool_name="read_file",
            content=_LARGE_CONTENT,
            outcome="succeeded",
        ),
        ToolResultSummaryOpts(use_inference=True),
    )
    assert derived == InferenceErr(reason="provider_failure: rate_limit: too many requests")

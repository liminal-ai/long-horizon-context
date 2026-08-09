"""Ported from packages/lhc/src/shared-tech/token-counting/index.ts.

NOTE (Phase 2): TS uses js-tiktoken/lite with o200k_base ranks. Python should
use an equivalent tiktoken encoding that byte-matches token counts for parity
certification.
"""

from __future__ import annotations

import tiktoken

TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base"

_encoder = tiktoken.get_encoding("o200k_base")


def estimate_tokens(text: str) -> int:
    # Allow all special tokens: captured text is data, and a literal
    # "<|endoftext|>" in a transcript must count, not raise (parity with
    # TS `encoder.encode(text, "all")`; without this, capture of any
    # conversation that merely quotes a special token fails and rolls
    # back the whole event batch).
    return len(_encoder.encode(text, allowed_special="all"))

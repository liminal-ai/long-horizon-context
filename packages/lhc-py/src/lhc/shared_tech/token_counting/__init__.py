"""Ported from packages/lhc/src/shared-tech/token-counting/index.ts.

NOTE (Phase 2): TS uses js-tiktoken/lite with o200k_base ranks. Python should
use an equivalent tiktoken encoding that byte-matches token counts for parity
certification.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

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


@dataclass(frozen=True, slots=True)
class TokenSlice:
    text: str
    from_token: int
    to_token: int
    total_tokens: int


def _encode_all(text: str) -> list[int]:
    return _encoder.encode(text, allowed_special="all")


def _decode_tokens(tokens: list[int]) -> str:
    # tiktoken decode is lossless for token sequences produced by encode;
    # cleanTailWindow still guards U+FFFD mid-char splits after a sub-window.
    return _encoder.decode(tokens)


def _clean_tail_window(
    tokens: list[int], from_index: int, count: int, at_end: bool
) -> tuple[str, int]:
    """Decode tokens[from, from+count) and shrink until the tail is clean.

    BPE boundaries can split a multi-byte char; a split tail would corrupt
    verbatim text (U+FFFD) and leave the continuation offset mid-char.
    Windows that reach the text's end cannot have a split tail.
    """
    k = max(0, count)
    text = _decode_tokens(tokens[from_index : from_index + k])
    if at_end:
        return text, k
    while k > 0 and text.endswith("\ufffd"):
        k -= 1
        text = _decode_tokens(tokens[from_index : from_index + k])
    return text, k


def slice_tokens(text: str, from_token: int, max_tokens: float | int) -> TokenSlice:
    """Exact token window: encode, slice [from, from+max), decode (clean tail).

    Past-the-end offset returns an empty slice preserving the requested offset
    so the caller's receipt can name what was asked. ``max_tokens`` is floored
    (TS ``Math.floor``).
    """
    tokens = _encode_all(text)
    total_tokens = len(tokens)
    from_idx = max(0, int(from_token))
    # Floor like TS Math.floor — truncate toward -inf for the rare negative.
    floored_max = max(0, math.floor(float(max_tokens)))
    if from_idx >= total_tokens:
        to_idx = from_idx
    else:
        to_idx = min(from_idx + floored_max, total_tokens)
    window_text, window_count = _clean_tail_window(
        tokens, from_idx, to_idx - from_idx, at_end=(to_idx == total_tokens)
    )
    return TokenSlice(
        text=window_text,
        from_token=from_idx,
        to_token=from_idx + window_count,
        total_tokens=total_tokens,
    )


def slice_tokens_byte_capped(
    text: str,
    from_token: int,
    max_tokens: float | int,
    max_bytes: float | int,
) -> TokenSlice:
    """``slice_tokens`` also fitted to a UTF-8 byte allowance.

    Encode once; when the token window exceeds ``max_bytes``, binary-search the
    largest token count whose decoded slice fits. Receipts stay token-
    denominated — bytes only shrink how much is served now. Clean-tail then
    shrinks until the decoded window ends on a valid UTF-8 code-point boundary
    (    never leaves a mid-character U+FFFD split).
    """
    tokens = _encode_all(text)
    total_tokens = len(tokens)
    from_idx = max(0, int(from_token))
    floored_max = max(0, math.floor(float(max_tokens)))
    if from_idx >= total_tokens:
        to_idx = from_idx
    else:
        to_idx = min(from_idx + floored_max, total_tokens)

    byte_cap = float(max_bytes)

    def fits(end: int) -> bool:
        return len(_decode_tokens(tokens[from_idx:end]).encode("utf-8")) <= byte_cap

    count = to_idx - from_idx
    if not fits(to_idx):
        low = 0
        high = count
        while low < high:
            # TS: Math.ceil((low + high) / 2) — same for ints as (low+high+1)//2.
            mid = (low + high + 1) // 2
            if fits(from_idx + mid):
                low = mid
            else:
                high = mid - 1
        count = low
    window_text, window_count = _clean_tail_window(
        tokens, from_idx, count, at_end=(from_idx + count == total_tokens)
    )
    return TokenSlice(
        text=window_text,
        from_token=from_idx,
        to_token=from_idx + window_count,
        total_tokens=total_tokens,
    )
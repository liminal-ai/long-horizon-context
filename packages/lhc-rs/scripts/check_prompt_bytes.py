#!/usr/bin/env python3
"""Byte-check Rust prompt modules via exact complete-message reconstruction.

Loads fixtures/prompt-renders.json (Wave 0 oracle — never modified here).
For each of 9 prompts, reconstructs the full messages array from Rust
`pub const` string literals plus the same sentinel inputs as
scripts/render-prompts-oracle.mjs, then compares every message role, order,
full content bytes, and joined bytes (`role\\0content` joined by `\\n---\\n`).

Also validates PROMPT_REGISTRY / PROMPT_NAMES / DEFAULT_PROMPT_NAMES wiring
and covers constants not exercised by the single sentinel fixture (empty
parts, NAME, outcome/tool templates, tool-v2 omit fragments, all mode
guidance). Does not regex-extract TypeScript as an oracle.

Exit 0 on all match; nonzero with clear diffs on failure.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORACLE_PATH = ROOT / "fixtures" / "prompt-renders.json"
PROMPTS_DIR = ROOT / "src" / "shared_tech" / "prompts"
MOD_RS = PROMPTS_DIR / "mod.rs"

# Sentinel inputs — must match scripts/render-prompts-oracle.mjs.
SENTINELS = {
    "chunk-brief-v1": {
        "memberProjections": ["SENTINEL_PROJ_A", "SENTINEL_PROJ_B"],
        "memberOutcomes": [["succeeded"], ["failed"]],
    },
    "chunk-brief-v2": {
        "text": "SENTINEL_CHUNK_TEXT",
        "inputTokens": 2000,
        "targetMinTokens": 160,
        "targetAimTokens": 240,
        "targetMaxTokens": 400,
    },
    "chunk-brief-v3": {
        "text": "SENTINEL_CHUNK_TEXT",
        "inputTokens": 2000,
        "targetMinTokens": 160,
        "targetAimTokens": 240,
        "targetMaxTokens": 400,
    },
    "detailed-turn-compression-v1": {
        "dialogueText": "SENTINEL_DIALOGUE",
        "inputTokens": 120,
        "targetMinTokens": 42,
        "targetAimTokens": 60,
        "targetMaxTokens": 78,
    },
    "detailed-turn-compression-v2": {
        "dialogueText": "SENTINEL_DIALOGUE",
        "inputTokens": 120,
        "targetMinTokens": 42,
        "targetAimTokens": 60,
        "targetMaxTokens": 78,
    },
    "detailed-turn-compression-v3": {
        "dialogueText": "SENTINEL_DIALOGUE",
        "inputTokens": 120,
        "targetMinTokens": 42,
        "targetAimTokens": 60,
        "targetMaxTokens": 78,
    },
    "smoothing-v1": {"text": "SENTINEL_SMOOTH_TEXT"},
    "tool-result-v1": {
        "toolName": "SENTINEL_TOOL",
        "content": "SENTINEL_CONTENT",
        "outcome": "succeeded",
        "targetTokens": 99,
        "guidance": "SENTINEL_GUIDANCE",
    },
    "tool-result-v2": {
        "toolName": "SENTINEL_TOOL",
        "content": "SENTINEL_CONTENT",
        "outcome": "succeeded",
        "targetTokens": 120,
        "promptMode": "content_summary",
        "responseShape": "file_content",
        "facts": {
            "toolName": "SENTINEL_TOOL",
            "outcome": "succeeded",
            "targetPath": "notes/plan.md",
            "operationClass": "read",
            "responseShape": "file_content",
            "outputChars": 16,
        },
    },
}

PROMPT_FILES = {
    "chunk-brief-v1": "chunk_brief_v1.rs",
    "chunk-brief-v2": "chunk_brief_v2.rs",
    "chunk-brief-v3": "chunk_brief_v3.rs",
    "detailed-turn-compression-v1": "detailed_turn_compression_v1.rs",
    "detailed-turn-compression-v2": "detailed_turn_compression_v2.rs",
    "detailed-turn-compression-v3": "detailed_turn_compression_v3.rs",
    "smoothing-v1": "smoothing_v1.rs",
    "tool-result-v1": "tool_result_v1.rs",
    "tool-result-v2": "tool_result_v2.rs",
}

MODULE_FOR = {
    "chunk-brief-v1": "chunk_brief_v1",
    "chunk-brief-v2": "chunk_brief_v2",
    "chunk-brief-v3": "chunk_brief_v3",
    "detailed-turn-compression-v1": "detailed_turn_compression_v1",
    "detailed-turn-compression-v2": "detailed_turn_compression_v2",
    "detailed-turn-compression-v3": "detailed_turn_compression_v3",
    "smoothing-v1": "smoothing_v1",
    "tool-result-v1": "tool_result_v1",
    "tool-result-v2": "tool_result_v2",
}

REGISTRY_ORDER = [
    "smoothing-v1",
    "tool-result-v1",
    "tool-result-v2",
    "detailed-turn-compression-v1",
    "detailed-turn-compression-v2",
    "detailed-turn-compression-v3",
    "chunk-brief-v1",
    "chunk-brief-v2",
    "chunk-brief-v3",
]

DEFAULT_PROMPT_NAMES_EXPECTED = [
    ("smoothed_prompt", "smoothing-v1"),
    ("tool_result_summary", "tool-result-v2"),
    ("detailed_turn_compression", "detailed-turn-compression-v3"),
    ("chunk_summary_brief", "chunk-brief-v3"),
]

# Full MODE_GUIDANCE closed vocab — derived from TS tool-result-v2.ts (read, not regex-oracle).
EXPECTED_MODE_GUIDANCE: dict[str, str] = {
    "MODE_GUIDANCE_RECEIPT": (
        "Write a concise tool-result receipt. Preserve status, concrete paths, counts, "
        "identifiers, and retry guidance. For write/edit receipts, do not infer changed "
        "content. If mutationDetailsAvailable is false, say the content/edit details were "
        "not available in the response when that matters. Do not quote the raw response."
    ),
    "MODE_GUIDANCE_FAILURE": (
        "Write a concise failure receipt. Preserve what failed, why, the target path or "
        "command, exit code, and actionable retry guidance. Do not generalize away the "
        "concrete error."
    ),
    "MODE_GUIDANCE_SEARCH_SUMMARY": (
        "Summarize the search/listing result. Preserve query/command if present, match or "
        "no-match status, relevant paths, counts, and key locations. Do not list every "
        "match unless the output is already small."
    ),
    "MODE_GUIDANCE_TEST_SUMMARY": (
        "Write a compact verification receipt. Preserve command, final status, exit code, "
        "pass/fail counts, failed test names, and the core assertion/error reason. Prefer "
        "parsed testSummary over raw log detail. Do not list stack frames or every path. "
        "Keep it short unless multiple distinct failures need naming."
    ),
    "MODE_GUIDANCE_CONTENT_SUMMARY": (
        "Summarize what the file/output contains that matters for future work. Preserve "
        "file path, major sections/exports/config, and important values. Do not restate "
        "full contents."
    ),
    "MODE_GUIDANCE_DIFF_SUMMARY": (
        "Summarize changed files and nature of changes. Preserve insertion/deletion scale "
        "if available. Do not reproduce full diff."
    ),
    "MODE_GUIDANCE_LARGE_LOG": (
        "Extract the final status, key errors, paths, counts, and next actionable facts. "
        "Drop repeated boilerplate and long logs."
    ),
    "MODE_GUIDANCE_NO_OUTPUT": (
        "Write a concise receipt for a successful command that produced no output. "
        "Preserve the command and explain that no output means a clean/no-change result "
        "only if the parsed outcome says succeeded."
    ),
    "MODE_GUIDANCE_MULTI_TOOL_SUMMARY": (
        "Summarize each subtool result separately. Preserve which subcalls succeeded or "
        "failed, missing paths/errors, and no-output clean statuses. Do not collapse "
        "mixed success/failure into one vague result."
    ),
    "MODE_GUIDANCE_GENERIC_SUMMARY": (
        "Summarize the tool result for future coding context. Preserve concrete facts "
        "and avoid inventing missing details."
    ),
}

EXPECTED_OMIT_FRAGMENTS = {
    "TOOL_RESULT_V2_SEARCH_OMIT_PREFIX": "\n\n[omitted ",
    "TOOL_RESULT_V2_SEARCH_OMIT_SUFFIX": (
        " additional search-result lines; use parsed "
        "searchMatchCount/searchMatches as authoritative]"
    ),
    "TOOL_RESULT_V2_MIDDLE_OMIT_PREFIX": "\n\n[omitted ",
    "TOOL_RESULT_V2_MIDDLE_OMIT_SUFFIX": " middle characters]\n\n",
}

EXPECTED_TOOL_V1_TEMPLATES = {
    "SYSTEM_TEMPLATE": (
        'You summarize tool output for an engineering record. Preserve the '
        'outcome/status exactly as "${i.outcome}". Target about ${i.targetTokens} '
        "tokens. ${i.guidance} No commentary, no speculation."
    ),
    "USER_TEMPLATE": (
        "Tool: ${i.toolName}\nOutcome: ${i.outcome}\n\nOutput:\n${i.content}"
    ),
}

EXPECTED_CHUNK_BRIEF_V1_OUTCOMES_TEMPLATE = (
    '\n\nTool outcomes, in order: ${outcomes.join(", ")}'
)

# Every pub const that must appear in each module (reconstruction + extras).
REQUIRED_CONSTS: dict[str, list[str]] = {
    "chunk-brief-v1": [
        "NAME",
        "SYSTEM_PROMPT",
        "USER_TURNS_PREFIX",
        "OUTCOMES_SECTION_TEMPLATE",
        "OUTCOMES_SECTION_PREFIX",
    ],
    "chunk-brief-v2": ["NAME", "SYSTEM_PROMPT", "USER_PROMPT"],
    "chunk-brief-v3": [
        "NAME",
        "INSTRUCTIONS_OPEN",
        "INSTRUCTIONS_INTRO",
        "JOB_TEMPLATE",
        "INSTRUCTIONS_CLOSE",
        "CONTENT_OPEN",
        "CONTENT_CLOSE",
    ],
    "detailed-turn-compression-v1": [
        "NAME",
        *[f"SYSTEM_PART_{i:02d}" for i in range(34) if i not in (2, 4, 26, 30)],
        "SYSTEM_TMPL_02",
        "SYSTEM_TMPL_04",
        "SYSTEM_TMPL_26",
        "SYSTEM_TMPL_30",
        "USER_WRAPPER_PREFIX",
        "USER_WRAPPER_SUFFIX",
    ],
    "detailed-turn-compression-v2": [
        "NAME",
        *[f"SYSTEM_PART_{i:02d}" for i in range(27) if i not in (2, 4, 19, 23)],
        "SYSTEM_TMPL_02",
        "SYSTEM_TMPL_04",
        "SYSTEM_TMPL_19",
        "SYSTEM_TMPL_23",
        "USER_WRAPPER_PREFIX",
        "USER_WRAPPER_SUFFIX",
    ],
    "detailed-turn-compression-v3": [
        "NAME",
        "INSTRUCTIONS_OPEN",
        "INSTRUCTIONS_INTRO",
        "JOB_TEMPLATE",
        "INSTRUCTIONS_PROSE",
        "INSTRUCTIONS_CLOSE",
        "CONTENT_OPEN",
        "CONTENT_CLOSE",
    ],
    "smoothing-v1": [
        "NAME",
        "SMOOTHING_V1_SYSTEM_INSTRUCTIONS",
        "SMOOTHING_V1_USER_WRAPPER_PREFIX",
        "SMOOTHING_V1_USER_WRAPPER_SUFFIX",
    ],
    "tool-result-v1": [
        "NAME",
        "SYSTEM_TEMPLATE",
        "USER_TEMPLATE",
        "SYSTEM_STATIC_PREFIX",
        "SYSTEM_STATIC_MID",
        "SYSTEM_STATIC_SUFFIX",
        "USER_STATIC_TOOL_PREFIX",
        "USER_STATIC_OUTCOME_MID",
        "USER_STATIC_OUTPUT_MID",
    ],
    "tool-result-v2": [
        "NAME",
        *EXPECTED_MODE_GUIDANCE.keys(),
        "TOOL_RESULT_V2_INTRO",
        "TOOL_RESULT_V2_FACTS_RULE",
        "TOOL_RESULT_V2_FIELD_RULE",
        "TOOL_RESULT_V2_TARGET_LENGTH_PREFIX",
        "TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX",
        "TOOL_RESULT_V2_PROMPT_MODE_PREFIX",
        "TOOL_RESULT_V2_MODE_GUIDANCE_HEADER",
        "TOOL_RESULT_V2_PARSED_FIELDS_HEADER",
        "TOOL_RESULT_V2_USER_TOOL_PREFIX",
        "TOOL_RESULT_V2_USER_OUTCOME_PREFIX",
        "TOOL_RESULT_V2_USER_EXCERPT_OPEN",
        "TOOL_RESULT_V2_USER_EXCERPT_CLOSE",
        *EXPECTED_OMIT_FRAGMENTS.keys(),
    ],
}


def stated_target(input_tokens: int, ratio: float) -> int:
    raw = input_tokens * ratio
    step = 100 if raw >= 1000 else 10
    return int(raw / step + 0.5) * step


def join_msgs(msgs: list[dict[str, str]]) -> str:
    return "\n---\n".join(f"{m['role']}\0{m['content']}" for m in msgs)


def extract_rust_str_consts(src: str) -> dict[str, str]:
    """Extract `pub const NAME: &str = r#"..."#;` / `"..."` forms."""
    out: dict[str, str] = {}
    pattern = re.compile(
        r"pub\s+const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*",
        re.MULTILINE,
    )
    for m in pattern.finditer(src):
        name = m.group(1)
        i = m.end()
        while i < len(src) and src[i].isspace():
            i += 1
        if i >= len(src):
            raise ValueError(f"{name}: missing value")
        if src.startswith("r", i):
            j = i + 1
            n_hash = 0
            while j < len(src) and src[j] == "#":
                n_hash += 1
                j += 1
            if j >= len(src) or src[j] != '"':
                raise ValueError(f"{name}: bad raw string at {i}")
            j += 1
            closer = '"' + ("#" * n_hash)
            k = src.find(closer, j)
            if k < 0:
                raise ValueError(f"{name}: unclosed raw string")
            out[name] = src[j:k]
        elif src[i] == '"':
            j = i + 1
            buf: list[str] = []
            while j < len(src):
                c = src[j]
                if c == "\\":
                    if j + 1 >= len(src):
                        raise ValueError(f"{name}: trailing backslash")
                    esc = src[j + 1]
                    escapes = {
                        "n": "\n",
                        "r": "\r",
                        "t": "\t",
                        "0": "\0",
                        '"': '"',
                        "\\": "\\",
                        "'": "'",
                    }
                    if esc in escapes:
                        buf.append(escapes[esc])
                        j += 2
                    elif esc == "u":
                        if j + 2 >= len(src) or src[j + 2] != "{":
                            raise ValueError(f"{name}: bad unicode escape")
                        end = src.find("}", j + 3)
                        if end < 0:
                            raise ValueError(f"{name}: unclosed unicode escape")
                        buf.append(chr(int(src[j + 3 : end], 16)))
                        j = end + 1
                    else:
                        raise ValueError(f"{name}: unknown escape \\{esc}")
                elif c == '"':
                    out[name] = "".join(buf)
                    break
                else:
                    buf.append(c)
                    j += 1
            else:
                raise ValueError(f"{name}: unclosed string")
        else:
            raise ValueError(f"{name}: unsupported literal starting {src[i:i+20]!r}")
    return out


def require(consts: dict[str, str], name: str) -> str:
    if name not in consts:
        raise KeyError(name)
    return consts[name]


def sub_placeholders(template: str, mapping: dict[str, str]) -> str:
    out = template
    for key, val in mapping.items():
        out = out.replace(key, val)
    return out


def facts_for_prompt(facts: dict) -> dict:
    excluded = {"operationClass", "responseShape", "outputChars", "outputWords"}
    return {k: v for k, v in facts.items() if k not in excluded}


def reconstruct_chunk_brief_v1(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    turns = "\n\n".join(
        f"{idx + 1}. {text}" for idx, text in enumerate(inp["memberProjections"])
    )
    outcomes = [o for group in inp["memberOutcomes"] for o in group]
    outcomes_section = (
        ""
        if not outcomes
        else require(c, "OUTCOMES_SECTION_PREFIX") + ", ".join(outcomes)
    )
    return [
        {"role": "system", "content": require(c, "SYSTEM_PROMPT")},
        {
            "role": "user",
            "content": require(c, "USER_TURNS_PREFIX") + turns + outcomes_section,
        },
    ]


def reconstruct_chunk_brief_v2(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    user = (
        require(c, "USER_PROMPT")
        .replace("{{inputTokens}}", str(inp["inputTokens"]))
        .replace("{{targetMinTokens}}", str(inp["targetMinTokens"]))
        .replace("{{targetMaxTokens}}", str(inp["targetMaxTokens"]))
        .replace("{{targetMidTokens}}", str(inp["targetAimTokens"]))
    )
    user = f"{user}\n\n<actual-input>\n{inp['text']}\n</actual-input>"
    return [
        {"role": "system", "content": require(c, "SYSTEM_PROMPT")},
        {"role": "user", "content": user},
    ]


def reconstruct_chunk_brief_v3(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    stated_aim = stated_target(inp["inputTokens"], 0.075)
    stated_lo = stated_target(inp["inputTokens"], 0.05)
    stated_hi = stated_target(inp["inputTokens"], 0.1)
    job = sub_placeholders(
        require(c, "JOB_TEMPLATE"),
        {
            "${statedAim}": str(stated_aim),
            "${statedLo}": str(stated_lo),
            "${statedHi}": str(stated_hi),
        },
    )
    content = "\n".join(
        [
            require(c, "INSTRUCTIONS_OPEN"),
            require(c, "INSTRUCTIONS_INTRO"),
            "",
            job,
            require(c, "INSTRUCTIONS_CLOSE"),
            "",
            require(c, "CONTENT_OPEN"),
            inp["text"],
            require(c, "CONTENT_CLOSE"),
        ]
    )
    return [{"role": "user", "content": content}]


def _dtc_system_parts(
    c: dict[str, str],
    part_count: int,
    tmpl_map: dict[int, str],
    subs: dict[str, str],
) -> str:
    parts: list[str] = []
    for i in range(part_count):
        if i in tmpl_map:
            parts.append(sub_placeholders(require(c, tmpl_map[i]), subs))
        else:
            parts.append(require(c, f"SYSTEM_PART_{i:02d}"))
    return "\n".join(parts)


def reconstruct_dtc_v1(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    subs = {
        "${i.inputTokens}": str(inp["inputTokens"]),
        "${i.targetAimTokens}": str(inp["targetAimTokens"]),
        "${i.targetMinTokens}": str(inp["targetMinTokens"]),
        "${i.targetMaxTokens}": str(inp["targetMaxTokens"]),
    }
    system = _dtc_system_parts(
        c,
        34,
        {2: "SYSTEM_TMPL_02", 4: "SYSTEM_TMPL_04", 26: "SYSTEM_TMPL_26", 30: "SYSTEM_TMPL_30"},
        subs,
    )
    user = (
        require(c, "USER_WRAPPER_PREFIX")
        + inp["dialogueText"]
        + require(c, "USER_WRAPPER_SUFFIX")
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def reconstruct_dtc_v2(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    subs = {
        "${dialogue.inputTokens}": str(inp["inputTokens"]),
        "${dialogue.targetAimTokens}": str(inp["targetAimTokens"]),
        "${dialogue.targetMinTokens}": str(inp["targetMinTokens"]),
        "${dialogue.targetMaxTokens}": str(inp["targetMaxTokens"]),
    }
    system = _dtc_system_parts(
        c,
        27,
        {2: "SYSTEM_TMPL_02", 4: "SYSTEM_TMPL_04", 19: "SYSTEM_TMPL_19", 23: "SYSTEM_TMPL_23"},
        subs,
    )
    user = (
        require(c, "USER_WRAPPER_PREFIX")
        + inp["dialogueText"]
        + require(c, "USER_WRAPPER_SUFFIX")
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def reconstruct_dtc_v3(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    stated_aim = stated_target(inp["inputTokens"], 0.25)
    stated_lo = stated_target(inp["inputTokens"], 0.2)
    stated_hi = stated_target(inp["inputTokens"], 0.3)
    job = sub_placeholders(
        require(c, "JOB_TEMPLATE"),
        {
            "${statedAim}": str(stated_aim),
            "${statedLo}": str(stated_lo),
            "${statedHi}": str(stated_hi),
        },
    )
    content = "\n".join(
        [
            require(c, "INSTRUCTIONS_OPEN"),
            require(c, "INSTRUCTIONS_INTRO"),
            "",
            job,
            "",
            require(c, "INSTRUCTIONS_PROSE"),
            require(c, "INSTRUCTIONS_CLOSE"),
            "",
            require(c, "CONTENT_OPEN"),
            inp["dialogueText"],
            require(c, "CONTENT_CLOSE"),
        ]
    )
    return [{"role": "user", "content": content}]


def reconstruct_smoothing(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    return [
        {"role": "user", "content": require(c, "SMOOTHING_V1_SYSTEM_INSTRUCTIONS")},
        {
            "role": "user",
            "content": (
                require(c, "SMOOTHING_V1_USER_WRAPPER_PREFIX")
                + inp["text"]
                + require(c, "SMOOTHING_V1_USER_WRAPPER_SUFFIX")
            ),
        },
    ]


def reconstruct_tool_v1(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    system = (
        require(c, "SYSTEM_STATIC_PREFIX")
        + inp["outcome"]
        + require(c, "SYSTEM_STATIC_MID")
        + str(inp["targetTokens"])
        + " tokens. "
        + inp["guidance"]
        + require(c, "SYSTEM_STATIC_SUFFIX")
    )
    user = (
        require(c, "USER_STATIC_TOOL_PREFIX")
        + inp["toolName"]
        + require(c, "USER_STATIC_OUTCOME_MID")
        + inp["outcome"]
        + require(c, "USER_STATIC_OUTPUT_MID")
        + inp["content"]
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def reconstruct_tool_v2(c: dict[str, str], inp: dict) -> list[dict[str, str]]:
    mode = inp["promptMode"]
    mode_const = {
        "receipt": "MODE_GUIDANCE_RECEIPT",
        "failure": "MODE_GUIDANCE_FAILURE",
        "search_summary": "MODE_GUIDANCE_SEARCH_SUMMARY",
        "test_summary": "MODE_GUIDANCE_TEST_SUMMARY",
        "content_summary": "MODE_GUIDANCE_CONTENT_SUMMARY",
        "diff_summary": "MODE_GUIDANCE_DIFF_SUMMARY",
        "large_log": "MODE_GUIDANCE_LARGE_LOG",
        "no_output": "MODE_GUIDANCE_NO_OUTPUT",
        "multi_tool_summary": "MODE_GUIDANCE_MULTI_TOOL_SUMMARY",
        "generic_summary": "MODE_GUIDANCE_GENERIC_SUMMARY",
    }[mode]
    facts = facts_for_prompt(inp["facts"])
    system = "\n".join(
        [
            require(c, "TOOL_RESULT_V2_INTRO"),
            "",
            require(c, "TOOL_RESULT_V2_FACTS_RULE"),
            "",
            require(c, "TOOL_RESULT_V2_FIELD_RULE"),
            "",
            require(c, "TOOL_RESULT_V2_TARGET_LENGTH_PREFIX")
            + str(inp["targetTokens"])
            + require(c, "TOOL_RESULT_V2_TARGET_LENGTH_SUFFIX"),
            require(c, "TOOL_RESULT_V2_PROMPT_MODE_PREFIX") + mode,
            "",
            require(c, "TOOL_RESULT_V2_MODE_GUIDANCE_HEADER"),
            require(c, mode_const),
            "",
            require(c, "TOOL_RESULT_V2_PARSED_FIELDS_HEADER"),
            json.dumps(facts, indent=2, ensure_ascii=False),
        ]
    )
    # Sentinel content is short — no search/middle omit path.
    raw = inp["content"]
    user = (
        require(c, "TOOL_RESULT_V2_USER_TOOL_PREFIX")
        + inp["toolName"]
        + require(c, "TOOL_RESULT_V2_USER_OUTCOME_PREFIX")
        + inp["outcome"]
        + require(c, "TOOL_RESULT_V2_USER_EXCERPT_OPEN")
        + raw
        + require(c, "TOOL_RESULT_V2_USER_EXCERPT_CLOSE")
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


RECONSTRUCTORS = {
    "chunk-brief-v1": reconstruct_chunk_brief_v1,
    "chunk-brief-v2": reconstruct_chunk_brief_v2,
    "chunk-brief-v3": reconstruct_chunk_brief_v3,
    "detailed-turn-compression-v1": reconstruct_dtc_v1,
    "detailed-turn-compression-v2": reconstruct_dtc_v2,
    "detailed-turn-compression-v3": reconstruct_dtc_v3,
    "smoothing-v1": reconstruct_smoothing,
    "tool-result-v1": reconstruct_tool_v1,
    "tool-result-v2": reconstruct_tool_v2,
}


def diff_messages(
    prompt_key: str, got: list[dict[str, str]], expected: list[dict[str, str]]
) -> list[str]:
    failures: list[str] = []
    if len(got) != len(expected):
        failures.append(
            f"{prompt_key}: message count {len(got)} != oracle {len(expected)}"
        )
        return failures
    for i, (g, e) in enumerate(zip(got, expected)):
        if g["role"] != e["role"]:
            failures.append(
                f"{prompt_key}[{i}].role: got {g['role']!r} expected {e['role']!r}"
            )
        if g["content"] != e["content"]:
            # Find first divergence
            a, b = g["content"], e["content"]
            pos = 0
            while pos < min(len(a), len(b)) and a[pos] == b[pos]:
                pos += 1
            failures.append(
                f"{prompt_key}[{i}].content mismatch at offset {pos} "
                f"(got_len={len(a)} exp_len={len(b)}); "
                f"got={a[max(0, pos - 40) : pos + 40]!r} "
                f"exp={b[max(0, pos - 40) : pos + 40]!r}"
            )
    return failures


def parse_registry(mod_src: str) -> list[tuple[str, str]]:
    """Return [(module, render_fn)] in PROMPT_REGISTRY order."""
    block = re.search(
        r"pub const PROMPT_REGISTRY:.*?=\s*&\[(.*?)\];",
        mod_src,
        re.DOTALL,
    )
    if not block:
        raise ValueError("PROMPT_REGISTRY not found in mod.rs")
    entries = re.findall(
        r"PromptCatalogEntry\s*\{\s*"
        r"name:\s*([a-z0-9_]+)::NAME\s*,\s*"
        r"render:\s*([a-z0-9_]+)::([a-z0-9_]+)\s*,\s*"
        r"\}",
        block.group(1),
    )
    return [(mod, fn) for mod, mod2, fn in entries if mod == mod2]


def parse_prompt_names(mod_src: str) -> list[str]:
    block = re.search(
        r"pub const PROMPT_NAMES:.*?=\s*&\[(.*?)\];",
        mod_src,
        re.DOTALL,
    )
    if not block:
        raise ValueError("PROMPT_NAMES not found")
    return re.findall(r"([a-z0-9_]+)::NAME", block.group(1))


def parse_default_names(mod_src: str) -> list[tuple[str, str]]:
    block = re.search(
        r"pub const DEFAULT_PROMPT_NAMES:.*?=\s*&\[(.*?)\];",
        mod_src,
        re.DOTALL,
    )
    if not block:
        raise ValueError("DEFAULT_PROMPT_NAMES not found")
    return re.findall(
        r'\(\s*"([^"]+)"\s*,\s*([a-z0-9_]+)::NAME\s*,?\s*\)',
        block.group(1),
    )


def main() -> int:
    assert stated_target(2000, 0.075) == 150
    assert stated_target(2000, 0.05) == 100
    assert stated_target(2000, 0.1) == 200
    assert stated_target(120, 0.25) == 30
    assert stated_target(120, 0.2) == 20
    assert stated_target(120, 0.3) == 40

    oracle = json.loads(ORACLE_PATH.read_text())
    failures: list[str] = []
    prompts_checked = 0
    consts_checked = 0

    mod_src = MOD_RS.read_text()
    try:
        registry = parse_registry(mod_src)
    except ValueError as exc:
        failures.append(str(exc))
        registry = []

    if [MODULE_FOR[n] for n in REGISTRY_ORDER] != [m for m, _ in registry]:
        failures.append(
            f"PROMPT_REGISTRY module order mismatch: got {[m for m, _ in registry]}"
        )
    for mod, fn in registry:
        if fn != "render_value":
            failures.append(f"PROMPT_REGISTRY {mod}: render is {fn!r}, want render_value")

    names_mods = parse_prompt_names(mod_src)
    if names_mods != [MODULE_FOR[n] for n in REGISTRY_ORDER]:
        failures.append(f"PROMPT_NAMES order/wiring mismatch: {names_mods}")

    defaults = parse_default_names(mod_src)
    mod_to_name = {v: k for k, v in MODULE_FOR.items()}
    defaults_as_names = [(kind, mod_to_name[mod]) for kind, mod in defaults]
    if defaults_as_names != DEFAULT_PROMPT_NAMES_EXPECTED:
        failures.append(
            f"DEFAULT_PROMPT_NAMES mismatch: got {defaults_as_names} "
            f"expected {DEFAULT_PROMPT_NAMES_EXPECTED}"
        )

    if "pub fn registry_get" not in mod_src:
        failures.append("mod.rs missing registry_get helper")

    # Reconstruct + compare each of 9 prompts
    for prompt_key in REGISTRY_ORDER:
        prompts_checked += 1
        if prompt_key not in oracle:
            failures.append(f"{prompt_key}: missing from oracle")
            continue
        rust_file = PROMPT_FILES[prompt_key]
        src = (PROMPTS_DIR / rust_file).read_text()
        try:
            consts = extract_rust_str_consts(src)
        except ValueError as exc:
            failures.append(f"{prompt_key}: const parse error: {exc}")
            continue

        for name in REQUIRED_CONSTS[prompt_key]:
            consts_checked += 1
            if name not in consts:
                failures.append(f"{prompt_key}/{name}: const not found in {rust_file}")

        if consts.get("NAME") != prompt_key:
            failures.append(
                f"{prompt_key}/NAME: got {consts.get('NAME')!r} expected {prompt_key!r}"
            )

        try:
            reconstructed = RECONSTRUCTORS[prompt_key](consts, SENTINELS[prompt_key])
        except KeyError as exc:
            failures.append(f"{prompt_key}: missing const for reconstruction: {exc}")
            continue

        expected_msgs = oracle[prompt_key]["messages"]
        failures.extend(diff_messages(prompt_key, reconstructed, expected_msgs))

        got_joined = join_msgs(reconstructed)
        exp_joined = oracle[prompt_key]["joined"]
        if got_joined != exp_joined:
            failures.append(
                f"{prompt_key}: joined bytes mismatch "
                f"(got_len={len(got_joined)} exp_len={len(exp_joined)})"
            )

        # Empty join parts (TS `""` array slots) must remain present and
        # byte-empty — a non-empty rewrite is a recipe corruption.
        known_empty = {
            "detailed-turn-compression-v1": [
                "SYSTEM_PART_01",
                "SYSTEM_PART_03",
                "SYSTEM_PART_05",
                "SYSTEM_PART_07",
                "SYSTEM_PART_15",
                "SYSTEM_PART_23",
                "SYSTEM_PART_25",
                "SYSTEM_PART_29",
                "SYSTEM_PART_31",
            ],
            "detailed-turn-compression-v2": [
                "SYSTEM_PART_01",
                "SYSTEM_PART_03",
                "SYSTEM_PART_05",
                "SYSTEM_PART_07",
                "SYSTEM_PART_13",
                "SYSTEM_PART_18",
                "SYSTEM_PART_22",
                "SYSTEM_PART_24",
            ],
        }
        for name in known_empty.get(prompt_key, []):
            consts_checked += 1
            got = consts.get(name)
            if got is None:
                failures.append(f"{prompt_key}/{name}: empty part const missing")
            elif got != "":
                failures.append(
                    f"{prompt_key}/{name}: empty part must be \"\", got_len={len(got)}"
                )

    # Extra byte expectations outside the single sentinel fixture
    tr_src = (PROMPTS_DIR / "tool_result_v2.rs").read_text()
    tr_consts = extract_rust_str_consts(tr_src)
    for name, expected in EXPECTED_MODE_GUIDANCE.items():
        consts_checked += 1
        got = tr_consts.get(name)
        if got is None:
            failures.append(f"tool-result-v2/{name}: const not found")
        elif got != expected:
            failures.append(
                f"tool-result-v2/{name}: MODE_GUIDANCE mismatch "
                f"(rust_len={len(got)} expected_len={len(expected)})"
            )
    for name, expected in EXPECTED_OMIT_FRAGMENTS.items():
        consts_checked += 1
        got = tr_consts.get(name)
        if got is None:
            failures.append(f"tool-result-v2/{name}: omit fragment not found")
        elif got != expected:
            failures.append(f"tool-result-v2/{name}: omit fragment byte mismatch")

    tr1 = extract_rust_str_consts((PROMPTS_DIR / "tool_result_v1.rs").read_text())
    for name, expected in EXPECTED_TOOL_V1_TEMPLATES.items():
        consts_checked += 1
        got = tr1.get(name)
        if got != expected:
            failures.append(f"tool-result-v1/{name}: template byte mismatch")

    cb1 = extract_rust_str_consts((PROMPTS_DIR / "chunk_brief_v1.rs").read_text())
    consts_checked += 1
    if cb1.get("OUTCOMES_SECTION_TEMPLATE") != EXPECTED_CHUNK_BRIEF_V1_OUTCOMES_TEMPLATE:
        failures.append("chunk-brief-v1/OUTCOMES_SECTION_TEMPLATE: byte mismatch")

    # Ensure oracle keys match checklist
    oracle_keys = set(oracle.keys())
    checked_keys = set(REGISTRY_ORDER)
    if oracle_keys != checked_keys:
        failures.append(
            f"oracle/checklist key mismatch: "
            f"only_oracle={sorted(oracle_keys - checked_keys)} "
            f"only_checklist={sorted(checked_keys - oracle_keys)}"
        )

    print(
        f"check_prompt_bytes: {prompts_checked} prompts reconstructed, "
        f"{consts_checked} constants checked, "
        f"{len(registry)} registry entries"
    )
    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

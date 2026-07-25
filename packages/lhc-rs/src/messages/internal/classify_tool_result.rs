//! Ported from packages/lhc/src/messages/internal/classify-tool-result.ts.
//!
//! EXEMPLAR MODULE — canonical pattern for a logic module. Public surface
//! plus every private helper (TS non-exported functions stay private fns).
//! Regex dialect: `regex` crate (JS ASCII `\b` via `(?-u:\b)` where needed);
//! `fancy-regex` only for lookaround; ASCII word-boundary after `0` spelled `(?:[^0-9A-Za-z_]|$)`.

use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

use crate::shared_tech::derivation::{
    ToolOutcome, ToolResultClassification, ToolResultFacts, ToolResultOperationClass,
    ToolResultPromptMode, ToolResultResponseShape,
};
use crate::shared_tech::js_json::{js_len, js_number_value, js_trim};

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultClassificationInput {
    pub tool_name: String,
    pub tool_input: Option<serde_json::Map<String, Value>>,
    pub outcome: ToolOutcome,
    pub raw_output: String,
}

pub fn classify_tool_result(input: &ToolResultClassificationInput) -> ToolResultClassification {
    let operation_class = classify_operation(
        &input.tool_name,
        input.tool_input.as_ref(),
        &input.raw_output,
    );
    let response_shape = classify_shape(
        &input.tool_name,
        input.outcome,
        &input.raw_output,
        operation_class,
    );
    let prompt_mode = prompt_mode_for(response_shape, input.outcome);
    let facts = parse_facts(input, operation_class, response_shape);

    ToolResultClassification {
        operation_class,
        response_shape,
        prompt_mode,
        facts,
    }
}

fn command_of(tool_input: Option<&serde_json::Map<String, Value>>) -> String {
    match tool_input.and_then(|m| m.get("command")) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn classify_operation(
    tool_name: &str,
    tool_input: Option<&serde_json::Map<String, Value>>,
    raw_output: &str,
) -> ToolResultOperationClass {
    if tool_name == "read" {
        return ToolResultOperationClass::Read;
    }
    if tool_name == "write" {
        return ToolResultOperationClass::MutationWrite;
    }
    if tool_name == "edit" {
        return ToolResultOperationClass::MutationEdit;
    }
    if tool_name == "multi_tool_use.parallel" {
        return ToolResultOperationClass::MultiTool;
    }
    if tool_name == "bash" {
        let command = command_of(tool_input);
        if re_is_match(r"(?-u:\b)(rg|grep|find)(?-u:\b)", &command) {
            return ToolResultOperationClass::SearchOrListing;
        }
        if re_is_match(
            r"(?-u:\b)(vitest|tsx --test|node --test|npm test|pnpm test|pnpm run verify|tsc|typecheck|lint)(?-u:\b)",
            &command,
        ) {
            return ToolResultOperationClass::Verification;
        }
        if re_is_match(
            r"(?-u:\b)(git diff|git status|git show|git log)(?-u:\b)",
            &command,
        ) {
            return ToolResultOperationClass::VcsInspection;
        }
        if re_is_match(r"(?-u:\b)(rm|mv|cp|mkdir|chmod|touch)(?-u:\b)", &command) {
            return ToolResultOperationClass::FilesystemMutation;
        }
        if re_is_match(
            r"(?-u:\b)(diff --git|Test Files|Tests\s+[0-9]|Command exited with code)(?-u:\b)|[✔✖]",
            raw_output,
        ) {
            return ToolResultOperationClass::Command;
        }
        return ToolResultOperationClass::Command;
    }
    ToolResultOperationClass::Unknown
}

fn classify_shape(
    tool_name: &str,
    outcome: ToolOutcome,
    raw_output: &str,
    operation_class: ToolResultOperationClass,
) -> ToolResultResponseShape {
    let output = js_trim(raw_output);
    let output_length = js_len(output);
    if operation_class == ToolResultOperationClass::MultiTool {
        return ToolResultResponseShape::MultiToolResult;
    }
    if output == "(no output)" || output.is_empty() {
        return ToolResultResponseShape::NoOutput;
    }
    if operation_class == ToolResultOperationClass::SearchOrListing
        && is_search_no_match_output(output)
    {
        return ToolResultResponseShape::SearchResult;
    }
    if is_structured_receipt_output(output) {
        return ToolResultResponseShape::StructuredReceipt;
    }
    if re_is_match_i(
        r"^Found\s+[0-9]+\s+occurrences\s+of\s+.+?\s+in\s+.+?\.",
        output,
    ) {
        return ToolResultResponseShape::StructuredReceipt;
    }
    if re_is_match_i(
        r"(?-u:\b)ENOENT(?-u:\b)|No such file or directory|command not found|invalid option|Cannot find package",
        output,
    ) {
        return ToolResultResponseShape::SimpleFailure;
    }
    if operation_class == ToolResultOperationClass::Verification
        && (re_is_match_i(
            r"(?-u:\b)(Test Files|Tests|failed|passed|vitest|tsc --noEmit|typecheck|lint|CACError|AssertionError|TAP version|# tests)(?-u:\b)",
            output,
        ) || re_is_match(r"[✔✖]", output))
    {
        return ToolResultResponseShape::TestResult;
    }
    if looks_like_test_runner_output(output) {
        return ToolResultResponseShape::TestResult;
    }
    if fancy_is_match_i(
        r"Command exited with code\s+(?!0(?:[^0-9A-Za-z_]|$))[0-9]+",
        output,
    ) && output_length < 1200
    {
        return ToolResultResponseShape::SimpleFailure;
    }
    if re_is_match_m(r"^diff --git(?-u:\b)", output)
        || re_is_match_m(r"\|\s+[0-9]+\s+[+-]+", output)
        || re_is_match_i(r"files? changed,\s+[0-9]+ insertions?", output)
    {
        return ToolResultResponseShape::DiffOutput;
    }
    if operation_class == ToolResultOperationClass::SearchOrListing
        && (re_is_match_m(r"^[0-9]+:", output)
            || re_is_match_m(r"^[^\n:]+:[0-9]+:", output)
            || output_length > 0)
    {
        return ToolResultResponseShape::SearchResult;
    }
    if re_is_match_m(r"^[^\n:]+:[0-9]+:", output) || re_is_match_m(r"^\S+\s+[0-9]+\s*$", output) {
        return ToolResultResponseShape::SearchResult;
    }
    if tool_name == "read" && outcome != ToolOutcome::Failed {
        return if output_length > 5000 {
            ToolResultResponseShape::LargeFileContent
        } else {
            ToolResultResponseShape::FileContent
        };
    }
    if output_length > 5000 {
        return ToolResultResponseShape::LargeLog;
    }
    ToolResultResponseShape::UnknownContent
}

fn prompt_mode_for(
    response_shape: ToolResultResponseShape,
    outcome: ToolOutcome,
) -> ToolResultPromptMode {
    match response_shape {
        ToolResultResponseShape::StructuredReceipt => ToolResultPromptMode::Receipt,
        ToolResultResponseShape::NoOutput => ToolResultPromptMode::NoOutput,
        ToolResultResponseShape::MultiToolResult => ToolResultPromptMode::MultiToolSummary,
        ToolResultResponseShape::SimpleFailure => ToolResultPromptMode::Failure,
        ToolResultResponseShape::SearchResult => ToolResultPromptMode::SearchSummary,
        ToolResultResponseShape::TestResult => ToolResultPromptMode::TestSummary,
        ToolResultResponseShape::DiffOutput => ToolResultPromptMode::DiffSummary,
        ToolResultResponseShape::FileContent | ToolResultResponseShape::LargeFileContent => {
            ToolResultPromptMode::ContentSummary
        }
        ToolResultResponseShape::LargeLog => ToolResultPromptMode::LargeLog,
        ToolResultResponseShape::UnknownContent => {
            if outcome == ToolOutcome::Failed {
                ToolResultPromptMode::Failure
            } else {
                ToolResultPromptMode::GenericSummary
            }
        }
    }
}

fn parse_facts(
    input: &ToolResultClassificationInput,
    operation_class: ToolResultOperationClass,
    response_shape: ToolResultResponseShape,
) -> ToolResultFacts {
    let raw_output = &input.raw_output;
    let search_result = operation_class == ToolResultOperationClass::SearchOrListing
        && response_shape == ToolResultResponseShape::SearchResult;
    let command = command_of(input.tool_input.as_ref());
    let mut bag = Map::new();
    bag.insert("toolName".into(), Value::String(input.tool_name.clone()));
    bag.insert(
        "outcome".into(),
        Value::String(input.outcome.as_str().to_string()),
    );
    bag.insert(
        "operationClass".into(),
        Value::String(operation_class.as_str().to_string()),
    );
    bag.insert(
        "responseShape".into(),
        Value::String(response_shape.as_str().to_string()),
    );
    bag.insert(
        "failureType".into(),
        opt_string(parse_failure_type(raw_output)),
    );
    bag.insert(
        "command".into(),
        if command.is_empty() {
            Value::Null
        } else {
            Value::String(command)
        },
    );
    let mut keep_null_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    insert_js_number(
        &mut bag,
        &mut keep_null_keys,
        "exitCode",
        parse_exit_code(raw_output),
    );
    bag.insert(
        "targetPath".into(),
        opt_string(parse_primary_path(raw_output)),
    );
    insert_js_number(
        &mut bag,
        &mut keep_null_keys,
        "byteCount",
        parse_byte_count(raw_output),
    );
    insert_js_number(
        &mut bag,
        &mut keep_null_keys,
        "blockCount",
        parse_block_count(raw_output),
    );
    bag.insert(
        "mutationDetailsAvailable".into(),
        opt_bool(parse_mutation_details_available(
            &input.tool_name,
            raw_output,
        )),
    );
    bag.insert(
        "failedField".into(),
        opt_string(parse_failed_field(raw_output)),
    );
    insert_js_number(
        &mut bag,
        &mut keep_null_keys,
        "matchCount",
        parse_match_count(raw_output),
    );
    bag.insert(
        "requiredCondition".into(),
        opt_string(parse_required_condition(raw_output)),
    );
    bag.insert(
        "retryGuidance".into(),
        opt_string(parse_retry_guidance(raw_output)),
    );
    bag.insert(
        "missingCommand".into(),
        opt_string(parse_missing_command(raw_output)),
    );
    bag.insert(
        "systemError".into(),
        opt_string(parse_system_error(raw_output)),
    );
    let trimmed = js_trim(raw_output);
    bag.insert(
        "noOutput".into(),
        Value::Bool(trimmed == "(no output)" || trimmed.is_empty()),
    );
    bag.insert(
        "searchNoMatches".into(),
        if search_result {
            Value::Bool(is_search_no_match_output(trimmed))
        } else {
            Value::Null
        },
    );
    bag.insert(
        "searchMatchCount".into(),
        if search_result {
            opt_i64(parse_search_match_count(operation_class, raw_output))
        } else {
            Value::Null
        },
    );
    bag.insert(
        "searchMatches".into(),
        if search_result {
            Value::Array(
                parse_search_matches(operation_class, raw_output)
                    .into_iter()
                    .take(12)
                    .map(Value::Object)
                    .collect(),
            )
        } else {
            Value::Array(Vec::new())
        },
    );
    bag.insert(
        "testSummary".into(),
        match parse_test_summary(operation_class, raw_output) {
            Some(m) => Value::Object(m),
            None => Value::Null,
        },
    );
    bag.insert(
        "subtoolResults".into(),
        match parse_subtool_results(operation_class, raw_output) {
            Some(rows) => Value::Array(rows.into_iter().map(Value::Object).collect()),
            None => Value::Null,
        },
    );
    bag.insert(
        "pathMentions".into(),
        Value::Array(
            parse_path_mentions(raw_output)
                .into_iter()
                .take(12)
                .map(Value::String)
                .collect(),
        ),
    );
    bag.insert(
        "outputChars".into(),
        Value::Number((js_len(raw_output) as i64).into()),
    );
    let word_re = js_regex(r"\s+");
    let output_words = word_re
        .split(raw_output)
        .filter(|part| !part.is_empty())
        .count();
    bag.insert(
        "outputWords".into(),
        Value::Number((output_words as i64).into()),
    );
    remove_nullish(bag, &keep_null_keys)
}

fn looks_like_test_runner_output(output: &str) -> bool {
    re_is_match_i(r"(?-u:\b)TAP version(?-u:\b)", output)
        && re_is_match_i(r"#\s*tests\s+[0-9]+", output)
}

fn is_structured_receipt_output(output: &str) -> bool {
    let lines: Vec<String> = split_nonempty_trimmed_lines(output);
    if lines.is_empty() {
        return false;
    }
    lines.iter().all(|line| {
        re_is_match_i(r"^Successfully wrote\s+[0-9]+\s+bytes to\s+.+\.?$", line)
            || re_is_match_i(
                r"^Successfully replaced\s+[0-9]+\s+block\(s\) in\s+.+\.?$",
                line,
            )
            || re_is_match_i(
                r"^Found\s+[0-9]+\s+occurrences\s+of\s+.+?\s+in\s+.+?\.",
                line,
            )
    })
}

fn is_search_no_match_output(output: &str) -> bool {
    let content_lines: Vec<String> = split_nonempty_trimmed_lines(output)
        .into_iter()
        .filter(|line| !re_is_match_i(r"^Command exited with code\s+1$", line))
        .collect();
    content_lines.is_empty() && re_is_match_i(r"Command exited with code\s+1", output)
}

fn search_content_lines(output: &str) -> Vec<String> {
    split_nonempty_trimmed_lines(output)
        .into_iter()
        .filter(|line| !re_is_match_i(r"^Command exited with code\s+[0-9]+$", line))
        .collect()
}

fn parse_search_match_count(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<i64> {
    if operation_class != ToolResultOperationClass::SearchOrListing {
        return None;
    }
    if is_search_no_match_output(js_trim(output)) {
        return Some(0);
    }
    let lines = search_content_lines(output);
    if lines.is_empty() {
        None
    } else {
        Some(lines.len() as i64)
    }
}

fn parse_search_matches(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Vec<serde_json::Map<String, Value>> {
    if operation_class != ToolResultOperationClass::SearchOrListing {
        return Vec::new();
    }
    let path_line_re = js_regex(r"^([^:]+):([0-9]+):(.*)$");
    let line_only_re = js_regex(r"^([0-9]+):(.*)$");
    search_content_lines(output)
        .into_iter()
        .map(|line| {
            if let Some(caps) = path_line_re.captures(&line) {
                let mut m = Map::new();
                m.insert("path".into(), Value::String(caps[1].to_string()));
                // TS `Number(capture)` — non-finite → JSON null (not 0).
                m.insert("line".into(), js_number_json(&caps[2]));
                m.insert(
                    "text".into(),
                    Value::String(
                        caps.get(3)
                            .map(|c| js_trim(c.as_str()))
                            .unwrap_or("")
                            .to_string(),
                    ),
                );
                return m;
            }
            if let Some(caps) = line_only_re.captures(&line) {
                let mut m = Map::new();
                m.insert("line".into(), js_number_json(&caps[1]));
                m.insert(
                    "text".into(),
                    Value::String(
                        caps.get(2)
                            .map(|c| js_trim(c.as_str()))
                            .unwrap_or("")
                            .to_string(),
                    ),
                );
                return m;
            }
            let mut m = Map::new();
            m.insert("text".into(), Value::String(line));
            m
        })
        .collect()
}

fn parse_test_summary(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<serde_json::Map<String, Value>> {
    if operation_class != ToolResultOperationClass::Verification {
        return None;
    }
    let lines = split_nonempty_trimmed_lines(output);
    let mut summary = Map::new();
    let tests_line = lines.iter().find(|line| {
        re_is_match_i(r"(?-u:\b)tests?(?-u:\b)", line)
            && re_is_match_i(r"(?-u:\b)pass(?:ed)?(?-u:\b)", line)
    });
    let total_match = re_capture_i(r"(?:#\s*)?([0-9]+)\s+tests?(?-u:\b)", output)
        .or_else(|| re_capture_i(r"#\s*tests\s+([0-9]+)", output));
    let passed_match = re_capture_i(r"(?:#\s*)?([0-9]+)\s+pass(?:ed)?(?-u:\b)", output)
        .or_else(|| re_capture_i(r"#\s*pass\s+([0-9]+)", output));
    let failed_match = re_capture_i(r"(?:#\s*)?([0-9]+)\s+fail(?:ed)?(?-u:\b)", output)
        .or_else(|| re_capture_i(r"#\s*fail\s+([0-9]+)", output));
    // Private provenance: distinguish NonFinite captured Numbers (JSON null)
    // from absent keys so inferred totals match TS `Number(a)+Number(b)`
    // when either operand was Infinity (sum → Infinity → null), not Number(null)=0.
    let mut nonfinite_captures: std::collections::HashSet<&'static str> =
        std::collections::HashSet::new();
    if let Some(s) = total_match {
        insert_summary_capture(&mut summary, &mut nonfinite_captures, "total", &s);
    }
    if let Some(s) = passed_match {
        insert_summary_capture(&mut summary, &mut nonfinite_captures, "passed", &s);
    }
    if let Some(s) = failed_match {
        insert_summary_capture(&mut summary, &mut nonfinite_captures, "failed", &s);
    }
    if let Some(line) = tests_line {
        summary.insert("countLine".into(), Value::String(line.clone()));
    }

    let failed_name_re = js_regex(r"[✖xX]\s+(.+?)(?:\s+\(|$)");
    let mut failed_tests: Vec<String> = Vec::new();
    for line in &lines {
        if let Some(caps) = failed_name_re.captures(line) {
            let name = js_trim(&caps[1]).to_string();
            if !re_is_match_i(r"^failing tests:?$", &name) {
                failed_tests.push(name);
            }
        }
    }
    let unique_failed_tests = unique_preserve_order(failed_tests);
    if !unique_failed_tests.is_empty() {
        summary.insert(
            "failedTests".into(),
            Value::Array(
                unique_failed_tests
                    .iter()
                    .take(8)
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if !summary.contains_key("failed") && !unique_failed_tests.is_empty() {
        summary.insert(
            "failed".into(),
            Value::Number((unique_failed_tests.len() as i64).into()),
        );
    }
    if !summary.contains_key("passed") {
        let pass_markers = lines
            .iter()
            .filter(|line| re_is_match(r"^[✔vV]\s+", line))
            .count();
        if pass_markers > 0 {
            summary.insert("passed".into(), Value::Number((pass_markers as i64).into()));
        }
    }
    if !summary.contains_key("total")
        && summary.contains_key("passed")
        && summary.contains_key("failed")
    {
        // TS: Number(summary["passed"]) + Number(summary["failed"]).
        // Non-finite captured operands stay Infinity until stringify → null;
        // do not reinterpret JSON-null leaves as zero.
        if nonfinite_captures.contains("passed") || nonfinite_captures.contains("failed") {
            summary.insert("total".into(), Value::Null);
        } else {
            let passed = summary
                .get("passed")
                .and_then(Value::as_f64)
                .expect("finite passed capture");
            let failed = summary
                .get("failed")
                .and_then(Value::as_f64)
                .expect("finite failed capture");
            summary.insert("total".into(), js_number_value(passed + failed));
        }
    }

    let assertion_lines: Vec<String> = lines
        .into_iter()
        .filter(|line| {
            re_is_match_i(
                r"AssertionError|Expected values|strictly deep-equal|actual|expected",
                line,
            )
        })
        .collect();
    if !assertion_lines.is_empty() {
        summary.insert(
            "assertionLines".into(),
            Value::Array(
                assertion_lines
                    .into_iter()
                    .take(8)
                    .map(Value::String)
                    .collect(),
            ),
        );
    }

    if let Some(s) = re_capture_i(r"Command exited with code\s+([0-9]+)", output) {
        insert_summary_capture(&mut summary, &mut nonfinite_captures, "exitCode", &s);
    }
    if summary.is_empty() {
        None
    } else {
        Some(summary)
    }
}

fn parse_subtool_results(
    operation_class: ToolResultOperationClass,
    output: &str,
) -> Option<Vec<serde_json::Map<String, Value>>> {
    if operation_class != ToolResultOperationClass::MultiTool {
        return None;
    }
    let line_re = js_regex_i(r"^([^:]+):\s*(succeeded|failed)(?:,\s*(.*))?$");
    Some(
        split_nonempty_trimmed_lines(output)
            .into_iter()
            .map(|line| {
                if let Some(caps) = line_re.captures(&line) {
                    let mut row = Map::new();
                    row.insert("label".into(), Value::String(caps[1].to_string()));
                    row.insert(
                        "outcome".into(),
                        Value::String(caps[2].to_ascii_lowercase()),
                    );
                    row.insert(
                        "detail".into(),
                        match caps.get(3) {
                            Some(c) => Value::String(c.as_str().to_string()),
                            None => Value::Null,
                        },
                    );
                    remove_nullish(row, &std::collections::HashSet::new())
                } else {
                    let mut row = Map::new();
                    row.insert("text".into(), Value::String(line));
                    row
                }
            })
            .collect(),
    )
}

fn parse_exit_code(output: &str) -> JsNumber {
    match re_capture_i(r"Command exited with code\s+([0-9]+)", output) {
        Some(s) => js_number(&s),
        None => JsNumber::None,
    }
}

fn parse_byte_count(output: &str) -> JsNumber {
    match re_capture_i(r"Successfully wrote\s+([0-9]+)\s+bytes", output) {
        Some(s) => js_number(&s),
        None => JsNumber::None,
    }
}

fn parse_block_count(output: &str) -> JsNumber {
    match re_capture_i(r"Successfully replaced\s+([0-9]+)\s+block\(s\)", output) {
        Some(s) => js_number(&s),
        None => JsNumber::None,
    }
}

fn parse_match_count(output: &str) -> JsNumber {
    match re_capture_i(r"Found\s+([0-9]+)\s+occurrences", output) {
        Some(s) => js_number(&s),
        None => JsNumber::None,
    }
}

fn parse_mutation_details_available(tool_name: &str, output: &str) -> Option<bool> {
    if tool_name != "write" && tool_name != "edit" {
        return None;
    }
    let trimmed = js_trim(output);
    if re_is_match_i(r"^Successfully wrote\s+[0-9]+\s+bytes to\s+.+\.?$", trimmed) {
        return Some(false);
    }
    if re_is_match_i(
        r"^Successfully replaced\s+[0-9]+\s+block\(s\) in\s+.+\.?$",
        trimmed,
    ) {
        return Some(false);
    }
    None
}

fn parse_failed_field(output: &str) -> Option<String> {
    let occurrence = re_capture_i(
        r"Found\s+[0-9]+\s+occurrences\s+of\s+([^\s]+)\s+in\s+([^.]*(?:\.[A-Za-z0-9_-]+)+)",
        output,
    )?;
    let unique_field = re_capture_i(r"Each\s+([^\s]+)\s+must be unique", output);
    Some(match unique_field {
        Some(field) => format!("{occurrence}.{field}"),
        None => occurrence,
    })
}

fn parse_required_condition(output: &str) -> Option<String> {
    re_capture_i(r"Each\s+([^\s]+)\s+must be unique", output)
        .map(|field| format!("{field} must match exactly one location"))
}

fn parse_retry_guidance(output: &str) -> Option<String> {
    if re_is_match_i(r"provide more context", output) {
        return Some(
            "retry with more surrounding context so the replacement target is unique".to_string(),
        );
    }
    if re_is_match_i(r"command not found", output) {
        return Some(
            "install the command or invoke it through the project package runner".to_string(),
        );
    }
    if re_is_match_i(r"No such file or directory|ENOENT", output) {
        return Some("check the path or run from the expected working directory".to_string());
    }
    None
}

fn parse_missing_command(output: &str) -> Option<String> {
    re_capture_i(r"(?:sh|bash|zsh):\s*([^:\s]+):\s*command not found", output)
}

fn parse_system_error(output: &str) -> Option<String> {
    re_capture(
        r"(?-u:\b)(ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR)(?-u:\b)",
        output,
    )
}

fn parse_failure_type(output: &str) -> Option<String> {
    if re_is_match_i(r"Found\s+[0-9]+\s+occurrences", output) {
        return Some("non_unique_old_text".to_string());
    }
    if re_is_match_i(r"command not found", output) {
        return Some("command_not_found".to_string());
    }
    if re_is_match_i(r"No such file or directory|ENOENT", output) {
        return Some("missing_path".to_string());
    }
    if re_is_match_i(r"invalid option", output) {
        return Some("invalid_option".to_string());
    }
    if re_is_match_i(r"Cannot find package", output) {
        return Some("missing_package".to_string());
    }
    if fancy_is_match_i(
        r"Command exited with code\s+(?!0(?:[^0-9A-Za-z_]|$))[0-9]+",
        output,
    ) {
        return Some("nonzero_exit".to_string());
    }
    None
}

fn parse_primary_path(output: &str) -> Option<String> {
    if let Some(path) = re_capture_i(
        r"Successfully wrote\s+[0-9]+\s+bytes to\s+(.+?)\.?$",
        output,
    ) {
        return Some(trim_path(&path));
    }
    if let Some(path) = re_capture_i(
        r"Successfully replaced\s+[0-9]+\s+block\(s\) in\s+(.+?)\.?$",
        output,
    ) {
        return Some(trim_path(&path));
    }
    if let Some(path) = re_capture_i(
        r"Found\s+[0-9]+\s+occurrences\s+of\s+[^\s]+\s+in\s+(.+?)\.",
        output,
    ) {
        return Some(trim_path(&path));
    }
    if let Some(path) = re_capture_i(r#"access ['"]([^'"]+)['"]"#, output) {
        return Some(path);
    }
    if let Some(path) = re_capture_i(r"find:\s+([^:]+):\s+No such file or directory", output) {
        return Some(trim_path(&path));
    }
    if let Some(path) = re_capture_i(r"Location of .*?:\s*(.+)", output) {
        return Some(trim_path(&path));
    }
    None
}

fn parse_path_mentions(output: &str) -> Vec<String> {
    let re = js_regex(r"(?:\.?\.?/|/Users/|[A-Za-z0-9_.-]+/)[A-Za-z0-9_./@-]+");
    let matches: Vec<String> = re
        .find_iter(output)
        .map(|m| trim_path(m.as_str()))
        .collect();
    unique_preserve_order(matches)
}

fn trim_path(value: &str) -> String {
    let trimmed = js_trim(value);
    let re = js_regex(r"[.,;:]+$");
    re.replace(trimmed, "").into_owned()
}

/// TS `removeNullish`: drops null/undefined values and empty arrays from a
/// facts bag before it is stored. Non-finite JS Number placeholders stay as
/// `Null` *in their original insertion positions* (do not strip+reappend).
fn remove_nullish(
    value: serde_json::Map<String, Value>,
    keep_null_keys: &std::collections::HashSet<String>,
) -> ToolResultFacts {
    value
        .into_iter()
        .filter(|(k, v)| match v {
            Value::Null => keep_null_keys.contains(k),
            Value::Array(a) if a.is_empty() => false,
            _ => true,
        })
        .collect()
}

// ── regex / string helpers (JS dialect notes) ──────────────────────────────
// Unicode mode stays on so UTF-8 haystacks work. JS ASCII `\b` is spelled
// `(?-u:\b)` at call sites; lookaround uses `fancy-regex`. JS `\s` / `.` are
// expanded by [`translate_js_regex_pattern`].

/// ECMAScript WhiteSpace + LineTerminator atoms (same set as [`js_trim`]).
const ES_WS_CHARS: &str = "\\t\\x0B\\f \\xA0\\u{FEFF}\\n\\r\\u{2028}\\u{2029}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}";
const ES_WS_CLASS: &str = "[\\t\\x0B\\f \\xA0\\u{FEFF}\\n\\r\\u{2028}\\u{2029}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}]";
const ES_NOT_WS_CLASS: &str = "[^\\t\\x0B\\f \\xA0\\u{FEFF}\\n\\r\\u{2028}\\u{2029}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}]";
/// JS `.` without `s`/`dotAll`: any char except LF, CR, LS, PS.
const JS_DOT_CLASS: &str = "[^\\n\\r\\u{2028}\\u{2029}]";

/// Expand JS `\s` / `\S` / `.` to ECMAScript-faithful Rust regex fragments.
/// When `multiline` is false, unescaped `$` outside character classes becomes
/// Rust `\z` (JS non-multiline `$` is end-of-input only; Rust `$` also matches
/// before a final line terminator).
fn translate_js_regex_pattern(pattern: &str, multiline: bool) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            match (n, in_class) {
                ('s', false) => {
                    out.push_str(ES_WS_CLASS);
                    i += 2;
                    continue;
                }
                ('s', true) => {
                    out.push_str(ES_WS_CHARS);
                    i += 2;
                    continue;
                }
                ('S', false) => {
                    out.push_str(ES_NOT_WS_CLASS);
                    i += 2;
                    continue;
                }
                ('S', true) => {
                    out.push_str(ES_NOT_WS_CLASS);
                    i += 2;
                    continue;
                }
                _ => {
                    out.push(c);
                    out.push(n);
                    i += 2;
                    continue;
                }
            }
        }
        if c == '[' && !in_class {
            in_class = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ']' && in_class {
            in_class = false;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '.' && !in_class {
            out.push_str(JS_DOT_CLASS);
            i += 1;
            continue;
        }
        if c == '$' && !in_class && !multiline {
            out.push_str(r"\z");
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn js_regex(pattern: &str) -> Regex {
    let pattern = translate_js_regex_pattern(pattern, false);
    Regex::new(&pattern).unwrap_or_else(|e| panic!("invalid regex {pattern:?}: {e}"))
}

fn js_regex_i(pattern: &str) -> Regex {
    let pattern = translate_js_regex_pattern(pattern, false);
    RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|e| panic!("invalid regex {pattern:?}: {e}"))
}

fn js_regex_m(pattern: &str) -> Regex {
    let pattern = translate_js_regex_pattern(pattern, true);
    RegexBuilder::new(&pattern)
        .multi_line(true)
        .build()
        .unwrap_or_else(|e| panic!("invalid regex {pattern:?}: {e}"))
}

/// JS `(?m)` line terminators: LF, CR, LS, PS (Rust `(?m)` is LF-only).
fn js_multiline_haystack(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n")
}

fn re_is_match(pattern: &str, text: &str) -> bool {
    js_regex(pattern).is_match(text)
}

fn re_is_match_i(pattern: &str, text: &str) -> bool {
    js_regex_i(pattern).is_match(text)
}

fn re_is_match_m(pattern: &str, text: &str) -> bool {
    let hay = js_multiline_haystack(text);
    js_regex_m(pattern).is_match(&hay)
}

fn re_capture(pattern: &str, text: &str) -> Option<String> {
    js_regex(pattern)
        .captures(text)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

fn re_capture_i(pattern: &str, text: &str) -> Option<String> {
    js_regex_i(pattern)
        .captures(text)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

fn fancy_is_match_i(pattern: &str, text: &str) -> bool {
    let pattern = translate_js_regex_pattern(pattern, false);
    let re = fancy_regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|e| panic!("invalid fancy-regex {pattern:?}: {e}"));
    re.is_match(text).unwrap_or(false)
}

/// Exact TS `.split(/\r?\n/)` — lone CR / LS / PS stay inside the line.
fn split_nonempty_trimmed_lines(output: &str) -> Vec<String> {
    let re = Regex::new(r"\r?\n").unwrap_or_else(|e| panic!("split regex: {e}"));
    re.split(output)
        .map(|line| js_trim(line).to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn unique_preserve_order(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// JS `Number(string)` via f64. Safe integers keep integer JSON form; values
/// outside `Number.MAX_SAFE_INTEGER` keep the rounded f64 bits; non-finite
/// results survive into the facts bag as JSON `null` after stringify.
#[derive(Debug, Clone)]
enum JsNumber {
    None,
    Finite(Value),
    NonFinite,
}

fn js_number(s: &str) -> JsNumber {
    let Ok(n) = s.parse::<f64>() else {
        return JsNumber::None;
    };
    if !n.is_finite() {
        return JsNumber::NonFinite;
    }
    // Shared JS number lane (safe-integer i64 leaves, Node large-magnitude spelling).
    JsNumber::Finite(js_number_value(n))
}

/// TS `Number(capture)` as a JSON leaf — finite via shared lane; non-finite → null.
fn js_number_json(s: &str) -> Value {
    match js_number(s) {
        JsNumber::Finite(v) => v,
        JsNumber::NonFinite | JsNumber::None => Value::Null,
    }
}

fn insert_summary_capture(
    summary: &mut Map<String, Value>,
    nonfinite_captures: &mut std::collections::HashSet<&'static str>,
    key: &'static str,
    s: &str,
) {
    match js_number(s) {
        JsNumber::Finite(v) => {
            summary.insert(key.into(), v);
        }
        JsNumber::NonFinite => {
            nonfinite_captures.insert(key);
            summary.insert(key.into(), Value::Null);
        }
        JsNumber::None => {}
    }
}

fn insert_js_number(
    bag: &mut Map<String, Value>,
    keep_null: &mut std::collections::HashSet<String>,
    key: &str,
    n: JsNumber,
) {
    match n {
        JsNumber::None => {
            bag.insert(key.to_string(), Value::Null);
        }
        JsNumber::Finite(v) => {
            bag.insert(key.to_string(), v);
        }
        JsNumber::NonFinite => {
            keep_null.insert(key.to_string());
            bag.insert(key.to_string(), Value::Null);
        }
    }
}

fn opt_string(v: Option<String>) -> Value {
    match v {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}

fn opt_i64(v: Option<i64>) -> Value {
    match v {
        Some(n) => Value::Number(n.into()),
        None => Value::Null,
    }
}

fn opt_bool(v: Option<bool>) -> Value {
    match v {
        Some(b) => Value::Bool(b),
        None => Value::Null,
    }
}

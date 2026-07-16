export type ToolOutcome = "succeeded" | "failed" | "unknown";
export type ToolResultOperationClass =
  | "read"
  | "mutation_write"
  | "mutation_edit"
  | "command"
  | "search_or_listing"
  | "verification"
  | "vcs_inspection"
  | "filesystem_mutation"
  | "multi_tool"
  | "unknown";
export type ToolResultResponseShape =
  | "structured_receipt"
  | "simple_failure"
  | "no_output"
  | "search_result"
  | "test_result"
  | "file_content"
  | "large_file_content"
  | "diff_output"
  | "large_log"
  | "multi_tool_result"
  | "unknown_content";
export type ToolResultPromptMode =
  | "receipt"
  | "failure"
  | "no_output"
  | "search_summary"
  | "test_summary"
  | "content_summary"
  | "diff_summary"
  | "large_log"
  | "multi_tool_summary"
  | "generic_summary";
export type ToolResultFacts = Record<string, unknown>;

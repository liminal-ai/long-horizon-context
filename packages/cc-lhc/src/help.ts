export const CC_LHC_HELP = `cc-lhc — Long Horizon Context wrapper for Claude Code

Usage:
  cc-lhc [cc-lhc flags] [claude args...]
  cc-lhc get-turns [--from TOKENS] <tN>...
  cc-lhc get-messages [--from TOKENS] <mN>...
  cc-lhc backfill-labels <thread-id-or-prefix> [--dry-run]
  cc-lhc --lhc-help

Wrapper flags:
  --lhc-no-inference               Disable derivation model calls
  --lhc-no-notifier                Disable lifecycle-command warnings
  --lhc-auto-compact=on|off        Override automatic Smart Compact for this launch
  --lhc-lower-bound-tokens=N       Override Smart Compact target for this launch
  --lhc-upper-bound-tokens=N       Override automatic Smart Compact trigger
  --lhc-min-runway-tokens=N        Override minimum trigger/target runway
  --lhc-profile=default|balanced|historical  Override Band % allocation

Environment:
  CC_LHC_HOME                      State root (default: ~/.cc-lhc; on Windows it
                                   must stay inside your user profile)
  CC_LHC_CLAUDE_BIN                Claude binary path (on Windows: an absolute
                                   native .exe — never a .cmd shim)
  CC_LHC_NO_INFERENCE=1            Disable derivation model calls
  CC_LHC_INFERENCE_CONCURRENCY=N   Derivation subprocess concurrency
  CC_LHC_INFERENCE_TIMEOUT_MS=N    Derivation subprocess timeout
  CC_LHC_LEADER=KEY                Control-panel key (default: ctrl-])
  CC_LHC_INPUT_DEBUG=FILE          Append input-protocol diagnostics to FILE
  CC_LHC_RUNTIME_DESCRIPTOR        Wrapper-owned retrieval binding; do not set manually
  BASH_MAX_OUTPUT_LENGTH=N         Further clamp retrieval stdout bytes
  XDG_CONFIG_HOME                  Base directory for user context policy

Control panel:
  Press ctrl-] (or CC_LHC_LEADER) while Claude is running.
  Commands: /status, /stats, /smart-compact, /smart-prune [tokens], /export,
            /auto on|off, /bounds <target> <trigger>, /allocation, /details,
            /help, /introduction
  Commands start with / and are lowercase. Type / in the panel for suggestions;
  Tab completes. /help lists every command; /introduction explains CC-LHC.

Reserved subcommands are handled by cc-lhc. Ordinary Claude arguments, including
--help, are forwarded after safe session-selector normalization.`;

export function isLhcHelpArgv(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === "--lhc-help";
}

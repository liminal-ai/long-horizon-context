import type { EngineInterface, On, RenderChildren, Timer } from "claude-code";
import { ago, kilo, type LastCompact, parseLhcArgs, pressureOf, statusReport } from "../../src/panel.ts";
import type { Settings } from "../../src/settings.ts";
import { compactNow, editSetting, editSettings, exportThread, refresh } from "./commands.ts";
import { log } from "./sidecar.ts";
import { readPanel } from "./state.ts";

export const PANE = "lhc";
const REFRESH_MS = 5000;
const DOCK_COLUMNS = 52;
const INLINE_ROWS = 18;
const WIDE_COLUMNS = 96;
const BAR_MAX = 60;

export const AUTO_COMPACT_WARNING =
  "Auto-compact is off, so LHC stops compacting: Claude Code no longer starts the compactions LHC answers. " +
  "/compact and /lhc compact still use LHC.";

const SETTING_ROWS: ReadonlyArray<{ field: keyof Settings; label: string }> = [
  { field: "lowerBound", label: "Lower bound" },
  { field: "upperBound", label: "Upper bound" },
  { field: "compactPercent", label: "Percent of window" },
];

let refreshTimer: Timer | undefined;

const tokenText = (tokens: number): string => (tokens % 1000 === 0 ? `${tokens / 1000}k` : `${tokens}`);

function bar(fraction: number, width: number): { filled: string; empty: string } {
  const halves = Math.round(Math.min(1, Math.max(0, fraction)) * width * 2);
  const filled = "━".repeat(Math.floor(halves / 2)) + (halves % 2 === 1 ? "╸" : "");
  return { filled, empty: "━".repeat(width - filled.length) };
}

const pressureColor = (fraction: number): "success" | "warning" | "error" =>
  fraction < 0.7 ? "success" : fraction < 0.9 ? "warning" : "error";

function lastCompactLines(last: LastCompact, now: number): { head: string; body: string; isWarning: boolean } {
  const head = `${ago(now - last.at)} · ${last.trigger} · ${last.op}`;
  if (last.by === "native") return { head, body: `Claude Code's summary ran: ${last.reason}`, isWarning: true };
  const from = last.before === undefined ? "" : `${kilo(last.before)} → `;
  return { head: `${head} · ${last.isMidTurn ? "mid-turn" : "settled"}`, body: `${from}${kilo(last.after)} by LHC`, isWarning: false };
}

async function openPane($: EngineInterface): Promise<string | undefined> {
  const opened = await $.ui.open({ id: PANE, title: "LHC", focus: true, rows: INLINE_ROWS, columns: DOCK_COLUMNS });
  if (!opened.isPlaced) return `The LHC panel is waiting for room: ${opened.reason}`;
  refreshTimer ??= $.clock.every(REFRESH_MS, () => {
    void (async () => {
      const pane = (await $.ui.panes()).find((one) => one.id === PANE);
      if (pane === undefined) {
        refreshTimer?.cancel();
        refreshTimer = undefined;
        return;
      }
      if (pane.isShown) {
        await refresh($);
        $.ui.invalidate("ui.render");
      }
    })().catch((error: unknown) => log($, `panel refresh failed: ${String(error)}`));
  });
  void refresh($).catch((error: unknown) => log($, `panel refresh failed: ${String(error)}`));
  return undefined;
}

export async function registerPanelCommand($: EngineInterface): Promise<void> {
  await $.command.register({
    name: "lhc",
    description: "Open the LHC panel: context pressure, the last compaction, derivations and settings",
    argumentHint: "[status | compact | prune | export | bounds <lower> <upper> [percent]]",
  });
}

export function registerPanel(on: On): void {
  on("command.run", { command: "lhc" }, async ($, e) => {
    const command = parseLhcArgs(e.args);
    switch (command.kind) {
      case "open": {
        const waiting = await openPane($);
        return waiting === undefined ? {} : { text: waiting };
      }
      case "status":
        await refresh($).catch((error: unknown) => log($, `status refresh failed: ${String(error)}`));
        return { text: statusReport(await readPanel($), Date.now()) };
      case "compact":
      case "prune": {
        // A command hook cannot run /compact itself: it would wait on the turn this hook holds.
        const op = command.kind;
        $.clock.after(0, () => void compactNow($, op));
        return { text: op === "prune" ? "LHC prunes once this command ends." : "LHC compacts once this command ends." };
      }
      case "export":
        return { text: await exportThread($) };
      case "bounds":
        return { text: await editSettings($, command.edits) };
      case "invalid":
        return { text: command.text };
    }
  });

  on("config.set", { key: "autoCompact" }, async ($, e, next) => {
    const written = await next(e);
    if (written.value === false && e.previous !== false) {
      $.ui.toast(AUTO_COMPACT_WARNING, { timeoutMs: 12_000 });
      $.ui.log(AUTO_COMPACT_WARNING);
    }
    return written;
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const state = await readPanel($);
    const now = Date.now();
    const table = $.ui.resolve(e);
    const { Box, Text, Button } = table;
    const Input = "Input" in table ? table.Input : undefined;
    const isWide = e.props.bodyColumns >= WIDE_COLUMNS;
    const columnWidth = Math.max(20, isWide ? Math.floor((e.props.bodyColumns - 6) / 2) : e.props.bodyColumns - 2);
    const { policy, settings, lastCompact, derivations, action, thread } = state;
    const pressure = pressureOf(state);
    const drawn = bar(pressure ?? 0, Math.min(BAR_MAX, columnWidth));

    const section = (label: string, body: RenderChildren) => (
      <Box flexDirection="column">
        <Text dimColor bold>
          {label}
        </Text>
        {body}
      </Box>
    );

    const pressureBlock =
      pressure === undefined || policy === null || state.context === null ? (
        <Text dimColor>Waiting for the session's first figures.</Text>
      ) : (
        <Box flexDirection="column">
          <Box justifyContent="space-between" width={columnWidth}>
            <Text>
              <Text bold>{kilo(state.context)}</Text>
              <Text dimColor> of {kilo(policy.trigger)} trigger</Text>
            </Text>
            <Text bold color={pressureColor(pressure)}>
              {Math.round(pressure * 100)}%
            </Text>
          </Box>
          <Text mono>
            <Text color={pressureColor(pressure)}>{drawn.filled}</Text>
            <Text dimColor>{drawn.empty}</Text>
          </Text>
        </Box>
      );

    const compactBlock = (() => {
      if (lastCompact === null) return <Text dimColor>None since Claude Code started.</Text>;
      const lines = lastCompactLines(lastCompact, now);
      return (
        <Box flexDirection="column">
          <Text color={lines.isWarning ? "warning" : undefined}>{lines.body}</Text>
          <Text dimColor>{lines.head}</Text>
        </Box>
      );
    })();

    const derivationBlock =
      derivations === null ? (
        <Text dimColor>Not recorded yet.</Text>
      ) : (
        <Text>
          {derivations.ready} ready · {derivations.pending} pending ·{" "}
          <Text color={derivations.failed > 0 ? "error" : undefined}>{derivations.failed} failed</Text>
          {derivations.blocked > 0 ? <Text color="warning"> · {derivations.blocked} blocked</Text> : null}
        </Text>
      );

    const settingRows = SETTING_ROWS.map(({ field, label }) => {
      const value = settings === null ? "" : field === "compactPercent" ? `${settings[field]}` : tokenText(settings[field]);
      if (Input === undefined) {
        return (
          <Text>
            {label}: {value}
          </Text>
        );
      }
      return (
        <Input key={field} label={label} value={value} submitLabel="save" onSubmit={(text: string) => void editSetting($, field, text)} />
      );
    });

    const effective =
      policy === null ? null : (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>Compacts at </Text>
            <Text bold>{kilo(policy.trigger)}</Text>
            <Text dimColor>, back to </Text>
            <Text bold>{kilo(policy.target)}</Text>
            <Text dimColor> · {kilo(policy.window)} window</Text>
          </Text>
          {policy.isClamped ? (
            <Text color="warning">
              Clamped: a {kilo(policy.window)} window leaves room for {kilo(policy.trigger)} at most.
            </Text>
          ) : null}
        </Box>
      );

    const actions = (
      <Box flexDirection="column">
        <Box gap={1} flexWrap="wrap">
          <Button key="compact" label="Compact now" hotkey="c" variant="primary" onPress={() => void compactNow($, "compact")} />
          <Button key="prune" label="Prune" hotkey="p" onPress={() => void compactNow($, "prune")} />
          <Button key="export" label="Export" hotkey="e" onPress={() => void exportThread($)} />
        </Box>
        {action === null ? null : (
          <Text
            color={action.state === "failed" ? "error" : action.state === "done" ? "success" : undefined}
            dimColor={action.state === "running"}
          >
            {action.state === "failed" ? "✗ " : action.state === "done" ? "✓ " : "… "}
            {action.text}
          </Text>
        )}
        <Text dimColor>{e.props.isFocused
            ? isWide
              ? "Tab moves · Enter saves · c compact · p prune · e export · Esc back"
              : "Tab · Enter saves · c p e · Esc back"
            : isWide
              ? "ctrl+x tab to use the panel · ctrl+x x closes it"
              : "ctrl+x tab: use · ctrl+x x: close"}</Text>
      </Box>
    );

    const live = [
      section("CONTEXT", pressureBlock),
      section("LAST COMPACTION", compactBlock),
      section("DERIVATIONS", derivationBlock),
    ];
    const controls = [
      section(
        "SETTINGS · ALL SESSIONS",
        <Box flexDirection="column">
          {settingRows}
          {effective}
        </Box>,
      ),
      actions,
    ];

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box justifyContent="space-between">
          <Text bold color="claude" size="heading">
            Long Horizon Context
          </Text>
          {thread === null ? null : (
            <Text dimColor wrap="truncate-middle">
              {thread.id}
            </Text>
          )}
        </Box>
        {isWide ? (
          <Box gap={4}>
            <Box flexDirection="column" gap={1} width={columnWidth}>
              {live}
            </Box>
            <Box flexDirection="column" gap={1} width={columnWidth}>
              {controls}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            {live}
            {controls}
          </Box>
        )}
      </Box>
    );
  });
}

/**
 * The single setup flow: one checklist covering every place Diff Review has
 * something to install — the MCP server registration and the four agent slash
 * commands — instead of one command per component.
 *
 * Discovery stays in `mcp-consumers.ts` and `slash-commands.ts`; this module
 * merges their targets into one row per agent/place (`setupRows`), describes
 * each row for the picker, and performs the writes for the rows the user
 * explicitly picked (`applySetup`). Nothing here prompts per target: picking a
 * row in the checklist is the confirmation, so the only fallback needed is
 * the clipboard — for configs that cannot be edited safely and for writes
 * that fail — mirroring the per-component commands this replaced.
 */
import type { McpConsumerTarget } from '../../mcp-consumers';
import type { CommandId, InstallOutcome, SlashCommandTarget } from '../../slash-commands';
import { slashCommandRowIcon, slashCommandRowLabel } from './slash-command-presentation';

/** One agent or place, with whichever halves of Diff Review it can host. */
export interface SetupRow {
  id: string;
  label: string;
  /** The MCP registration target, when this place has an MCP config. */
  consumer?: McpConsumerTarget;
  /** The slash-command directory target, when this agent reads commands. */
  commands?: SlashCommandTarget;
}

/**
 * Merge both discovery lists into one row per id. The ids are shared by
 * construction ('claude', 'codex', 'vscode', 'vscode:profile:<location>'), so
 * a place that hosts both halves — like Claude Code or Codex — appears once.
 * Rows only either list knows about (Cursor has no command directory; Gemini
 * has no MCP registration here) keep the half they have.
 */
export function setupRows(consumers: McpConsumerTarget[], commands: SlashCommandTarget[]): SetupRow[] {
  const rows = new Map<string, SetupRow>();
  const rowFor = (id: string, label: string): SetupRow => {
    const existing = rows.get(id);
    if (existing) return existing;
    const row: SetupRow = { id, label };
    rows.set(id, row);
    return row;
  };

  for (const consumer of consumers) rowFor(consumer.id, consumer.label).consumer = consumer;
  for (const target of commands) rowFor(target.id, target.label).commands = target;
  return [...rows.values()];
}

export function consumerStatusNote(target: McpConsumerTarget): string {
  if (!target.writable) return `not registered (manual) — ${target.reason}`;
  switch (target.status) {
    case 'current':
      return 'registered';
    case 'stale':
      return `registered — runs ${target.current}`;
    case 'missing':
      return 'not registered';
  }
}

const CONSUMER_ICON: Record<McpConsumerTarget['status'], string> = {
  current: '$(check)',
  stale: '$(warning)',
  missing: '$(circle-outline)',
};

/** Worst of the halves: a stale/missing part anywhere makes the row a warning. */
export function setupRowIcon(row: SetupRow): string {
  const icons: string[] = [];
  if (row.consumer) icons.push(CONSUMER_ICON[row.consumer.status]);
  if (row.commands) icons.push(slashCommandRowIcon(row.commands));
  if (icons.includes('$(warning)')) return '$(warning)';
  if (icons.length > 0 && icons.every((icon) => icon === '$(check)')) return '$(check)';
  return '$(circle-outline)';
}

/** The state of both halves, phrased for the picker's description column. */
export function setupRowDescription(row: SetupRow): string {
  const parts: string[] = [];
  if (row.consumer) parts.push(`MCP: ${consumerStatusNote(row.consumer)}`);
  if (row.commands) parts.push(`commands: ${slashCommandRowLabel(row.commands)}`);
  return parts.join(' · ');
}

/** The files a setup of this row would touch, shortened by the caller's formatter. */
export function setupRowDetail(
  row: SetupRow,
  formatPath: (filePath: string) => string = (filePath) => filePath,
): string {
  const paths: string[] = [];
  if (row.consumer) paths.push(formatPath(row.consumer.configPath));
  if (row.commands) paths.push(formatPath(row.commands.dirPath));
  return paths.join('\n');
}

export interface SetupDeps {
  registerConsumer(target: McpConsumerTarget): { backup?: string };
  installCommands(target: SlashCommandTarget): InstallOutcome;
  renderSnippet(target: McpConsumerTarget): string;
  renderClipboard(target: SlashCommandTarget, command: CommandId): string;
  copy(text: string): Promise<void>;
  information(message: string): Promise<void>;
  warning(message: string): Promise<void>;
  log(message: string): void;
  homeShort(filePath: string): string;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register and install everything in `rows` — the checklist selection — then
 * report. Already-current halves are left untouched; non-writable or failed
 * parts end on the clipboard instead of a dead end. One row's failure never
 * stops the next.
 */
export async function applySetup(rows: SetupRow[], deps: SetupDeps): Promise<void> {
  const written: { filePath: string; backup?: string }[] = [];
  const skippedLabels = new Set<string>();
  const manual: string[] = [];
  const failures: { filePath: string; message: string }[] = [];

  for (const row of rows) {
    if (row.consumer) {
      const consumer = row.consumer;
      if (consumer.status === 'current') {
        skippedLabels.add(consumer.label);
      } else if (!consumer.writable) {
        manual.push(deps.renderSnippet(consumer));
        deps.log(
          `Setup copied the diff-review MCP config for ${consumer.label} — ${deps.homeShort(consumer.configPath)} cannot be edited safely (${consumer.reason}).`,
        );
      } else {
        try {
          const { backup } = deps.registerConsumer(consumer);
          written.push({ filePath: consumer.configPath, backup });
          deps.log(
            `Setup registered the diff-review MCP server for ${consumer.label} at ${deps.homeShort(consumer.configPath)}` +
              (backup ? `. Previous config saved to ${deps.homeShort(backup)}.` : '.'),
          );
        } catch (error) {
          const message = failureMessage(error);
          failures.push({ filePath: consumer.configPath, message });
          deps.log(
            `Setup could not register the diff-review MCP server for ${consumer.label} at ${deps.homeShort(consumer.configPath)}: ${message}`,
          );
          manual.push(deps.renderSnippet(consumer));
        }
      }
    }

    if (row.commands) {
      const target = row.commands;
      const pending = target.files.filter((file) => file.status !== 'current');
      const writable = pending.filter((file) => file.writable);
      for (const file of pending) {
        if (file.writable) continue;
        manual.push(deps.renderClipboard(target, file.command));
        deps.log(
          `Setup copied ${file.invocation} for ${target.label} to the clipboard instead of writing ${deps.homeShort(file.filePath)} (${file.reason ?? 'not writable'}).`,
        );
      }

      if (pending.length === 0) {
        skippedLabels.add(target.label);
      } else if (writable.length > 0) {
        try {
          const outcome = deps.installCommands(target);
          for (const file of outcome.written) {
            written.push({ filePath: file.filePath, backup: file.backup });
            deps.log(
              `Setup installed a Diff Review command for ${target.label} at ${deps.homeShort(file.filePath)}` +
                (file.backup ? `. Previous version saved to ${deps.homeShort(file.backup)}.` : '.'),
            );
          }
          for (const error of outcome.errors) {
            failures.push({ filePath: error.filePath, message: error.message });
            deps.log(
              `Setup could not install a Diff Review command for ${target.label} at ${deps.homeShort(error.filePath)}: ${error.message}`,
            );
            manual.push(deps.renderClipboard(target, error.command));
          }
        } catch (error) {
          const message = failureMessage(error);
          failures.push({ filePath: target.dirPath, message });
          deps.log(`Setup could not install Diff Review commands for ${target.label}: ${message}`);
          for (const file of writable) manual.push(deps.renderClipboard(target, file.command));
        }
      }
    }
  }

  if (manual.length > 0) {
    await deps.copy(manual.join('\n\n'));
    await deps.information(
      `Diff Review: copied ${manual.length} item${manual.length === 1 ? '' : 's'} that setup could not write — paste ${manual.length === 1 ? 'it' : 'them'} where they belong.`,
    );
  }

  if (written.length > 0) {
    const backups = written.filter((entry) => entry.backup).map((entry) => deps.homeShort(entry.backup!));
    await deps.information(
      `Diff Review: setup wrote ${written.length} file${written.length === 1 ? '' : 's'}: ${written
        .map((entry) => deps.homeShort(entry.filePath))
        .join(', ')}.` + (backups.length > 0 ? ` Previous versions saved to ${backups.join(', ')}.` : ''),
    );
  } else if (skippedLabels.size > 0 && manual.length === 0 && failures.length === 0) {
    await deps.information(`Diff Review: ${[...skippedLabels].join(', ')} already set up — nothing to do.`);
  }

  if (failures.length > 0) {
    await deps.warning(
      `Diff Review: could not write ${failures.map((failure) => deps.homeShort(failure.filePath)).join(', ')} — ${failures
        .map((failure) => failure.message)
        .join('; ')}.`,
    );
  }
}

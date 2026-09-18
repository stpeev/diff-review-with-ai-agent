/**
 * Automatic refresh of setup components the user already installed.
 *
 * A Diff Review update moves the extension to a new versioned directory and
 * can ship newer command bodies, so an MCP consumer entry or agent command
 * file that was installed by a previous version is left pointing at the old
 * build. On activation we find those previously installed, now-out-of-date
 * components and rewrite them in place — no confirmation prompt, because the
 * user already said yes once. Everything the update does is logged.
 *
 * Automatic means updating, never installing. A `missing` entry (or a
 * command file the user deleted) is not an instruction to put it back; it is
 * left alone for the explicit setup command to offer.
 */
import type { McpConsumerTarget } from '../../mcp-consumers';
import type { InstallOutcome, SlashCommandTarget } from '../../slash-commands';

export interface ComponentAutoUpdateDeps {
  /** Every user-level MCP consumer on this machine. */
  discoverConsumers(): McpConsumerTarget[];
  /** Every agent slash-command directory on this machine. */
  discoverCommands(): SlashCommandTarget[];
  registerConsumer(target: McpConsumerTarget): { backup?: string };
  installCommands(target: SlashCommandTarget): InstallOutcome;
  homeShort(filePath: string): string;
  log(message: string): void;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The part of `target` an automatic update may rewrite: files that are still
 * ours (`stale` carries our marker) and writable. `install` writes every
 * writable non-current file it is given — including `missing` ones — so
 * handing it this narrowed target keeps a user-deleted command deleted.
 * `undefined` means there is nothing to update.
 */
export function staleCommandFiles(target: SlashCommandTarget): SlashCommandTarget | undefined {
  const files = target.files.filter((file) => file.status === 'stale' && file.writable);
  return files.length > 0 ? { ...target, files } : undefined;
}

/**
 * Refresh every stale-but-writable MCP registration and agent command file.
 * Failures are logged and skipped — one broken config must not stop the
 * rest, and nothing here blocks activation.
 */
export function autoUpdateInstalledComponents(deps: ComponentAutoUpdateDeps): void {
  for (const target of deps.discoverConsumers()) {
    if (target.status !== 'stale' || !target.writable) continue;
    try {
      const { backup } = deps.registerConsumer(target);
      deps.log(
        `Auto-updated the diff-review MCP registration for ${target.label} at ${deps.homeShort(target.configPath)}` +
          (target.current ? ` (was: ${target.current})` : '') +
          (backup ? `. Previous config saved to ${deps.homeShort(backup)}.` : '.'),
      );
    } catch (error) {
      deps.log(
        `Could not auto-update the diff-review MCP registration for ${target.label} at ${deps.homeShort(target.configPath)}: ${failureMessage(error)}`,
      );
    }
  }

  for (const target of deps.discoverCommands()) {
    const stale = staleCommandFiles(target);
    if (!stale) continue;
    try {
      const outcome = deps.installCommands(stale);
      for (const written of outcome.written) {
        deps.log(
          `Auto-updated the Diff Review command at ${deps.homeShort(written.filePath)} for ${target.label}` +
            (written.backup ? `. Previous version saved to ${deps.homeShort(written.backup)}.` : '.'),
        );
      }
      for (const error of outcome.errors) {
        deps.log(
          `Could not auto-update the Diff Review command at ${deps.homeShort(error.filePath)} for ${target.label}: ${error.message}`,
        );
      }
    } catch (error) {
      deps.log(`Could not auto-update Diff Review commands for ${target.label}: ${failureMessage(error)}`);
    }
  }
}

import type { CommandId, SlashCommandTarget } from '../../slash-commands';

export interface SlashCommandInstallationDeps {
  install(target: SlashCommandTarget): {
    written: { filePath: string; backup?: string }[];
    errors: { filePath: string; message: string; command: CommandId }[];
  };
  copyCommands(target: SlashCommandTarget): Promise<void>;
  copyCommand(target: SlashCommandTarget, command: CommandId): Promise<void>;
  confirm(message: string, detail: string): Promise<'Write' | 'Copy' | undefined>;
  information(message: string): Promise<void>;
  warning(message: string): Promise<void>;
  log(message: string): void;
  homeShort(filePath: string): string;
}

export async function installAgentSlashCommands(
  target: SlashCommandTarget,
  deps: SlashCommandInstallationDeps,
): Promise<void> {
  if (target.status === 'current') {
    await deps.information(`Diff Review: ${target.label} already has all Diff Review agent commands.`);
    return;
  }
  if (!target.writable) return deps.copyCommands(target);

  const skipped = target.files.filter((file) => !file.writable);
  const toWrite = target.files.filter((file) => file.writable && file.status !== 'current');
  const skippedNote = skipped.length
    ? `\n\nSkipping ${skipped.map((file) => file.invocation).join(', ')} — not written by Diff Review.`
    : '';
  const before = toWrite.some((file) => file.status === 'stale')
    ? '\n\nOverwriting an older version of what we wrote before.'
    : '';
  const answer = await deps.confirm(
    `Install ${toWrite.map((file) => file.invocation).join(' and ')} for ${target.label}?`,
    `${toWrite.map((file) => file.filePath).join('\n')}${before}${skippedNote}`,
  );
  if (answer === 'Copy') return deps.copyCommands(target);
  if (answer !== 'Write') return;

  const outcome = deps.install(target);
  if (outcome.written.length) {
    const backups = outcome.written.filter((written) => written.backup);
    await deps.information(
      `Diff Review: installed ${outcome.written.map((written) => written.filePath).join(', ')} for ${target.label}.` +
        (backups.length
          ? ` Previous version(s) saved to ${backups.map((written) => deps.homeShort(written.backup!)).join(', ')}.`
          : ''),
    );
  }
  if (outcome.errors.length) {
    deps.log(
      `installSlashCommands failed for ${target.id}: ${outcome.errors.map((error) => error.message).join('; ')}`,
    );
    await deps.warning(
      `Diff Review: could not write ${outcome.errors.map((error) => deps.homeShort(error.filePath)).join(', ')} (${outcome.errors.map((error) => error.message).join('; ')}). Copying those to the clipboard instead.`,
    );
    for (const failed of outcome.errors) await deps.copyCommand(target, failed.command);
  }
}

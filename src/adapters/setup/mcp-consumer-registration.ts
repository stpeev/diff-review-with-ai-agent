import type { McpConsumerTarget } from '../../mcp-consumers';

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

export interface McpConsumerRegistrationDeps {
  launcherFile: string;
  renderSnippet(target: McpConsumerTarget): string;
  snippetDestination(target: McpConsumerTarget): string;
  register(target: McpConsumerTarget): { backup?: string };
  copy(text: string): Promise<void>;
  information(message: string, action?: string): Promise<string | undefined>;
  confirm(message: string, detail: string): Promise<'Write' | 'Copy' | undefined>;
  warning(message: string): Promise<void>;
  log(message: string): void;
  homeShort(filePath: string): string;
  installAgentCommands(): void;
}

export async function copyConsumerSnippet(target: McpConsumerTarget, deps: McpConsumerRegistrationDeps): Promise<void> {
  const snippet = deps.renderSnippet(target);
  await deps.copy(snippet);
  await deps.information(`Diff Review: copied the ${target.label} config — ${deps.snippetDestination(target)}.`);
}

export async function registerMcpConsumer(target: McpConsumerTarget, deps: McpConsumerRegistrationDeps): Promise<void> {
  if (target.status === 'current') {
    await deps.information(`Diff Review: ${target.label} is already registered against the launcher.`);
    return;
  }
  if (!target.writable) return copyConsumerSnippet(target, deps);

  const before = target.status === 'stale' ? `Currently runs:\n  ${target.current}\n\n` : '';
  const answer = await deps.confirm(
    `${target.status === 'stale' ? 'Repair' : 'Register'} diff-review in ${target.label}?`,
    `${target.configPath}\n\n${before}Will run:\n  node ${deps.launcherFile}`,
  );
  if (answer === 'Copy') return copyConsumerSnippet(target, deps);
  if (answer !== 'Write') return;

  try {
    const { backup } = deps.register(target);
    const action = 'Install Agent Commands';
    const picked = await deps.information(
      `Diff Review: registered with ${target.label}.` +
        (backup ? ` Previous config saved to ${deps.homeShort(backup)}.` : ''),
      action,
    );
    if (picked === action) deps.installAgentCommands();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log(`[Diff Review] register failed for ${target.id}: ${detail}`);
    await copyConsumerSnippet(target, deps);
    await deps.warning(
      `Diff Review: could not write ${deps.homeShort(target.configPath)} (${detail}). The config is on your clipboard instead.`,
    );
  }
}

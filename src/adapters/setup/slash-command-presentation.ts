import type { SlashCommandTarget } from '../../slash-commands';

export function slashCommandRowIcon(target: SlashCommandTarget): string {
  if (target.files.some((file) => file.status === 'stale')) return '$(warning)';
  if (target.status === 'current') return '$(check)';
  if (target.status === 'missing' && target.files.every((file) => file.status === 'missing'))
    return '$(circle-outline)';
  return '$(warning)';
}

export function slashCommandRowLabel(target: SlashCommandTarget): string {
  const manual = target.writable ? '' : ' (manual)';
  if (target.files.some((file) => file.status === 'stale')) return `installed — older version${manual}`;
  if (target.status === 'current') return `installed${manual}`;
  const installedCount = target.files.filter((file) => file.status === 'current').length;
  if (installedCount > 0) return `${installedCount} of ${target.files.length} installed${manual}`;
  return `not installed${manual}`;
}

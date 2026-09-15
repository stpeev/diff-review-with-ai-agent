export interface SaveFailureState {
  consecutiveSaveFailures: number;
  lastSaveError: string;
}

export interface SaveFailureDecision extends SaveFailureState {
  retryDelayMs?: number;
  showWarning: boolean;
}

/** Decide retry and escalation after a scope save fails. */
export function afterSaveFailure(
  previousFailures: number | undefined,
  error: unknown,
  isShuttingDown: boolean,
  maxAutomaticRetries: number,
): SaveFailureDecision {
  const consecutiveSaveFailures = (previousFailures ?? 0) + 1;
  const lastSaveError = error instanceof Error ? error.message : String(error);
  return {
    consecutiveSaveFailures,
    lastSaveError,
    retryDelayMs:
      !isShuttingDown && consecutiveSaveFailures <= maxAutomaticRetries ? 250 * consecutiveSaveFailures : undefined,
    showWarning: consecutiveSaveFailures === 3,
  };
}

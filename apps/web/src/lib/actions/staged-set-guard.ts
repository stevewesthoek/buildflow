export type StagedSetGuardInput = {
  details?: { exactMatch?: boolean }
}

export type StagedSetGuardResult =
  | { pass: true }
  | { pass: false; reason: 'staged_path_set_mismatch' }

export function checkStagedSetGuard(addResult: StagedSetGuardInput): StagedSetGuardResult {
  if (addResult.details?.exactMatch === true) return { pass: true }
  return { pass: false, reason: 'staged_path_set_mismatch' }
}

export async function dispatchAfterExactStaging<T>(
  addResult: StagedSetGuardInput,
  dispatchCommit: () => Promise<T>
): Promise<
  | { pass: false; reason: 'staged_path_set_mismatch' }
  | { pass: true; result: T }
> {
  const guard = checkStagedSetGuard(addResult)
  if (!guard.pass) return guard
  return { pass: true, result: await dispatchCommit() }
}

import crypto from 'node:crypto'
import {
  acquireWorkbenchBudget,
  releaseWorkbenchBudget,
  type WorkbenchBudgetFailure,
  type WorkbenchBudgetOptions,
  type WorkbenchWorkerClass
} from './workbench-global-budget-store'
import {
  cancelRepositoryWork,
  claimRepositoryWork,
  completeRepositoryWork,
  enqueueRepositoryWork,
  type RepositoryScheduleClass,
  type RepositorySchedulerFailure,
  type RepositorySchedulerOptions
} from './workbench-repository-scheduler'
import {
  getWorkbenchSession,
  type WorkbenchSessionStoreFailure,
  type WorkbenchSessionStoreOptions
} from './workbench-session-store'

export type WorkbenchAdmissionOperation =
  | 'status'
  | 'approval'
  | 'read'
  | 'git'
  | 'install'
  | 'index'
  | 'write'
  | 'migration_execute'
  | 'destructive'

export type WorkbenchAdmissionClassification = {
  workerClass: WorkbenchWorkerClass
  repositoryClass?: RepositoryScheduleClass
}

export type WorkbenchAdmissionFailure = {
  ok: false
  code:
    | 'ADMISSION_INVALID_SESSION'
    | 'ADMISSION_SOURCE_NOT_OWNED'
    | 'ADMISSION_BUDGET_REJECTED'
    | 'ADMISSION_REPOSITORY_REJECTED'
    | 'ADMISSION_EXECUTION_FAILED'
  message: string
  cause?: WorkbenchBudgetFailure | RepositorySchedulerFailure | WorkbenchSessionStoreFailure
}

export type WorkbenchAdmissionOptions = {
  session?: WorkbenchSessionStoreOptions
  budget?: WorkbenchBudgetOptions
  repository?: RepositorySchedulerOptions
  workerId?: string
  leaseMs?: number
  now?: string
}

export function classifyWorkbenchAdmissionOperation(operation: WorkbenchAdmissionOperation): WorkbenchAdmissionClassification {
  switch (operation) {
    case 'status':
      return { workerClass: 'status' }
    case 'approval':
      return { workerClass: 'approval' }
    case 'read':
      return { workerClass: 'read', repositoryClass: 'read_shared' }
    case 'git':
    case 'install':
    case 'index':
    case 'write':
    case 'migration_execute':
    case 'destructive':
      return { workerClass: 'mutation', repositoryClass: 'mutation_exclusive' }
  }
}

function isSessionFailure(value: ReturnType<typeof getWorkbenchSession>): value is WorkbenchSessionStoreFailure {
  return !!value && 'ok' in value && value.ok === false
}

function isBudgetFailure<T extends { ok: boolean }>(value: T | WorkbenchBudgetFailure): value is WorkbenchBudgetFailure {
  return value.ok === false
}

function isRepositoryFailure<T extends { ok: boolean }>(value: T | RepositorySchedulerFailure): value is RepositorySchedulerFailure {
  return value.ok === false
}

export async function executeWithWorkbenchAdmission<T>(input: {
  requestId?: string
  sessionId: string
  sourceId: string
  operation: WorkbenchAdmissionOperation
  operationKind: string
  cost?: number
  execute: () => Promise<T> | T
}, options: WorkbenchAdmissionOptions = {}): Promise<{ ok: true; result: T } | WorkbenchAdmissionFailure> {
  const session = getWorkbenchSession(input.sessionId, options.session)
  if (!session || isSessionFailure(session) || session.status !== 'active') {
    return {
      ok: false,
      code: 'ADMISSION_INVALID_SESSION',
      message: 'An active Workbench session is required before admission.',
      ...(isSessionFailure(session) ? { cause: session } : {})
    }
  }
  if (!session.lockedSourceIds.includes(input.sourceId)) {
    return { ok: false, code: 'ADMISSION_SOURCE_NOT_OWNED', message: 'The session does not own the selected source.' }
  }

  const classification = classifyWorkbenchAdmissionOperation(input.operation)
  const requestId = input.requestId || `admission-${crypto.randomUUID()}`
  const budget = acquireWorkbenchBudget({
    requestId,
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    workerClass: classification.workerClass,
    cost: input.cost,
    leaseMs: options.leaseMs,
    now: options.now
  }, options.budget)
  if (isBudgetFailure(budget)) {
    return { ok: false, code: 'ADMISSION_BUDGET_REJECTED', message: budget.message, cause: budget }
  }

  let repositoryLease: { requestId: string; leaseProof: string } | undefined
  if (classification.repositoryClass) {
    const queued = enqueueRepositoryWork({
      requestId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      class: classification.repositoryClass,
      operationKind: input.operationKind,
      now: options.now
    }, options.repository)
    if (isRepositoryFailure(queued)) {
      releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, outcome: 'cancelled', now: options.now }, options.budget)
      return { ok: false, code: 'ADMISSION_REPOSITORY_REJECTED', message: queued.message, cause: queued }
    }
    const claimed = claimRepositoryWork({
      requestId,
      workerId: options.workerId || 'workbench-admission',
      leaseMs: options.leaseMs,
      now: options.now
    }, options.repository)
    if (isRepositoryFailure(claimed)) {
      cancelRepositoryWork({ requestId, now: options.now }, options.repository)
      releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, outcome: 'cancelled', now: options.now }, options.budget)
      return { ok: false, code: 'ADMISSION_REPOSITORY_REJECTED', message: claimed.message, cause: claimed }
    }
    repositoryLease = { requestId, leaseProof: claimed.leaseProof }
  }

  try {
    const result = await input.execute()
    if (repositoryLease) completeRepositoryWork({ requestId: repositoryLease.requestId, leaseProof: repositoryLease.leaseProof, now: options.now }, options.repository)
    releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, now: options.now }, options.budget)
    return { ok: true, result }
  } catch (error) {
    if (repositoryLease) cancelRepositoryWork({ requestId: repositoryLease.requestId, now: options.now }, options.repository)
    releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, outcome: 'cancelled', now: options.now }, options.budget)
    return { ok: false, code: 'ADMISSION_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
}

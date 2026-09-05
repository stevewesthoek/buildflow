import type { CapabilityJobHandler } from './capability-execution-coordinator.js'

export const SAFE_CAPABILITY_HANDLER_KINDS = ['immediate-success', 'bounded-delay', 'cancellable-delay', 'deterministic-failure'] as const
export type SafeCapabilityHandlerKind = typeof SAFE_CAPABILITY_HANDLER_KINDS[number]

function wait(ms: number, signal: AbortSignal): Promise<'completed' | 'cancelled'> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('cancelled'); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve('completed') }, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve('cancelled') }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function createSafeCapabilityHandler(kind: SafeCapabilityHandlerKind, options: { delayMs?: number; failureCode?: string; output?: unknown } = {}): CapabilityJobHandler {
  const delayMs = Math.max(1, Math.min(Math.trunc(options.delayMs ?? 25), 2_000))
  if (kind === 'immediate-success') return async ({ reportStep }) => { reportStep('deterministic-success'); return { status: 'succeeded', output: options.output ?? { handler: kind, sideEffects: 'none' } } }
  if (kind === 'deterministic-failure') return async ({ reportStep }) => { reportStep('deterministic-failure'); return { status: 'failed', failure: { code: options.failureCode ?? 'deterministic_failure', message: 'The configured deterministic failure handler returned a bounded failure.', retryable: false } } }
  return async ({ signal, reportStep }) => {
    reportStep(kind === 'cancellable-delay' ? 'waiting-cancellable' : 'waiting-bounded')
    const result = await wait(delayMs, signal)
    if (result === 'cancelled') return { status: 'cancelled', failure: { code: 'cancelled', message: 'The bounded handler observed cancellation.', retryable: false } }
    return { status: 'succeeded', output: options.output ?? { handler: kind, delayMs, sideEffects: 'none' } }
  }
}

import type { DelegationEvidenceSummary, ExternalDelegationOperation } from './external-delegation'
import { manualDelegationFallback, projectDelegationStatus, validateDelegationEvidence } from './external-delegation'

export type DelegationAdapterCapability = {
  supported: boolean
  reasonCode: 'preview_only' | 'unsupported_executor' | 'network_transport_unavailable' | 'authorization_unavailable'
  manualFallback: true
  nextAction: string
}

export type DelegationAdapterPreview<T> = {
  performed: false
  capability: DelegationAdapterCapability
  preview?: T
}

export interface ExternalDelegationAdapter {
  capability(operation: ExternalDelegationOperation): DelegationAdapterCapability
  prepare(operation: ExternalDelegationOperation): DelegationAdapterPreview<ReturnType<typeof projectDelegationStatus>>
  submitPreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; lifecycle: string; idempotencyKey: string }>
  statusReadback(operation: ExternalDelegationOperation): DelegationAdapterPreview<ReturnType<typeof projectDelegationStatus>>
  cancelPreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; cancellation: 'requested' }>
  evidencePreview(operation: ExternalDelegationOperation, evidence: DelegationEvidenceSummary): DelegationAdapterPreview<DelegationEvidenceSummary>
  reconcilePreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; reconciliation: string }>
}

function capability(reasonCode: DelegationAdapterCapability['reasonCode'] = 'preview_only'): DelegationAdapterCapability {
  const fallback = manualDelegationFallback('manual_fallback_required')
  return {
    supported: false,
    reasonCode,
    manualFallback: true,
    nextAction: fallback.nextAction
  }
}

export function createPreviewOnlyDelegationAdapter(): ExternalDelegationAdapter {
  return {
    capability: operation => capability(operation.executor.engine === 'codex' || operation.executor.engine === 'future_adapter' || operation.executor.engine === 'human' ? 'preview_only' : 'unsupported_executor'),
    prepare: operation => ({ performed: false, capability: capability(), preview: projectDelegationStatus(operation) }),
    submitPreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, lifecycle: operation.lifecycle, idempotencyKey: operation.compiledIdempotencyKey } }),
    statusReadback: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: projectDelegationStatus(operation) }),
    cancelPreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, cancellation: 'requested' } }),
    evidencePreview: (operation, evidence) => {
      const validated = validateDelegationEvidence(operation, evidence)
      return validated.ok
        ? { performed: false, capability: capability('network_transport_unavailable'), preview: validated.evidence }
        : { performed: false, capability: capability('network_transport_unavailable') }
    },
    reconcilePreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, reconciliation: operation.reconciliation } })
  }
}

import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  normalizeWorkbenchErrorCode,
  isLegacyBuildFlowErrorCode,
  getCanonicalErrorCode
} from '@/lib/actions/error-code-compat'

describe('error-code-compat', () => {
  describe('normalizeWorkbenchErrorCode', () => {
    it('normalizes legacy BUILDFLOW_ACTION_DEADLINE_EXCEEDED to canonical', () => {
      const result = normalizeWorkbenchErrorCode('BUILDFLOW_ACTION_DEADLINE_EXCEEDED')
      assert.equal(result, 'WORKBENCH_ACTION_DEADLINE_EXCEEDED')
    })

    it('normalizes legacy BUILDFLOW_NEEDS_NARROWER_SCOPE to canonical', () => {
      const result = normalizeWorkbenchErrorCode('BUILDFLOW_NEEDS_NARROWER_SCOPE')
      assert.equal(result, 'WORKBENCH_NEEDS_NARROWER_SCOPE')
    })

    it('normalizes legacy BUILDFLOW_RESPONSE_SIZE_EXCEEDED to canonical', () => {
      const result = normalizeWorkbenchErrorCode('BUILDFLOW_RESPONSE_SIZE_EXCEEDED')
      assert.equal(result, 'WORKBENCH_RESPONSE_SIZE_EXCEEDED')
    })

    it('normalizes legacy BUILDFLOW_COMMAND_TIMEOUT to canonical', () => {
      const result = normalizeWorkbenchErrorCode('BUILDFLOW_COMMAND_TIMEOUT')
      assert.equal(result, 'WORKBENCH_COMMAND_TIMEOUT')
    })

    it('normalizes legacy BUILDFLOW_STATUS_ERROR to canonical', () => {
      const result = normalizeWorkbenchErrorCode('BUILDFLOW_STATUS_ERROR')
      assert.equal(result, 'WORKBENCH_STATUS_ERROR')
    })

    it('passes through canonical codes unchanged', () => {
      assert.equal(normalizeWorkbenchErrorCode('WORKBENCH_ACTION_DEADLINE_EXCEEDED'), 'WORKBENCH_ACTION_DEADLINE_EXCEEDED')
      assert.equal(normalizeWorkbenchErrorCode('WORKBENCH_NEEDS_NARROWER_SCOPE'), 'WORKBENCH_NEEDS_NARROWER_SCOPE')
    })

    it('does not normalize unknown codes', () => {
      const unknownCode = 'SOME_UNKNOWN_ERROR'
      assert.equal(normalizeWorkbenchErrorCode(unknownCode), unknownCode)
    })

    it('does not normalize unrelated BUILDFLOW codes', () => {
      const unrelatedCode = 'BUILDFLOW_SOME_OTHER_ERROR'
      assert.equal(normalizeWorkbenchErrorCode(unrelatedCode), unrelatedCode)
    })
  })

  describe('isLegacyBuildFlowErrorCode', () => {
    it('returns true for legacy BUILDFLOW_ACTION_DEADLINE_EXCEEDED', () => {
      assert.equal(isLegacyBuildFlowErrorCode('BUILDFLOW_ACTION_DEADLINE_EXCEEDED'), true)
    })

    it('returns true for legacy BUILDFLOW_NEEDS_NARROWER_SCOPE', () => {
      assert.equal(isLegacyBuildFlowErrorCode('BUILDFLOW_NEEDS_NARROWER_SCOPE'), true)
    })

    it('returns false for canonical codes', () => {
      assert.equal(isLegacyBuildFlowErrorCode('WORKBENCH_ACTION_DEADLINE_EXCEEDED'), false)
    })

    it('returns false for unknown codes', () => {
      assert.equal(isLegacyBuildFlowErrorCode('UNKNOWN_CODE'), false)
    })
  })

  describe('getCanonicalErrorCode', () => {
    it('returns canonical form of legacy code', () => {
      assert.equal(getCanonicalErrorCode('BUILDFLOW_ACTION_DEADLINE_EXCEEDED'), 'WORKBENCH_ACTION_DEADLINE_EXCEEDED')
    })

    it('returns canonical codes unchanged', () => {
      assert.equal(getCanonicalErrorCode('WORKBENCH_ACTION_DEADLINE_EXCEEDED'), 'WORKBENCH_ACTION_DEADLINE_EXCEEDED')
    })

    it('returns unknown codes unchanged', () => {
      assert.equal(getCanonicalErrorCode('UNKNOWN'), 'UNKNOWN')
    })
  })
})

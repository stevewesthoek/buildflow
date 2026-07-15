import assert from 'node:assert/strict'
import {
  CONTROLLED_N8N_WRAPPER_CONTRACT_V1,
  parseControlledN8nWrapperContract
} from '../packages/shared/src/controlled-n8n-wrapper-contract'

const valid = () => JSON.parse(JSON.stringify(CONTROLLED_N8N_WRAPPER_CONTRACT_V1))
const reject = (label: string, mutate: (contract: any) => void) => {
  const contract = valid()
  mutate(contract)
  assert.equal(parseControlledN8nWrapperContract(contract).ok, false, label)
}

assert.equal(parseControlledN8nWrapperContract(valid()).ok, true)
reject('unknown root field', value => { value.executable = 'anything' })
reject('unknown nested field', value => { value.mutation.environment = {} })
reject('invalid version', value => { value.schemaVersion = 2 })
reject('altered read operation', value => { value.read.operation = 'request' })
reject('altered mutation operation', value => { value.mutation.operation = 'create-workflow' })
reject('altered argv', value => { value.mutation.argvTemplate[2] = 'file.json' })
reject('file transport', value => { value.mutation.payloadTransport = 'file' })
reject('payload limit', value => { value.limits.maximumPayloadBytes = 500001 })
reject('redirects enabled', value => { value.policy.followsRedirects = true })
reject('retries', value => { value.policy.automaticRetries = 1 })
reject('multiple requests', value => { value.policy.maximumMutationRequestsPerInvocation = 2 })
reject('no readback', value => { value.policy.requiresReadbackAfterMutation = false })
reject('duplicate safety', value => { value.policy.duplicateInvocationsAreIntrinsicallySafe = true })
reject('no replay protection', value => { value.policy.requiresExternalReplayProtection = false })
reject('arbitrary environment', value => { value.policy.env = { PATH: '/x' } })
reject('installation identity', value => { value.sourceId = 'brain' })

console.log('controlled n8n wrapper contract verification passed')

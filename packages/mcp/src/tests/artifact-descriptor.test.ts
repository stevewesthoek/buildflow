import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKBENCH_ARTIFACT_DESCRIPTOR_JSON_SCHEMA,
  WORKBENCH_ARTIFACT_DESCRIPTOR_KIND,
  WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION,
  assertDescriptorHasNoAuthority,
  classifyWorkbenchArtifactAvailability,
  createWorkbenchArtifactDescriptor,
  parseWorkbenchArtifactDescriptor,
  validateWorkbenchArtifactDescriptor
} from '../artifact-descriptor.js'

const descriptor = createWorkbenchArtifactDescriptor({
  artifactId: 'artifact:example-1',
  sourceType: 'provider_file',
  artifactType: 'file',
  filename: 'example.pdf',
  mimeType: 'application/pdf',
  byteSize: 42,
  fileCount: 1,
  originalReference: 'provider:item-1',
  sha256: 'a'.repeat(64),
  freshness: {
    createdAt: '2026-08-21T12:00:00.000Z',
    expiresAt: '2026-08-21T13:00:00.000Z'
  },
  adapterTransportReference: 'adapter-ref:item-1'
})

test('creates strict source-neutral discovery metadata', () => {
  assert.equal(descriptor.descriptorVersion, WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION)
  assert.equal(descriptor.kind, WORKBENCH_ARTIFACT_DESCRIPTOR_KIND)
  assert.equal(validateWorkbenchArtifactDescriptor(descriptor), true)
  assert.deepEqual(parseWorkbenchArtifactDescriptor(JSON.parse(JSON.stringify(descriptor))), descriptor)
  assert.doesNotThrow(() => assertDescriptorHasNoAuthority(descriptor))
})

test('rejects authority and filesystem fields instead of interpreting them', () => {
  for (const field of ['mount', 'read', 'write', 'path', 'grantId']) {
    const widened = { ...descriptor, [field]: field === 'path' ? '/protected/file' : true }
    assert.equal(validateWorkbenchArtifactDescriptor(widened), false)
    assert.throws(() => assertDescriptorHasNoAuthority(widened), /additional properties/)
  }
})

test('rejects malformed hashes, timestamps, counts, and unknown source types', () => {
  assert.throws(() => parseWorkbenchArtifactDescriptor({ ...descriptor, sha256: 'ABC' }), /sha256/)
  assert.throws(() => parseWorkbenchArtifactDescriptor({
    ...descriptor,
    freshness: { createdAt: '2026-08-21', expiresAt: '2026-08-20T12:00:00.000Z' }
  }), /canonical ISO-8601/)
  assert.throws(() => parseWorkbenchArtifactDescriptor({ ...descriptor, fileCount: 2 }), /fileCount 1/)
  assert.throws(() => parseWorkbenchArtifactDescriptor({ ...descriptor, sourceType: 'brain_file' }), /sourceType/)
})

test('classifies expiry and provider removal without granting access', () => {
  assert.equal(classifyWorkbenchArtifactAvailability(descriptor, {
    now: '2026-08-21T12:59:59.999Z',
    providerAvailable: true
  }), 'available')
  assert.equal(classifyWorkbenchArtifactAvailability(descriptor, {
    now: '2026-08-21T13:00:00.000Z',
    providerAvailable: true
  }), 'expired')
  assert.equal(classifyWorkbenchArtifactAvailability(descriptor, {
    now: '2026-08-21T12:30:00.000Z',
    providerAvailable: false
  }), 'provider_removed')
})

test('exports a JSON-serializable strict descriptor schema', () => {
  const schema = JSON.parse(JSON.stringify(WORKBENCH_ARTIFACT_DESCRIPTOR_JSON_SCHEMA))
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['descriptorVersion', 'kind', 'artifactId', 'sourceType', 'artifactType'])
  assert.equal(schema.properties.freshness.additionalProperties, false)
  assert.equal('path' in schema.properties, false)
  assert.equal('authority' in schema.properties, false)
})

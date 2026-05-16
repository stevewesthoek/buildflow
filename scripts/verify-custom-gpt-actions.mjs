#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const LOCAL_BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const TOKEN = process.env.BUILDFLOW_ACTION_TOKEN || ''
const ROOT = process.cwd()
const DOCS_SCHEMA_FILE = path.join(ROOT, 'docs/openapi.chatgpt.json')
const INSTRUCTIONS_FILE = path.join(ROOT, 'docs/CUSTOM_GPT_INSTRUCTIONS.md')
const DOCS_SCHEMA_DIR = path.join(ROOT, 'docs/openapi.chatgpt')
const EXPECTED_OPERATION_IDS = [
  'getBuildFlowStatus',
  'listBuildFlowSources',
  'getBuildFlowActiveContext',
  'setBuildFlowActiveContext',
  'inspectBuildFlowContext',
  'readBuildFlowContext',
  'runBuildFlowCommand',
  'startBuildFlowAgentJob',
  'getBuildFlowAgentJob',
  'writeBuildFlowArtifact',
  'applyBuildFlowFileChange'
]
const LEGACY_NAMES = [
  'setBuildFlowContext',
  'action=list_sources',
  'action=get_active',
  'action=set_active'
]

if (!TOKEN) {
  console.error('BUILDFLOW_ACTION_TOKEN is required')
  process.exit(1)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseJsonSafe(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON from ${label}: ${error instanceof Error ? error.message : String(error)}\n${text.slice(0, 500)}`)
  }
}

async function requestRaw(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(options.headers || {})
      }
    })
    const text = await response.text()
    return {
      response,
      text,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get('content-type') || ''
    }
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(url, options = {}, timeoutMs = 45000) {
  const result = await requestRaw(url, options, timeoutMs)
  assert(result.contentType.includes('application/json'), `Expected JSON from ${url}, got ${result.response.status} ${result.contentType}\n${result.text.slice(0, 500)}`)
  const json = parseJsonSafe(result.text, url)
  return { ...result, json, byteLength: Buffer.byteLength(result.text, 'utf8') }
}

function loadDocsSchema() {
  assert(fs.existsSync(DOCS_SCHEMA_FILE), `Missing docs schema file: ${DOCS_SCHEMA_FILE}`)
  return JSON.parse(fs.readFileSync(DOCS_SCHEMA_FILE, 'utf8'))
}

function loadInstructions() {
  assert(fs.existsSync(INSTRUCTIONS_FILE), `Missing instructions file: ${INSTRUCTIONS_FILE}`)
  return fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')
}

function ensureNoStaleFragments() {
  assert(fs.existsSync(DOCS_SCHEMA_DIR), `Missing docs schema directory: ${DOCS_SCHEMA_DIR}`)
  const entries = fs.readdirSync(DOCS_SCHEMA_DIR)
  const staleFragments = entries.filter(entry => entry.endsWith('.json'))
  assert(staleFragments.length === 0, `Stale schema fragments found: ${staleFragments.join(', ')}`)
}

function collectOperations(schema) {
  const ops = []
  for (const [routePath, pathItem] of Object.entries(schema.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem?.[method]
      if (op && typeof op === 'object') {
        ops.push({ routePath, method, ...op })
      }
    }
  }
  return ops
}

function resolveSchemaRef(schema, node) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return node
  const prefix = '#/components/schemas/'
  if (!node.$ref.startsWith(prefix)) return node
  return schema.components?.schemas?.[node.$ref.slice(prefix.length)] || node
}

function responseSchema(schema, pathName) {
  return resolveSchemaRef(schema, schema.paths?.[pathName]?.post?.responses?.['200']?.content?.['application/json']?.schema || schema.paths?.[pathName]?.get?.responses?.['200']?.content?.['application/json']?.schema || {})
}

function ensureHasActivity(schema, pathName, label) {
  const resolved = responseSchema(schema, pathName)
  assert(Object.prototype.hasOwnProperty.call(resolved.properties || {}, 'activity'), `${label} response must expose activity`)
}

function ensureSchemaRules(schema) {
  const ops = collectOperations(schema)
  const ids = ops.map(op => op.operationId)
  assert(ids.length === EXPECTED_OPERATION_IDS.length, `Expected ${EXPECTED_OPERATION_IDS.length} operations, found ${ids.length}`)
  assert(new Set(ids).size === ids.length, 'OperationIds must be unique')
  assert(JSON.stringify([...EXPECTED_OPERATION_IDS].sort()) === JSON.stringify([...ids].sort()), `OperationIds mismatch: ${ids.join(', ')}`)

  const schemaText = JSON.stringify(schema)
  assert(Buffer.byteLength(schemaText, 'utf8') < 100000, 'OpenAPI schema exceeds 100000 characters')

  for (const legacy of LEGACY_NAMES) {
    assert(!schemaText.includes(legacy), `Legacy reference exposed in schema: ${legacy}`)
  }
  assert(!Object.prototype.hasOwnProperty.call(schema.paths || {}, '/api/actions/context'), 'Legacy /api/actions/context path must not be exposed')

  for (const op of ops) {
    assert(Array.isArray(op.security) && op.security.length > 0, `${op.operationId} missing security`)
    assert(Object.prototype.hasOwnProperty.call(op, 'x-openai-isConsequential'), `${op.operationId} missing x-openai-isConsequential`)
    assert(typeof op.summary === 'string' && op.summary.length > 0 && op.summary.length <= 300, `${op.operationId} summary invalid`)
    assert(typeof op.description === 'string' && op.description.length > 0 && op.description.length <= 300, `${op.operationId} description invalid`)
    const requestSchema = op.requestBody?.content?.['application/json']?.schema
    if (requestSchema) {
      visitDescriptions(requestSchema, (value, location) => {
        assert(value.length <= 700, `${op.operationId} description too long at ${location}`)
      })
    }
  }

  const writeArtifactSchema = schema.paths?.['/api/actions/write-artifact']?.post?.requestBody?.content?.['application/json']?.schema?.properties || {}
  const applyChangeSchema = schema.paths?.['/api/actions/apply-file-change']?.post?.requestBody?.content?.['application/json']?.schema?.properties || {}
  assert(Object.prototype.hasOwnProperty.call(writeArtifactSchema, 'dryRun'), 'writeBuildFlowArtifact must accept dryRun')
  assert(Object.prototype.hasOwnProperty.call(writeArtifactSchema, 'preflight'), 'writeBuildFlowArtifact must accept preflight')
  assert(Object.prototype.hasOwnProperty.call(applyChangeSchema, 'dryRun'), 'applyBuildFlowFileChange must accept dryRun')
  assert(Object.prototype.hasOwnProperty.call(applyChangeSchema, 'preflight'), 'applyBuildFlowFileChange must accept preflight')
  for (const key of ['delete_file', 'delete_directory', 'move', 'rename', 'mkdir', 'rmdir']) {
    assert((applyChangeSchema.changeType?.enum || []).includes(key), `applyBuildFlowFileChange must accept ${key}`)
  }
  for (const key of ['from', 'to', 'recursive', 'onlyIfEmpty', 'overwrite', 'createParents', 'createParentDirectories', 'confirmedByUser', 'confirmationToken']) {
    assert(Object.prototype.hasOwnProperty.call(applyChangeSchema, key), `applyBuildFlowFileChange must accept ${key}`)
  }

  ensureHasActivity(schema, '/api/actions/status', 'status')
  ensureHasActivity(schema, '/api/actions/sources', 'sources')
  ensureHasActivity(schema, '/api/actions/context/active', 'active context')
  ensureHasActivity(schema, '/api/actions/read-context', 'read-context')
  ensureHasActivity(schema, '/api/actions/inspect', 'inspect')
  ensureHasActivity(schema, '/api/actions/run-command', 'run-command')
  ensureHasActivity(schema, '/api/actions/agent/start', 'agent-start')
  ensureHasActivity(schema, '/api/actions/agent/status', 'agent-status')
  ensureHasActivity(schema, '/api/actions/write-artifact', 'write-artifact')
  ensureHasActivity(schema, '/api/actions/apply-file-change', 'apply-file-change')
}

function ensureConsequentialFlags(schema) {
  const expectedFlags = new Map([
    ['getBuildFlowStatus', false],
    ['listBuildFlowSources', false],
    ['getBuildFlowActiveContext', false],
    ['inspectBuildFlowContext', false],
    ['readBuildFlowContext', false],
    ['runBuildFlowCommand', false],
    ['getBuildFlowAgentJob', false],
    ['setBuildFlowActiveContext', true],
    ['startBuildFlowAgentJob', true],
    ['writeBuildFlowArtifact', false],
    ['applyBuildFlowFileChange', false]
  ])
  for (const op of collectOperations(schema)) {
    assert(op['x-openai-isConsequential'] === expectedFlags.get(op.operationId), `${op.operationId} consequential flag mismatch`)
  }
}

function assertActivity(activity, operationId, phase, labelContains) {
  assert(activity && typeof activity === 'object', `${operationId}: activity missing`)
  assert(activity.operationId === operationId, `${operationId}: activity.operationId mismatch`)
  assert(activity.phase === phase, `${operationId}: activity.phase mismatch`)
  assert(typeof activity.actionLabel === 'string' && activity.actionLabel.includes(labelContains), `${operationId}: activity.actionLabel mismatch`)
  assert(typeof activity.userMessage === 'string' && activity.userMessage.length > 0, `${operationId}: activity.userMessage missing`)
  assert(typeof activity.riskLevel === 'string', `${operationId}: activity.riskLevel missing`)
  assert(typeof activity.requiresConfirmation === 'boolean', `${operationId}: activity.requiresConfirmation missing`)
  assert(typeof activity.verified === 'boolean', `${operationId}: activity.verified missing`)
}

function ensureInstructionAlignment(instructions) {
  assert(instructions.includes('BuildFlow narration and activity feedback'), 'Instructions must mention BuildFlow narration and activity feedback')
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert(instructions.includes(operationId), `Instructions must mention ${operationId}`)
  }
  for (const legacy of LEGACY_NAMES) {
    assert(!instructions.includes(legacy), `Legacy instruction reference exposed: ${legacy}`)
  }
  assert(instructions.includes('verified:true'), 'Instructions must mention verified:true')
  assert(instructions.includes('single enabled searchable source'), 'Instructions must mention single-source preference')
  assert(instructions.includes('repo_app_maintainer'), 'Instructions must mention repo_app_maintainer')
  assert(!instructions.includes('/api/actions/context'), 'Instructions must not reference hidden/internal context endpoints')
}

function visitDescriptions(node, fn, location = 'schema') {
  if (!node || typeof node !== 'object') return
  if (typeof node.description === 'string') fn(node.description, location)
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, value] of Object.entries(node.properties)) {
      visitDescriptions(value, fn, `${location}.${key}`)
    }
  }
  if (node.items) visitDescriptions(node.items, fn, `${location}[]`)
  if (Array.isArray(node.allOf)) node.allOf.forEach((item, index) => visitDescriptions(item, fn, `${location}.allOf[${index}]`))
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((item, index) => visitDescriptions(item, fn, `${location}.anyOf[${index}]`))
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((item, index) => visitDescriptions(item, fn, `${location}.oneOf[${index}]`))
}

async function fetchSchema(baseUrl) {
  const result = await requestJson(`${baseUrl}/api/openapi`, {}, 15000)
  return result.json
}

function regenerateDocsSchema() {
  const before = fs.existsSync(DOCS_SCHEMA_FILE) ? fs.readFileSync(DOCS_SCHEMA_FILE, 'utf8') : null
  execFileSync('node', ['scripts/generate-openapi-chatgpt.mjs'], { cwd: ROOT, stdio: 'pipe', env: process.env })
  const after = fs.readFileSync(DOCS_SCHEMA_FILE, 'utf8')
  if (before !== after) {
    if (before !== null) {
      fs.writeFileSync(DOCS_SCHEMA_FILE, before)
    } else {
      fs.unlinkSync(DOCS_SCHEMA_FILE)
    }
    throw new Error('docs/openapi.chatgpt.json was stale. Regenerate it before importing.')
  }
}

async function runActionSuite(baseUrl, label) {
  const startedAt = Date.now()
  const steps = []
  const runStep = async (name, fn) => {
    const stepStartedAt = Date.now()
    try {
      const result = await fn()
      const step = {
        name,
        ok: true,
        status: result.response.status,
        durationMs: Date.now() - stepStartedAt,
        byteLength: result.byteLength,
        json: result.json
      }
      steps.push(step)
      return result
    } catch (error) {
      const step = {
        name,
        ok: false,
        durationMs: Date.now() - stepStartedAt,
        error: error instanceof Error ? error.message : String(error)
      }
      steps.push(step)
      throw error
    }
  }

  const status = await runStep('getBuildFlowStatus', () => requestJson(`${baseUrl}/api/actions/status`, { method: 'GET' }))
  assert(status.response.status === 200, `${label}: status must return 200`)
  assert(status.json.connected === true || status.json.connected === false, `${label}: status connected missing`)
  assertActivity(status.json.activity, 'getBuildFlowStatus', 'completed', 'Checked BuildFlow connection')

  const sources = await runStep('listBuildFlowSources', () => requestJson(`${baseUrl}/api/actions/sources`, { method: 'GET' }))
  assert(sources.response.status === 200, `${label}: sources must return 200`)
  assert(Array.isArray(sources.json.sources), `${label}: sources missing`)
  assert(sources.json.sources.every(source => typeof source.indexStatus === 'string' && typeof source.searchable === 'boolean'), `${label}: sources readiness fields missing`)
  assertActivity(sources.json.activity, 'listBuildFlowSources', 'completed', 'Listed connected sources')

  const buildflowSource = sources.json.sources.find(source => source.id === 'buildflow')
  assert(buildflowSource, `${label}: buildflow source unavailable`)
  if (buildflowSource.indexStatus !== 'ready' || buildflowSource.searchable !== true) {
    await runStep('reindex buildflow source', async () => {
      const result = await requestJson(`${baseUrl}/api/agent/sources/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: 'buildflow' })
      }, 45000)
      assert([200, 202].includes(result.response.status), `${label}: reindex should return 200 or 202`)
      return result
    })

    await runStep('wait for buildflow ready', async () => {
      const ready = await waitForSourceReady(baseUrl, 'buildflow', 120000)
      assert(ready, `${label}: buildflow did not become ready`)
      return ready
    })
  }

  const active = await runStep('getBuildFlowActiveContext', () => requestJson(`${baseUrl}/api/actions/context/active`, { method: 'GET' }))
  assert(active.response.status === 200, `${label}: active context must return 200`)
  assert(Array.isArray(active.json.activeSourceIds), `${label}: activeSourceIds missing`)
  assertActivity(active.json.activity, 'getBuildFlowActiveContext', 'completed', 'Checked active source context')

  await runStep('setBuildFlowActiveContext missing contextMode', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceIds: ['buildflow'] })
    })
    assert(result.response.status === 400, `${label}: missing contextMode should fail`)
    return result
  })

  await runStep('setBuildFlowActiveContext missing sourceIds', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'single' })
    })
    assert(result.response.status === 400, `${label}: missing sourceIds should fail`)
    return result
  })

  await runStep('setBuildFlowActiveContext reject all', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'all', sourceIds: ['buildflow'] })
    })
    assert(result.response.status === 400, `${label}: contextMode=all should fail`)
    return result
  })

  await runStep('setBuildFlowActiveContext reject single zero', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'single', sourceIds: [] })
    })
    assert(result.response.status === 400, `${label}: single with 0 ids should fail`)
    return result
  })

  await runStep('setBuildFlowActiveContext reject single two', async () => {
    const second = sources.json.sources.find(source => source.id !== 'buildflow')?.id || '__other__'
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'single', sourceIds: ['buildflow', second] })
    })
    assert(result.response.status === 400, `${label}: single with 2 ids should fail`)
    return result
  })

  await runStep('setBuildFlowActiveContext reject unknown', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'single', sourceIds: ['__missing_source__'] })
    })
    assert(result.response.status === 400, `${label}: unknown source should fail`)
    return result
  })

  const disabledSource = sources.json.sources.find(source => source.enabled === false)
  assert(disabledSource, `${label}: no disabled source available to verify rejection`)
  await runStep('setBuildFlowActiveContext reject disabled', async () => {
    const result = await requestJson(`${baseUrl}/api/actions/context/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextMode: 'single', sourceIds: [disabledSource.id] })
    })
    assert(result.response.status === 400, `${label}: disabled source should fail`)
    return result
  })

  const setSingle = await runStep('setBuildFlowActiveContext single buildflow', () => requestJson(`${baseUrl}/api/actions/context/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextMode: 'single', sourceIds: ['buildflow'] })
  }))
  assert(setSingle.response.status === 200, `${label}: set active single should return 200`)
  assert(setSingle.json.contextMode === 'single', `${label}: single contextMode mismatch`)
  assert(Array.isArray(setSingle.json.activeSourceIds) && setSingle.json.activeSourceIds.length === 1, `${label}: single active ids mismatch`)
  assertActivity(setSingle.json.activity, 'setBuildFlowActiveContext', 'completed', 'Updated active source context')

  const inspectList = await runStep('inspectBuildFlowContext list_files', () => requestJson(`${baseUrl}/api/actions/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'list_files', sourceId: 'buildflow', path: '', depth: 1, limit: 10 })
  }))
  assert(inspectList.response.status === 200, `${label}: inspect list_files must return 200`)
  assert(Array.isArray(inspectList.json.entries) || Array.isArray(inspectList.json.results), `${label}: inspect list_files payload missing`)
  assertActivity(inspectList.json.activity, 'inspectBuildFlowContext', 'completed', 'Inspected repository structure')

  const inspectSearch = await runStep('inspectBuildFlowContext search', () => requestJson(`${baseUrl}/api/actions/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'search', sourceId: 'buildflow', query: 'package.json', limit: 5 })
  }))
  assert(inspectSearch.response.status === 200, `${label}: inspect search must return 200`)
  assert(Array.isArray(inspectSearch.json.results), `${label}: inspect search results missing`)
  assertActivity(inspectSearch.json.activity, 'inspectBuildFlowContext', 'completed', 'Searched connected source')

  const readPaths = await runStep('readBuildFlowContext read_paths', () => requestJson(`${baseUrl}/api/actions/read-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'read_paths', sourceId: 'buildflow', paths: ['package.json'], maxBytesPerFile: 5000 })
  }))
  assert(readPaths.response.status === 200, `${label}: read_paths must return 200`)
  assert(Array.isArray(readPaths.json.files), `${label}: read_paths files missing`)
  assertActivity(readPaths.json.activity, 'readBuildFlowContext', 'completed', 'Read repo files')

  const searchAndRead = await runStep('readBuildFlowContext search_and_read', () => requestJson(`${baseUrl}/api/actions/read-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'search_and_read', sourceId: 'buildflow', query: 'package.json', limit: 3, maxBytesPerFile: 5000 })
  }))
  assert(searchAndRead.response.status === 200, `${label}: search_and_read must return 200`)
  assert(Array.isArray(searchAndRead.json.results), `${label}: search_and_read results missing`)
  assertActivity(searchAndRead.json.activity, 'readBuildFlowContext', 'completed', 'Read repo files')

  const dryRunArtifactTitle = `GPT contract dry-run ${label} ${Date.now()}`
  const dryRunArtifact = await runStep('writeBuildFlowArtifact dryRun', () => requestJson(`${baseUrl}/api/actions/write-artifact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId: 'buildflow',
      artifactType: 'general_doc',
      title: dryRunArtifactTitle,
      content: `Dry-run artifact test for ${label}.`,
      folder: '.buildflow',
      filename: `dryrun-${label.toLowerCase()}-${Date.now()}.md`,
      dryRun: true
    })
  }))
  assert(dryRunArtifact.response.status === 200, `${label}: dry-run artifact must return 200`)
  assert(dryRunArtifact.json.verified === false, `${label}: dry-run artifact must not verify`)
  assert(dryRunArtifact.json.allowed === true || dryRunArtifact.json.status === 'allowed', `${label}: dry-run artifact must be allowed`)
  assertActivity(dryRunArtifact.json.activity, 'writeBuildFlowArtifact', 'preflight', 'Preflighted repo artifact')

  const dryRunArtifactBlocked = await runStep('writeBuildFlowArtifact dryRun blocked content', () => requestJson(`${baseUrl}/api/actions/write-artifact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId: 'buildflow',
      artifactType: 'general_doc',
      title: `Blocked Secret Pattern Artifact Demo ${label} ${Date.now()}`,
      content: 'github_pat_TEST_SHOULD_NOT_WRITE\n',
      folder: '.buildflow',
      filename: `blocked-${label.toLowerCase()}-${Date.now()}.md`,
      dryRun: true
    })
  }))
  assert(dryRunArtifactBlocked.response.status === 200, `${label}: blocked dry-run artifact must return 200`)
  assert(dryRunArtifactBlocked.json.allowed === false, `${label}: blocked dry-run artifact must be disallowed`)
  assert(dryRunArtifactBlocked.json.verified === false, `${label}: blocked dry-run artifact must not verify`)
  assert(dryRunArtifactBlocked.json.error?.code === 'SECRET_PATTERN_BLOCKED', `${label}: blocked dry-run artifact must return SECRET_PATTERN_BLOCKED`)
  assertActivity(dryRunArtifactBlocked.json.activity, 'writeBuildFlowArtifact', 'blocked', 'Blocked unsafe artifact write')

  const artifactTitle = `GPT contract smoke ${label} ${Date.now()}`
  const artifactContent = `Smoke test artifact for ${label}.`
  const writeArtifact = await runStep('writeBuildFlowArtifact', () => requestJson(`${baseUrl}/api/actions/write-artifact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId: 'buildflow',
      artifactType: 'general_doc',
      title: artifactTitle,
      content: artifactContent
    })
  }))
  assert(writeArtifact.response.status === 200, `${label}: write artifact must return 200`)
  assert(writeArtifact.json.verified === true, `${label}: write artifact must return verified:true`)
  assert(typeof writeArtifact.json.path === 'string' && writeArtifact.json.path.length > 0, `${label}: write artifact path missing`)
  assertActivity(writeArtifact.json.activity, 'writeBuildFlowArtifact', 'completed', 'Verified repo artifact')

  const artifactDiskPath = path.resolve(ROOT, writeArtifact.json.path)
  assert(fs.existsSync(artifactDiskPath), `${label}: written artifact missing on disk`)

  const applyPath = `docs/product/tasks/gpt-contract-smoke-${label.toLowerCase()}-${Date.now()}.md`
  const applyChange = await runStep('applyBuildFlowFileChange create', () => requestJson(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'create',
      sourceId: 'buildflow',
      path: applyPath,
      content: `Smoke file for ${label}.`,
      reason: 'Contract smoke test'
    })
  }))
  assert(applyChange.response.status === 200, `${label}: apply file change must return 200`)
  assert(applyChange.json.verified === true, `${label}: apply file change must return verified:true`)
  assertActivity(applyChange.json.activity, 'applyBuildFlowFileChange', 'completed', 'Verified repo file change')

  const applyDiskPath = path.resolve(ROOT, applyChange.json.path || applyPath)
  assert(fs.existsSync(applyDiskPath), `${label}: applied file missing on disk`)

  const mkdirPath = `.buildflow/gpt-contract-smoke-${label.toLowerCase()}-${Date.now()}/nested`
  const mkdirResult = await runStep('applyBuildFlowFileChange mkdir', () => requestJson(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'mkdir',
      sourceId: 'buildflow',
      path: mkdirPath,
      createParents: true,
      reason: 'Contract smoke test mkdir'
    })
  }))
  assert(mkdirResult.response.status === 200, `${label}: mkdir must return 200`)
  assert(mkdirResult.json.verified === true, `${label}: mkdir must return verified:true`)
  assert(fs.existsSync(path.resolve(ROOT, mkdirPath)), `${label}: mkdir target missing on disk`)
  assertActivity(mkdirResult.json.activity, 'applyBuildFlowFileChange', 'completed', 'Created directory')

  for (const filePath of [artifactDiskPath, applyDiskPath]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  assert(!fs.existsSync(artifactDiskPath), `${label}: write artifact cleanup failed`)
  assert(!fs.existsSync(applyDiskPath), `${label}: apply-file cleanup failed`)
  const mkdirDiskPath = path.resolve(ROOT, mkdirPath)
  if (fs.existsSync(mkdirDiskPath)) fs.rmSync(path.dirname(mkdirDiskPath), { recursive: true, force: true })

  const rmdirEmptyPath = `.buildflow/gpt-contract-rmdir-empty-${label.toLowerCase()}-${Date.now()}`
  fs.mkdirSync(path.resolve(ROOT, rmdirEmptyPath), { recursive: true })
  const rmdirEmptyResult = await runStep('applyBuildFlowFileChange rmdir empty', () => requestJson(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'rmdir',
      sourceId: 'buildflow',
      path: rmdirEmptyPath,
      reason: 'Contract smoke test rmdir empty'
    })
  }))
  assert(rmdirEmptyResult.response.status === 200, `${label}: rmdir empty must return 200`)
  assert(rmdirEmptyResult.json.verified === true, `${label}: rmdir empty must return verified:true`)
  assert(rmdirEmptyResult.json.changeType === 'rmdir' || rmdirEmptyResult.json.operation === 'rmdir', `${label}: rmdir empty must report rmdir`)
  assert(rmdirEmptyResult.json.directoryEmptyBefore === true, `${label}: rmdir empty must report empty directory`)
  assert(!fs.existsSync(path.resolve(ROOT, rmdirEmptyPath)), `${label}: rmdir empty directory cleanup failed`)
  assertActivity(rmdirEmptyResult.json.activity, 'applyBuildFlowFileChange', 'completed', 'Deleted empty directory')

  const rmdirNonEmptyPath = `.buildflow/gpt-contract-rmdir-nonempty-${label.toLowerCase()}-${Date.now()}`
  const rmdirNonEmptyDir = path.resolve(ROOT, rmdirNonEmptyPath)
  fs.mkdirSync(path.join(rmdirNonEmptyDir, 'child'), { recursive: true })
  fs.writeFileSync(path.join(rmdirNonEmptyDir, 'child', 'note.txt'), 'non-empty', 'utf8')
  const rmdirNonEmptyResult = await runStep('applyBuildFlowFileChange rmdir non-empty', () => requestRaw(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'rmdir',
      sourceId: 'buildflow',
      path: rmdirNonEmptyPath,
      reason: 'Contract smoke test rmdir non-empty'
    })
  }))
  assert(rmdirNonEmptyResult.response.status === 409, `${label}: rmdir non-empty must return 409`)
  const rmdirNonEmptyJson = parseJsonSafe(rmdirNonEmptyResult.text, 'rmdir non-empty')
  assert(rmdirNonEmptyJson.code === 'DIRECTORY_NOT_EMPTY', `${label}: rmdir non-empty must return DIRECTORY_NOT_EMPTY`)
  assert(fs.existsSync(rmdirNonEmptyDir), `${label}: rmdir non-empty directory should still exist`)
  fs.rmSync(rmdirNonEmptyDir, { recursive: true, force: true })

  const dryRunBlocked = await runStep('applyBuildFlowFileChange dryRun blocked', () => requestJson(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'create',
      sourceId: 'buildflow',
      path: '.env',
      content: 'SECRET=1',
      dryRun: true,
      reason: 'Contract smoke test blocked dryRun'
    })
  }))
  assert(dryRunBlocked.response.status === 200, `${label}: blocked dryRun must return 200`)
  assert(dryRunBlocked.json.allowed === false, `${label}: blocked dryRun must be disallowed`)
  assert(dryRunBlocked.json.verified === false, `${label}: blocked dryRun must not verify`)
  assert(dryRunBlocked.json.error?.code === 'SECRET_PATH_BLOCKED', `${label}: blocked dryRun must return SECRET_PATH_BLOCKED`)
  assertActivity(dryRunBlocked.json.activity, 'applyBuildFlowFileChange', 'blocked', 'Blocked unsafe write')

  const dryRunConfirmation = await runStep('applyBuildFlowFileChange dryRun confirmation', () => requestJson(`${baseUrl}/api/actions/apply-file-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'patch',
      sourceId: 'buildflow',
      path: 'package.json',
      find: '"name": "buildflow"',
      replace: '"name": "buildflow"',
      dryRun: true,
      reason: 'Contract smoke test confirmation'
    })
  }))
  assert(dryRunConfirmation.response.status === 200, `${label}: confirmation dryRun must return 200`)
  assert(dryRunConfirmation.json.requiresConfirmation === true, `${label}: confirmation dryRun must require confirmation`)
  assert(dryRunConfirmation.json.verified === false, `${label}: confirmation dryRun must not verify`)
  assert(dryRunConfirmation.json.confirmationToken, `${label}: confirmation dryRun must return token`)
  assertActivity(dryRunConfirmation.json.activity, 'applyBuildFlowFileChange', 'waiting_for_confirmation', 'Needs confirmation')

  return { startedAt, finishedAt: Date.now(), steps }
}

async function waitForSourceReady(baseUrl, sourceId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await requestJson(`${baseUrl}/api/agent/sources`, { method: 'GET' })
    const source = Array.isArray(result.json.sources) ? result.json.sources.find(entry => entry.id === sourceId) : null
    if (source && source.indexStatus === 'ready' && source.searchable === true) {
      return result
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return null
}

async function main() {
  const localSchema = await fetchSchema(LOCAL_BASE_URL)
  const publicSchema = await fetchSchema(PUBLIC_BASE_URL)
  const docsSchema = loadDocsSchema()
  const instructions = loadInstructions()

  assert(JSON.stringify(localSchema) === JSON.stringify(publicSchema), 'Local and public OpenAPI schemas must match exactly')
  assert(JSON.stringify(localSchema) === JSON.stringify(docsSchema), 'docs/openapi.chatgpt.json must match the live schema')

  ensureSchemaRules(localSchema)
  ensureConsequentialFlags(localSchema)
  ensureNoStaleFragments()
  ensureInstructionAlignment(instructions)
  regenerateDocsSchema()

  const localSuite = await runActionSuite(LOCAL_BASE_URL, 'local')
  const publicSuite = await runActionSuite(PUBLIC_BASE_URL, 'public')

  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    local: {
      durationMs: localSuite.finishedAt - localSuite.startedAt,
      steps: localSuite.steps
    },
    public: {
      durationMs: publicSuite.finishedAt - publicSuite.startedAt,
      steps: publicSuite.steps
    }
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})

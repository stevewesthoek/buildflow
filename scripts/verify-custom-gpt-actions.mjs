#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const LOCAL_BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const TOKEN = process.env.BUILDFLOW_ACTION_TOKEN || ''
const ROOT = process.cwd()
const DOCS_SCHEMA_FILE = path.join(ROOT, 'docs/openapi.chatgpt.json')
const INSTRUCTIONS_FILE = path.join(ROOT, 'docs/CUSTOM_GPT_INSTRUCTIONS.md')
const DOCS_SCHEMA_DIR = path.join(ROOT, 'docs/openapi.chatgpt')

const MAX_SCHEMA_BYTES = 100_000
const MAX_INSTRUCTIONS_BYTES = 8_000
const TARGET_ACTION_RESPONSE_BYTES = 8_000
const HARD_ACTION_RESPONSE_BYTES = 32_000

const EXPECTED_OPERATION_IDS = [
  'getBuildFlowStatus',
  'readBuildFlowContext',
  'applyBuildFlowFileChange',
  'commitBuildFlowChanges',
  'runBuildFlowCommand'
]

const REQUIRED_ACTION_PATHS = [
  '/api/actions/status',
  '/api/actions/read-context',
  '/api/actions/apply-file-change',
  '/api/actions/commit-changes',
  '/api/actions/run-command'
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readJson(file) {
  assert(fs.existsSync(file), `Missing file: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

function collectOperations(schema) {
  const ops = []
  for (const [routePath, pathItem] of Object.entries(schema.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem?.[method]
      if (op && typeof op === 'object') ops.push({ routePath, method, ...op })
    }
  }
  return ops
}

function ensureSchemaRules(schema) {
  const schemaBytes = byteLength(schema)
  assert(schemaBytes < MAX_SCHEMA_BYTES, `OpenAPI schema too large: ${schemaBytes} bytes`)

  const ops = collectOperations(schema)
  const ids = ops.map(op => op.operationId)
  assert(ids.length === EXPECTED_OPERATION_IDS.length, `Expected ${EXPECTED_OPERATION_IDS.length} operations, found ${ids.length}: ${ids.join(', ')}`)
  assert(new Set(ids).size === ids.length, 'OperationIds must be unique')
  assert(JSON.stringify([...ids].sort()) === JSON.stringify([...EXPECTED_OPERATION_IDS].sort()), `OperationIds mismatch: ${ids.join(', ')}`)

  for (const op of ops) {
    assert(Array.isArray(op.security) && op.security.length > 0, `${op.operationId} missing security`)
    assert(op['x-openai-isConsequential'] === false, `${op.operationId} must be non-consequential for GPT action confirmation UX`)
    assert(typeof op.summary === 'string' && op.summary.length > 0 && op.summary.length <= 300, `${op.operationId} summary invalid`)
  }

  for (const routePath of REQUIRED_ACTION_PATHS) {
    assert(schema.paths?.[routePath], `Missing action path: ${routePath}`)
  }

  const schemaText = JSON.stringify(schema)
  for (const legacy of ['setBuildFlowContext', 'executeBuildFlowTask', 'manageBuildFlowAgent', '/api/actions/agent/execute-task', '/api/actions/agent/manage', 'action=list_sources', 'action=get_active', 'action=set_active', '/api/actions/sources', '/api/actions/context/active']) {
    assert(!schemaText.includes(legacy), `Legacy reference exposed in schema: ${legacy}`)
  }
  assert(!schemaText.includes('/api/actions/agent/'), 'Schema must not expose agent-mode action routes')

  const readContext = ops.find(op => op.operationId === 'readBuildFlowContext')
  const readSchema = readContext?.requestBody?.content?.['application/json']?.schema
  const readProps = readSchema?.properties || {}
  const modes = readProps.mode?.enum || []
  for (const mode of ['grep_context', 'read_range', 'read_symbol']) {
    assert(modes.includes(mode), `readBuildFlowContext schema missing focused mode: ${mode}`)
  }
  assert(readProps.paths?.maxItems <= 5, 'readBuildFlowContext paths must be capped at 5 for GPT use')
  assert(readProps.limit?.maximum <= 5, 'readBuildFlowContext limit must be capped at 5 for GPT use')
  assert(readProps.maxBytesPerFile?.maximum <= 4000, 'readBuildFlowContext maxBytesPerFile must be capped at 4000 for GPT use')
  assert(readProps.before?.maximum <= 40, 'grep_context before must be capped at 40')
  assert(readProps.after?.maximum <= 60, 'grep_context after must be capped at 60')
  assert(readProps.maxMatches?.maximum <= 10, 'grep_context maxMatches must be capped at 10')

  const runCommand = ops.find(op => op.operationId === 'runBuildFlowCommand')
  const commandProps = runCommand?.requestBody?.content?.['application/json']?.schema?.properties || {}
  assert(commandProps.timeoutMs?.maximum <= 12000, 'runBuildFlowCommand timeoutMs must be capped at 12000')
}

function ensureInstructions() {
  assert(fs.existsSync(INSTRUCTIONS_FILE), `Missing instructions file: ${INSTRUCTIONS_FILE}`)
  const text = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')
  const bytes = byteLength(text)
  assert(bytes <= MAX_INSTRUCTIONS_BYTES, `Custom GPT instructions exceed ${MAX_INSTRUCTIONS_BYTES} bytes: ${bytes}`)
  for (const required of EXPECTED_OPERATION_IDS) {
    assert(text.includes(required), `Instructions must mention ${required}`)
  }
  assert(text.includes('sourceId'), 'Instructions must require explicit sourceId usage')
  assert(text.includes('maxBytesPerFile'), 'Instructions must include read-size guidance')
  assert(text.includes('Hard action budget per response: 3 BuildFlow actions'), 'Instructions must include hard action budget')
  assert(/deadline|fail fast|timeout/i.test(text), 'Instructions must include timeout/deadline guidance')
  for (const mode of ['grep_context', 'read_range', 'read_symbol']) {
    assert(text.includes(mode), `Instructions must mention ${mode}`)
  }
  assert(text.includes('Never force push'), 'Instructions must preserve git safety (no force push)')
  return { bytes }
}

function ensureNoStaleSchemaFragments() {
  if (!fs.existsSync(DOCS_SCHEMA_DIR)) return { skipped: true }
  const stale = fs.readdirSync(DOCS_SCHEMA_DIR).filter(entry => entry.endsWith('.json'))
  assert(stale.length === 0, `Stale schema fragments found: ${stale.join(', ')}`)
  return { skipped: false }
}

function ensureDocumentationAlignment() {
  const docsToCheck = [
    'README.md',
    'docs/CUSTOM_GPT_INSTRUCTIONS.md',
    'docs/openapi.chatgpt/README.md',
    'docs/product/agent-mode.md',
    'docs/product/agent-mode-optimization-roadmap.md',
    'docs/custom-gpt-agent-performance-root-cause.md',
    'docs/openai-custom-gpt-limits.md'
  ]
  const forbidden = [
    'compact 6-action',
    'schema is 6 operations',
    'Total: 6 operations',
    'Keep the six GPT-facing operations',
    'setBuildFlowActiveContext` | POST',
    'Clear small batch: up to 3 tightly related tasks',
    'Hard maximum: 5 small tasks'
  ]
  const scanned = []
  for (const rel of docsToCheck) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    scanned.push(rel)
    for (const phrase of forbidden) {
      assert(!text.includes(phrase), `Documentation drift in ${rel}: ${phrase}`)
    }
  }
  return { scanned }
}

function ensureSourceDeadlineLayer() {
  const files = {
    deadline: path.join(ROOT, 'apps/web/src/lib/actions/deadline.ts'),
    transport: path.join(ROOT, 'apps/web/src/lib/actions/transport.ts'),
    readContext: path.join(ROOT, 'apps/web/src/app/api/actions/read-context/route.ts'),
    runCommand: path.join(ROOT, 'apps/web/src/app/api/actions/run-command/route.ts')
  }
  for (const [label, file] of Object.entries(files)) {
    assert(fs.existsSync(file), `Missing source file for deadline verification: ${label}`)
  }
  const deadlineText = fs.readFileSync(files.deadline, 'utf8')
  assert(deadlineText.includes('BUILDFLOW_ACTION_DEADLINE_EXCEEDED'), 'Deadline helper must emit structured deadline code')
  assert(deadlineText.includes('GPT_ACTION_DEADLINES_MS'), 'Deadline helper must define action deadlines')
  const transportText = fs.readFileSync(files.transport, 'utf8')
  assert(transportText.includes('signal?: AbortSignal'), 'Transport must accept AbortSignal')
  assert(transportText.includes('const REQUEST_TIMEOUT_MS = 12000'), 'Transport default timeout must be below the old 30s value')
  assert(fs.readFileSync(files.readContext, 'utf8').includes('withGptActionDeadline'), 'read-context route must use deadline wrapper')
  assert(fs.readFileSync(files.runCommand, 'utf8').includes('commandTimeoutMs'), 'run-command route must clamp GPT command timeouts')
}

async function requestJson(pathname, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${LOCAL_BASE_URL}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(options.headers || {})
      }
    })
    const text = await response.text()
    const bytes = byteLength(text)
    const json = text.trim() ? JSON.parse(text) : {}
    return { response, json, bytes }
  } finally {
    clearTimeout(timer)
  }
}

async function runLiveSmokeChecks() {
  if (!TOKEN) return { skipped: true, reason: 'BUILDFLOW_ACTION_TOKEN not set' }
  const status = await requestJson('/api/actions/status', { method: 'GET' })
  assert(status.response.status === 200, `status action returned ${status.response.status}`)
  assert(status.bytes <= HARD_ACTION_RESPONSE_BYTES, `status action exceeds hard budget: ${status.bytes}`)
  return {
    skipped: false,
    statusBytes: status.bytes,
    targetBytes: TARGET_ACTION_RESPONSE_BYTES,
    hardBudgetBytes: HARD_ACTION_RESPONSE_BYTES,
    statusOverTarget: status.bytes > TARGET_ACTION_RESPONSE_BYTES
  }
}

async function main() {
  const schema = readJson(DOCS_SCHEMA_FILE)
  ensureSchemaRules(schema)
  const instructions = ensureInstructions()
  const staleFragments = ensureNoStaleSchemaFragments()
  const documentationAlignment = ensureDocumentationAlignment()
  ensureSourceDeadlineLayer()
  const live = await runLiveSmokeChecks()

  console.log(JSON.stringify({
    status: 'ok',
    schemaBytes: byteLength(schema),
    instructionsBytes: instructions.bytes,
    expectedOperationCount: EXPECTED_OPERATION_IDS.length,
    documentationAlignment,
    payloadBudgets: {
      targetBytes: TARGET_ACTION_RESPONSE_BYTES,
      hardBudgetBytes: HARD_ACTION_RESPONSE_BYTES
    },
    staleFragments,
    live
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exit(1)
})

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
  'setBuildFlowActiveContext',
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
  assert(text.includes('Never force push'), 'Instructions must preserve git safety (no force push)')
  return { bytes }
}

function ensureNoStaleSchemaFragments() {
  if (!fs.existsSync(DOCS_SCHEMA_DIR)) return { skipped: true }
  const stale = fs.readdirSync(DOCS_SCHEMA_DIR).filter(entry => entry.endsWith('.json'))
  assert(stale.length === 0, `Stale schema fragments found: ${stale.join(', ')}`)
  return { skipped: false }
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
  const live = await runLiveSmokeChecks()

  console.log(JSON.stringify({
    status: 'ok',
    schemaBytes: byteLength(schema),
    instructionsBytes: instructions.bytes,
    expectedOperationCount: EXPECTED_OPERATION_IDS.length,
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

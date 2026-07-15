import fs from 'node:fs'
import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { runWorkbenchCommandRequestSchema } from '@workbench/shared'
import { zodToJsonSchema } from 'zod-to-json-schema'

export const WORKBENCH_TOOL_NAMES = [
  'getWorkbenchStatus',
  'readWorkbenchContext',
  'applyWorkbenchFileChange',
  'commitWorkbenchChanges',
  'runWorkbenchCommand'
] as const

export type WorkbenchToolName = typeof WORKBENCH_TOOL_NAMES[number]
export type JsonSchema = Record<string, unknown>

export type WorkbenchToolContract = {
  name: WorkbenchToolName
  title: string
  description: string
  inputSchema: JsonSchema
  method: 'GET' | 'POST'
  endpoint: string
  mutationCapable: boolean
  validate: ValidateFunction
}

type OpenApiOperation = {
  operationId?: unknown
  summary?: unknown
  description?: unknown
  parameters?: Array<Record<string, unknown>>
  requestBody?: {
    content?: {
      'application/json'?: { schema?: JsonSchema }
    }
  }
}

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

const ACTIONS: Record<WorkbenchToolName, { method: 'get' | 'post'; endpoint: string; mutationCapable: boolean }> = {
  getWorkbenchStatus: { method: 'get', endpoint: '/api/actions/status', mutationCapable: false },
  readWorkbenchContext: { method: 'post', endpoint: '/api/actions/read-context', mutationCapable: false },
  applyWorkbenchFileChange: { method: 'post', endpoint: '/api/actions/apply-file-change', mutationCapable: true },
  commitWorkbenchChanges: { method: 'post', endpoint: '/api/actions/commit-changes', mutationCapable: true },
  runWorkbenchCommand: { method: 'post', endpoint: '/api/actions/run-command', mutationCapable: true }
}

const MAX_OPENAPI_BYTES = 512 * 1024

function readOpenApi(repoRoot: string): OpenApiDocument {
  const schemaPath = path.join(repoRoot, 'docs', 'openapi.chatgpt.json')
  const stat = fs.statSync(schemaPath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OPENAPI_BYTES) {
    throw new Error('Committed Workbench OpenAPI artifact is missing or outside the allowed size.')
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as OpenApiDocument
}

function statusInputSchema(operation: OpenApiOperation): JsonSchema {
  const properties: Record<string, unknown> = {}
  for (const parameter of operation.parameters ?? []) {
    if (parameter.in !== 'query' || typeof parameter.name !== 'string') continue
    properties[parameter.name] = parameter.schema && typeof parameter.schema === 'object'
      ? parameter.schema
      : { type: 'string' }
  }
  return { type: 'object', additionalProperties: false, properties }
}

function operationInputSchema(name: WorkbenchToolName, operation: OpenApiOperation, method: 'get' | 'post'): JsonSchema {
  if (method === 'get') return statusInputSchema(operation)
  if (name === 'runWorkbenchCommand') {
    return {
      type: 'object',
      ...zodToJsonSchema(runWorkbenchCommandRequestSchema, {
        target: 'openApi3',
        $refStrategy: 'none'
      })
    } as JsonSchema
  }
  const schema = operation.requestBody?.content?.['application/json']?.schema
  if (!schema || schema.type !== 'object') throw new Error('Workbench action is missing an object request schema.')
  return schema
}

export function loadWorkbenchToolContracts(repoRoot: string): Map<WorkbenchToolName, WorkbenchToolContract> {
  const document = readOpenApi(repoRoot)
  const ajv = new Ajv({ allErrors: true, strict: false })
  const contracts = new Map<WorkbenchToolName, WorkbenchToolContract>()
  const seenOperations: string[] = []

  for (const [endpoint, methods] of Object.entries(document.paths ?? {})) {
    for (const operation of Object.values(methods)) {
      if (typeof operation.operationId === 'string') seenOperations.push(operation.operationId)
    }
  }

  if (seenOperations.length !== WORKBENCH_TOOL_NAMES.length ||
      WORKBENCH_TOOL_NAMES.some(name => !seenOperations.includes(name))) {
    throw new Error('Committed Workbench OpenAPI artifact must expose exactly the five approved actions.')
  }

  for (const name of WORKBENCH_TOOL_NAMES) {
    const definition = ACTIONS[name]
    const operation = document.paths?.[definition.endpoint]?.[definition.method]
    if (!operation || operation.operationId !== name) {
      throw new Error(`Workbench OpenAPI action ${name} is missing or moved.`)
    }
    const inputSchema = operationInputSchema(name, operation, definition.method)
    contracts.set(name, {
      name,
      title: typeof operation.summary === 'string' ? operation.summary : name,
      description: typeof operation.description === 'string' ? operation.description : name,
      inputSchema,
      method: definition.method === 'get' ? 'GET' : 'POST',
      endpoint: definition.endpoint,
      mutationCapable: definition.mutationCapable,
      validate: ajv.compile(inputSchema)
    })
  }

  return contracts
}

export function validateToolInput(contract: WorkbenchToolContract, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: ['request: expected an object'] }
  }
  if (!contract.validate(input)) {
    return {
      ok: false,
      issues: (contract.validate.errors ?? []).slice(0, 10).map(issue =>
        `${issue.instancePath || 'request'}: ${issue.message || 'invalid value'}`)
    }
  }
  if (contract.name === 'runWorkbenchCommand') {
    const strict = runWorkbenchCommandRequestSchema.safeParse(input)
    if (!strict.success) {
      return {
        ok: false,
        issues: strict.error.issues.slice(0, 10).map(issue =>
          `${issue.path.join('.') || 'request'}: ${issue.message}`)
      }
    }
    return { ok: true, value: strict.data as Record<string, unknown> }
  }
  return { ok: true, value: input as Record<string, unknown> }
}

import { NextResponse } from 'next/server'

const bearer = { bearerAuth: [] }

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'BuildFlow API',
    version: '4.0.0',
    description: 'Fast Repo Assistant actions. Each action is bounded by a short BuildFlow deadline and returns structured JSON before platform timeouts.'
  },
  servers: [
    {
      url: process.env.PUBLIC_BASE_URL || process.env.LOCAL_DASHBOARD_BASE_URL || 'https://buildflow.prochat.tools',
      description: 'BuildFlow'
    }
  ],
  components: {
    schemas: {},
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' }
    }
  },
  paths: {
    '/api/actions/status': {
      get: {
        operationId: 'getBuildFlowStatus',
        summary: 'Fast status check with a 4s BuildFlow deadline',
        description: 'Compact health check: ok/connected flags, optional sources and context, runtime stats. Response is always under 8 KB with diagnostics stripped. Completes in <500ms normally. Use this first to lock sourceId, then call the read-context action for repo details. If not connected, returns unavailable status with guidance.',
        'x-openai-isConsequential': false,
        security: [bearer],
        parameters: [
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['sources', 'active', 'all'] }, description: 'Include sources list and/or active context. Use sources on first call to lock sourceId. Omit for fastest 100ms check.' }
        ],
        responses: {
          200: {
            description: 'Status with optional context (max 8 KB response)',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/read-context': {
      post: {
        operationId: 'readBuildFlowContext',
        summary: 'Bounded repo context read with an 8s BuildFlow deadline',
        description: 'Fast exact reads and cached Graphify navigation. Unknown areas should call graph_context first, then exact read. Known paths/symbols should skip graph. Broad scope returns needs_narrower_scope.',
        'x-openai-isConsequential': false,
        security: [bearer],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', enum: ['prepare_task_context', 'read_paths', 'search_and_read', 'list_files', 'search', 'grep_context', 'read_range', 'read_symbol', 'graph_context'], description: 'Mode determines operation. Use graph_context first for unknown areas, then verify with exact reads. Known paths use read_paths/grep_context/read_range directly. Known symbols use read_symbol.' },
                  sourceId: { type: 'string' },
                  paths: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'At most 5 exact repo-relative paths for GPT use. For read_paths, enforced; for search_and_read, used as filter.' },
                  query: { type: 'string', maxLength: 200, description: 'Concrete task goal or search query. Broad unscoped queries ("all", "repo", "code") fail fast with narrower-mode guidance. For graph_context, ranks cached Graphify navigation hints. For search modes, must be specific (e.g., "function name", "error message pattern").' },
                  path: { type: 'string', description: 'Folder for list_files, or exact repo-relative file path for grep_context/read_range/read_symbol.' },
                  pattern: { type: 'string', maxLength: 500, description: 'Literal pattern for grep_context. Regex is opt-in and tightly bounded; use literal mode for safety.' },
                  regex: { type: 'boolean', description: 'If true, interpret pattern as a regular expression. Defaults to literal matching.' },
                  before: { type: 'integer', minimum: 0, maximum: 40, description: 'Lines before each grep_context match. Defaults to 8. Higher values = slower response.' },
                  after: { type: 'integer', minimum: 0, maximum: 60, description: 'Lines after each grep_context match. Defaults to 12. Higher values = slower response.' },
                  maxMatches: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum grep_context matches. Defaults to 5. Higher values = slower response.' },
                  startLine: { type: 'integer', minimum: 1, description: 'First line for read_range. Output is capped at 250 lines to stay under 8s deadline.' },
                  endLine: { type: 'integer', minimum: 1, description: 'Last line for read_range. Output is capped at 250 lines to stay under 8s deadline.' },
                  symbol: { type: 'string', description: 'TypeScript class/function/const symbol for read_symbol. Fastest when symbol name is exact.' },
                  depth: { type: 'integer', minimum: 1, maximum: 5 },
                  limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Search/list result limit. Defaults to 5. Keep at 1-5 to finish under 8s deadline.' },
                  maxBytesPerFile: { type: 'integer', minimum: 1000, maximum: 4000, description: 'Exact read byte cap per file. Defaults to 4000. Files over 100 KB: use grep_context or read_range instead. Larger values slow down JSON serialization.' }
                },
                required: ['mode', 'sourceId']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Files or search results (max 256 KB response)',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/apply-file-change': {
      post: {
        operationId: 'applyBuildFlowFileChange',
        summary: 'Guarded file change with an 8s BuildFlow deadline',
        description: 'Apply a single file change (create, overwrite, patch, append, delete, move) with built-in policy validation. Use dryRun=true to test if a write is allowed without modifying the file. Normally completes in <2s. Larger files or confirmation-gated operations may approach 8s.',
        'x-openai-isConsequential': false,
        security: [bearer],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sourceId: { type: 'string' },
                  changeType: {
                    type: 'string',
                    enum: ['create', 'overwrite', 'patch', 'append', 'delete_file', 'move'],
                    description: 'create=new file; overwrite=replace full content; patch=find+replace snippet; append=add to end; delete_file=remove; move=rename/relocate'
                  },
                  path: { type: 'string', description: 'Repo-relative path, e.g. src/lib/utils.ts' },
                  content: { type: 'string', description: 'Full file content for create/overwrite, appended text for append' },
                  find: { type: 'string', description: 'Exact string to find for patch changeType' },
                  replace: { type: 'string', description: 'Replacement string for patch changeType' },
                  allowMultiple: { type: 'boolean', description: 'For patch only, replace every identical match. Defaults to false.' },
                  to: { type: 'string', description: 'Destination path for move changeType' },
                  reason: { type: 'string', description: 'Why this change is being made (logged for audit)' },
                  confirmedByUser: { type: 'boolean', description: 'Only set true when the user explicitly approved a confirmation-gated delete or write.' },
                  confirmationToken: { type: 'string', description: 'Backend-issued confirmation token for confirmation-gated file changes.' },
                  dryRun: { type: 'boolean', description: 'If true, validates the write policy without writing. Use to check if a path is allowed before writing.' }
                },
                required: ['sourceId', 'changeType', 'path']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Write result with verification',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/commit-changes': {
      post: {
        operationId: 'commitBuildFlowChanges',
        summary: 'Diff, stage explicit paths, and commit within 10s',
        description: 'Three-step operation: git diff → git add paths → git commit. Always use specific paths (1-10 typical); never commit everything at once. Normally completes in <5s for small commits. Confirmation-gated operations may require a second prompt with the returned token.',
        'x-openai-isConsequential': false,
        security: [bearer],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sourceId: { type: 'string' },
                  paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'Specific files to stage — never commit everything at once' },
                  message: { type: 'string', description: 'Commit message, e.g. "fix: normalize path in read-context route"' },
                  confirmedByUser: { type: 'boolean', description: 'Only set true when committing a confirmation-gated exact-path change the user explicitly approved.' },
                  confirmationToken: { type: 'string', description: 'Backend-issued confirmation token for confirmation-gated commits.' }
                },
                required: ['sourceId', 'paths', 'message']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Diff proof + commit result',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/run-command': {
      post: {
        operationId: 'runBuildFlowCommand',
        summary: 'Run fast allowlisted command with a 12s GPT cap',
        description: 'Run only fast allowlisted commands (type-check, git-commands, validate-json, security-scan, test with marker). Commands are killed at 12s deadline. Output is truncated to ~8 KB. Large tests or type-checks should run in a separate follow-up prompt.',
        'x-openai-isConsequential': false,
        security: [bearer],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sourceId: { type: 'string' },
                  commandKind: {
                    type: 'string',
                    enum: ['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'git_log_latest', 'git_branch_current', 'type_check_web', 'type_check_cli', 'git_diff_cached_stat', 'git_diff_cached_name_only', 'git_add_paths', 'git_commit', 'git_push', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths', 'diagnose_performance']
                  },
                  paths: { type: 'array', items: { type: 'string' }, maxItems: 50 },
                  message: { type: 'string' },
                  body: { type: 'string' },
                  remote: { type: 'string' },
                  branch: { type: 'string' },
                  scriptName: { type: 'string' },
                  marker: { type: 'string', description: 'Test marker for run_package_test_marker. Shell metacharacters are rejected by the backend.' },
                  patternSet: { type: 'string', enum: ['forbidden_runtime_execution', 'forbidden_secret_material', 'forbidden_upload_network', 'forbidden_all_high_risk'], description: 'Named security scan set for security_scan_paths.' },
                  packageDir: { type: 'string', description: 'Required for run_package_script, run_package_test, and run_package_test_marker. Use "." for the selected source root.' },
                  confirmedByUser: { type: 'boolean', description: 'Only use when the user explicitly confirmed a confirmation-gated safe command.' },
                  confirmationToken: { type: 'string', description: 'Backend-issued confirmation token for confirmation-gated safe commands.' },
                  timeoutMs: { type: 'integer', minimum: 1000, maximum: 12000, description: 'GPT-facing command timeout. Defaults to 5-8s and is capped well below the external action timeout.' }
                },
                required: ['sourceId', 'commandKind']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Command result',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    }
  }
}

const workbenchOperationIds = {
  getBuildFlowStatus: 'getWorkbenchStatus',
  readBuildFlowContext: 'readWorkbenchContext',
  applyBuildFlowFileChange: 'applyWorkbenchFileChange',
  commitBuildFlowChanges: 'commitWorkbenchChanges',
  runBuildFlowCommand: 'runWorkbenchCommand'
} as const

const getRequestOrigin = (request: Request) => {
  const requestUrl = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const host = forwardedHost || request.headers.get('host') || requestUrl.host
  const protocol = forwardedProto || requestUrl.protocol.replace(':', '')
  return {
    host: host.split(':')[0],
    origin: `${protocol}://${host}`
  }
}

const createWorkbenchSchema = (origin: string) => {
  const schema = structuredClone(openapi)
  schema.info = {
    ...schema.info,
    title: 'ProChat Workbench API',
    description: 'ProChat Workbench actions powered by the BuildFlow engine. Each action is bounded by a short BuildFlow deadline and returns structured JSON before platform timeouts.'
  }
  schema.servers = [{ url: origin, description: 'ProChat Workbench' }]

  const paths = schema.paths as Record<string, Record<string, { operationId?: string }>>
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      const legacyId = operation.operationId as keyof typeof workbenchOperationIds | undefined
      if (legacyId && legacyId in workbenchOperationIds) {
        operation.operationId = workbenchOperationIds[legacyId]
      }
    }
  }

  return schema
}

export async function GET(request: Request) {
  const { host, origin } = getRequestOrigin(request)
  const legacySchema = host === 'buildflow.prochat.tools'
  const schema = legacySchema ? structuredClone(openapi) : createWorkbenchSchema(origin)

  if (legacySchema) {
    schema.servers = [{ url: origin, description: 'BuildFlow compatibility' }]
  }

  return NextResponse.json(schema, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  })
}

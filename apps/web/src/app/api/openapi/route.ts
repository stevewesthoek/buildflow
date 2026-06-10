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
        summary: 'Fast status check with a 4s BuildFlow deadline. Response budget: ~8 KB max.',
        description: 'Returns compact BuildFlow health: ok/connected flags, optional sources list, optional active context, runtime stats, and activity narration. Response is guaranteed to be under 8 KB; diagnostics and internal state are stripped to keep responses fast. Status is not a context dump—use readBuildFlowContext for detailed repo information.',
        'x-openai-isConsequential': false,
        security: [bearer],
        parameters: [
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['sources', 'active', 'all'] }, description: 'Include sources list and/or active context. Use sources for the first call to lock a sourceId.' }
        ],
        responses: {
          200: {
            description: 'Status with optional context (max ~8 KB)',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/read-context': {
      post: {
        operationId: 'readBuildFlowContext',
        summary: 'Bounded repo context read with an 8s BuildFlow deadline',
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
                  mode: { type: 'string', enum: ['prepare_task_context', 'read_paths', 'search_and_read', 'list_files', 'search', 'grep_context', 'read_range', 'read_symbol', 'graph_context'] },
                  sourceId: { type: 'string' },
                  paths: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'At most 5 exact repo-relative paths for GPT use.' },
                  query: { type: 'string', description: 'Concrete task goal or search query. Broad unscoped queries fail fast with narrower-mode guidance. For graph_context, this is used only to rank cached Graphify navigation hints.' },
                  path: { type: 'string', description: 'Folder for list_files, or exact repo-relative file path for grep_context/read_range/read_symbol.' },
                  pattern: { type: 'string', description: 'Literal pattern for grep_context. Regex is opt-in and tightly bounded.' },
                  regex: { type: 'boolean', description: 'If true, interpret pattern as a regular expression. Defaults to literal matching.' },
                  before: { type: 'integer', minimum: 0, maximum: 40, description: 'Lines before each grep_context match. Defaults to 8.' },
                  after: { type: 'integer', minimum: 0, maximum: 60, description: 'Lines after each grep_context match. Defaults to 12.' },
                  maxMatches: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum grep_context matches. Defaults to 5.' },
                  startLine: { type: 'integer', minimum: 1, description: 'First line for read_range. Output is capped at 250 lines.' },
                  endLine: { type: 'integer', minimum: 1, description: 'Last line for read_range. Output is capped at 250 lines.' },
                  symbol: { type: 'string', description: 'TypeScript class/function/const symbol for read_symbol.' },
                  depth: { type: 'integer', minimum: 1, maximum: 5 },
                  limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Search/list result limit. Defaults to 5.' },
                  maxBytesPerFile: { type: 'integer', minimum: 1000, maximum: 4000, description: 'Exact read byte cap per file. Defaults to 4000; files over 100 KB require focused modes.' }
                },
                required: ['mode', 'sourceId']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Files or search results',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/apply-file-change': {
      post: {
        operationId: 'applyBuildFlowFileChange',
        summary: 'Guarded file change with an 8s BuildFlow deadline',
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
                  timeoutMs: { type: 'integer', minimum: 1000, maximum: 12000, description: 'GPT-facing command timeout. Defaults to 5-8s and is capped below the 45s platform timeout.' }
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

export async function GET() {
  return NextResponse.json(openapi, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  })
}

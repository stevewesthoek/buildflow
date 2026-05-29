import { NextResponse } from 'next/server'

const bearer = { bearerAuth: [] }

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'BuildFlow API',
    version: '4.0.0',
    description: 'Fast Repo Assistant actions for local repo status, source context, exact reads, guarded writes, validation commands, and commits.'
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
        summary: 'Status + sources + active context in one call',
        'x-openai-isConsequential': false,
        security: [bearer],
        parameters: [
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['sources', 'active', 'all'] }, description: 'Include sources and/or active context. Use all for first call.' }
        ],
        responses: {
          200: {
            description: 'Status',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      },
      post: {
        operationId: 'setBuildFlowActiveContext',
        summary: 'Set active source context',
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
                  contextMode: { type: 'string', enum: ['single', 'multi'] },
                  sourceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 }
                },
                required: ['contextMode', 'sourceIds']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Updated context',
            content: { 'application/json': { schema: { type: 'object', properties: {}, additionalProperties: true } } }
          }
        }
      }
    },
    '/api/actions/read-context': {
      post: {
        operationId: 'readBuildFlowContext',
        summary: 'Read files, search, or prepare focused task context',
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
                  mode: { type: 'string', enum: ['prepare_task_context', 'read_paths', 'search_and_read', 'list_files', 'search'] },
                  sourceId: { type: 'string' },
                  paths: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                  query: { type: 'string', description: 'Task goal or search query. Use prepare_task_context first for coding tasks so BuildFlow can return a deterministic exact read plan.' },
                  path: { type: 'string', description: 'Folder for list_files.' },
                  depth: { type: 'integer', minimum: 1, maximum: 5 },
                  limit: { type: 'integer', minimum: 1, maximum: 10 },
                  maxBytesPerFile: { type: 'integer', minimum: 1000, maximum: 30000 }
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
        summary: 'Write, patch, delete, or move a file in the repo',
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
                  to: { type: 'string', description: 'Destination path for move changeType' },
                  reason: { type: 'string', description: 'Why this change is being made (logged for audit)' },
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
        summary: 'Diff + stage + commit in one call',
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
                  message: { type: 'string', description: 'Commit message, e.g. "fix: normalize path in read-context route"' }
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
        summary: 'Run fast allowlisted command',
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
                  timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, description: 'Keep Custom GPT actions under the 45s platform timeout.' }
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

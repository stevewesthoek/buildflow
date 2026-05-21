import { NextResponse } from 'next/server'

const bearer = { bearerAuth: [] }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const sourceItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    enabled: { type: 'boolean' },
    active: { type: 'boolean' },
    indexStatus: { type: 'string' },
    searchable: { type: 'boolean' },
    indexedFileCount: { type: 'integer' },
    autoIndexEnabled: { type: 'boolean' },
    autoIndexIntervalMinutes: { type: 'integer' },
    lastAutoIndexedAt: { type: 'string' },
    writable: { type: 'boolean' },
    writeProfile: { type: 'string' },
    writePolicy: { type: 'object', additionalProperties: true }
  },
  required: ['id', 'label', 'enabled', 'active', 'indexStatus', 'searchable']
}

const fileResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string' },
    path: { type: 'string' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
    sizeBytes: { type: 'integer' },
    modifiedAt: { type: 'string' },
    error: { type: 'string' }
  },
  required: ['path']
}

const skippedReadFileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    sourceId: { type: 'string' },
    sizeBytes: { type: 'integer' },
    reason: { type: 'string', enum: ['response_budget_exceeded', 'file_too_large'] }
  },
  required: ['path', 'reason']
}

const nextBatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    paths: { type: 'array', items: { type: 'string' } },
    sourceId: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } },
    maxBytesPerFile: { type: 'integer' }
  },
  required: ['paths']
}

const activitySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'string' },
    operationId: { type: 'string' },
    phase: {
      type: 'string',
      enum: ['starting', 'checking', 'reading', 'planning', 'preflight', 'waiting_for_confirmation', 'writing', 'verifying', 'completed', 'blocked', 'failed']
    },
    actionLabel: { type: 'string' },
    userMessage: { type: 'string' },
    sourceId: { type: 'string' },
    sourceLabel: { type: 'string' },
    targetPaths: { type: 'array', items: { type: 'string' } },
    readPaths: { type: 'array', items: { type: 'string' } },
    changedPaths: { type: 'array', items: { type: 'string' } },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    requiresConfirmation: { type: 'boolean' },
    verified: { type: 'boolean' },
    safeInputSummary: { type: 'string' },
    safeOutputSummary: { type: 'string' },
    whatHappened: { type: 'array', items: { type: 'string' } },
    whatRemains: { type: 'array', items: { type: 'string' } },
    provenFacts: { type: 'array', items: { type: 'string' } },
    nextActions: { type: 'array', items: { type: 'string' } },
    nextStep: { type: 'string' }
  },
  required: ['version', 'operationId', 'phase', 'actionLabel', 'userMessage', 'riskLevel', 'requiresConfirmation', 'verified']
}

const writeResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    sourceId: { type: 'string' },
    path: { type: 'string' },
    artifactType: { type: 'string' },
    changeType: { type: 'string' },
    operation: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    created: { type: 'boolean' },
    verified: { type: 'boolean' },
    verifiedAt: { type: 'string' },
    bytesOnDisk: { type: 'integer' },
    bytesWritten: { type: 'integer' },
    bytesAppended: { type: 'integer' },
    replacements: { type: 'integer' },
    matchCount: { type: 'integer' },
    bytesBefore: { type: 'integer' },
    bytesAfter: { type: 'integer' },
    contentHash: { type: 'string' },
    contentPreview: { type: 'string' },
    existsBefore: { type: 'boolean' },
    existsAfter: { type: 'boolean' },
    sourceExistsAfter: { type: 'boolean' },
    targetExistsAfter: { type: 'boolean' },
    deletedFileCount: { type: 'integer' },
    deletedDirectoryCount: { type: 'integer' },
    activity: activitySchema
  },
  required: ['verified', 'verifiedAt', 'bytesOnDisk', 'contentHash', 'contentPreview']
}

const agentJobSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    sourceId: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'paused', 'cancelled', 'needs_confirmation', 'blocked', 'completed', 'failed'] },
    maxIterations: { type: 'integer' },
    currentIteration: { type: 'integer' },
    activeTaskId: { type: 'string' },
    completedTaskCount: { type: 'integer' },
    totalTaskCount: { type: 'integer' },
    activeTask: { type: 'object', additionalProperties: true },
    roadmapSummary: { type: 'array', items: { type: 'object', additionalProperties: true } },
    nextActions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    handoffPath: { type: 'string' },
    autoCommit: { type: 'boolean' },
    autoPush: { type: 'boolean' },
    requiresConfirmation: { type: 'boolean' },
    confirmationReason: { type: 'string' },
    blockedReason: { type: 'string' },
    lastKnownGitStatus: { type: 'string' }
  },
  required: ['id', 'sourceId', 'status', 'maxIterations', 'currentIteration', 'completedTaskCount', 'totalTaskCount', 'autoCommit', 'autoPush', 'requiresConfirmation', 'nextActions', 'summary', 'handoffPath']
}

const agentEventSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    jobId: { type: 'string' },
    sourceId: { type: 'string' },
    type: { type: 'string' },
    message: { type: 'string' },
    createdAt: { type: 'string' },
    commandKind: { type: 'string' },
    status: { type: 'string' }
  },
  required: ['id', 'jobId', 'sourceId', 'type', 'message', 'createdAt']
}

const commandResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'timed_out', 'needs_confirmation'] },
    commandKind: { type: 'string' },
    command: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    outputTruncated: { type: 'boolean' },
    durationMs: { type: 'integer' },
    requiresConfirmation: { type: 'boolean' },
    confirmationToken: { type: 'string' },
    reason: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    activity: activitySchema
  },
  required: ['status', 'commandKind', 'command', 'cwd', 'outputTruncated', 'durationMs']
}

const errorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    error: { type: 'string' }
  },
  required: ['error']
}

const errorResponses = {
  400: {
    description: 'Bad request',
    content: { 'application/json': { schema: errorSchema } }
  },
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: errorSchema } }
  },
  403: {
    description: 'Forbidden',
    content: { 'application/json': { schema: errorSchema } }
  },
  409: {
    description: 'Conflict',
    content: { 'application/json': { schema: errorSchema } }
  },
  500: {
    description: 'Server error',
    content: { 'application/json': { schema: errorSchema } }
  },
  502: {
    description: 'Upstream error',
    content: { 'application/json': { schema: errorSchema } }
  }
}

const schemaRefs = new Map<object, string>([
  [activitySchema, 'Activity'],
  [sourceItemSchema, 'Source'],
  [fileResultSchema, 'FileResult'],
  [skippedReadFileSchema, 'SkippedReadFile'],
  [nextBatchSchema, 'NextBatch'],
  [writeResultSchema, 'WriteResult'],
  [agentJobSchema, 'AgentJob'],
  [agentEventSchema, 'AgentEvent'],
  [commandResultSchema, 'CommandResult'],
  [errorSchema, 'Error']
])

function compactOpenApiDoc<T>(value: T, path: string[] = []): T {
  if (!value || typeof value !== 'object') return value
  const currentComponent = path[0] === 'components' && path[1] === 'schemas' ? path[2] : undefined
  const refName = schemaRefs.get(value as object)
  if (refName && refName !== currentComponent) return ref(refName) as T
  if (Array.isArray(value)) return value.map((item, index) => compactOpenApiDoc(item, [...path, String(index)])) as T
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, compactOpenApiDoc(child, [...path, key])])
  ) as T
}

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'BuildFlow API',
    version: '3.0.0',
    description: 'BuildFlow GPT actions for agentic repo status, sources, active context, inspection, reading, safe commands, Agent Mode, and verified writes.'
  },
  servers: [
    {
      url: process.env.PUBLIC_BASE_URL || process.env.LOCAL_DASHBOARD_BASE_URL || 'https://buildflow.prochat.tools',
      description: 'BuildFlow public endpoint'
    }
  ],
  components: {
    schemas: {
      Activity: activitySchema,
      Source: sourceItemSchema,
      FileResult: fileResultSchema,
      SkippedReadFile: skippedReadFileSchema,
      NextBatch: nextBatchSchema,
      WriteResult: writeResultSchema,
      AgentJob: agentJobSchema,
      AgentEvent: agentEventSchema,
      CommandResult: commandResultSchema,
      Error: errorSchema
    },
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' }
    }
  },
  paths: {
    '/api/actions/status': {
      get: {
        operationId: 'getBuildFlowStatus',
        summary: 'Get status',
        description: 'Return connection status.',
        'x-openai-isConsequential': false,
        security: [bearer],
        responses: {
          200: {
            description: 'BuildFlow status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    connected: { type: 'boolean' },
                    sourceCount: { type: 'integer' },
                    sourcesAvailable: { type: 'boolean' },
                    activity: activitySchema,
                  },
                  required: ['connected', 'sourceCount', 'sourcesAvailable']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/sources': {
      get: {
        operationId: 'listBuildFlowSources',
        summary: 'List sources',
        description: 'Return sources and readiness.',
        'x-openai-isConsequential': false,
        security: [bearer],
        responses: {
          200: {
            description: 'Source list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    sources: {
                      type: 'array',
                      items: sourceItemSchema
                    },
                    activity: activitySchema,
                  },
                  required: ['status', 'sources']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/context/active': {
      get: {
        operationId: 'getBuildFlowActiveContext',
        summary: 'Get active context',
        description: 'Return active sources.',
        'x-openai-isConsequential': false,
        security: [bearer],
        responses: {
          200: {
            description: 'Active context',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    contextMode: { type: 'string', enum: ['single', 'multi'] },
                    activeSourceIds: { type: 'array', items: { type: 'string' } },
                    sources: { type: 'array', items: sourceItemSchema },
                    activity: activitySchema,
                  },
                  required: ['status', 'contextMode', 'activeSourceIds']
                }
              }
            }
          },
          ...errorResponses
        }
      },
      post: {
        operationId: 'setBuildFlowActiveContext',
        summary: 'Set active context',
        description: 'Set active sources.',
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
                  contextMode: { type: 'string', enum: ['single', 'multi'], description: 'Choose single or multi.' },
                  sourceIds: {
                    type: 'array',
                    description: 'Source ids to activate.',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 10
                  }
                },
                required: ['contextMode', 'sourceIds']
              },
              examples: {
                single: { value: { contextMode: 'single', sourceIds: ['buildflow'] } },
                multi: { value: { contextMode: 'multi', sourceIds: ['buildflow', 'brain'] } }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Active context',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    contextMode: { type: 'string', enum: ['single', 'multi'] },
                    activeSourceIds: { type: 'array', items: { type: 'string' } },
                    sources: { type: 'array', items: sourceItemSchema },
                    activity: activitySchema,
                  },
                  required: ['status', 'contextMode', 'activeSourceIds', 'sources']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/inspect': {
      post: {
        operationId: 'inspectBuildFlowContext',
        summary: 'Inspect context',
        description: 'List files or search.',
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
                  mode: { type: 'string', enum: ['list_files', 'search'], description: 'Choose list_files or search.' },
                  sourceIds: { type: 'array', description: 'Optional sources.', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                  sourceId: { type: 'string', description: 'Optional single source.' },
                  path: { type: 'string', description: 'Folder path for list_files.' },
                  query: { type: 'string', description: 'Search query.' },
                  depth: { type: 'integer', description: 'Tree depth.', default: 3, minimum: 1, maximum: 8 },
                  limit: { type: 'integer', description: 'Max results.', default: 50, minimum: 1, maximum: 200 }
                },
                required: ['mode', 'sourceId']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Inspect result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string' },
                    entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    activity: activitySchema
                  }
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/read-context': {
      post: {
        operationId: 'readBuildFlowContext',
        summary: 'Read files',
        description: 'Read exact files or search then read.',
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
                  mode: { type: 'string', enum: ['read_paths', 'search_and_read'], description: 'Choose read_paths or search_and_read.' },
                  sourceIds: { type: 'array', description: 'Optional sources.', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                  sourceId: { type: 'string', description: 'Optional single source.' },
                  paths: { type: 'array', description: 'Exact paths.', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                  query: { type: 'string', description: 'Search query.' },
                  limit: { type: 'integer', description: 'Max results.', default: 3, minimum: 1, maximum: 5 },
                  maxBytesPerFile: { type: 'integer', description: 'Max bytes per file.', default: 12000, minimum: 1000, maximum: 60000 }
                },
                required: ['mode', 'sourceId']
              },
              examples: {
                readPaths: { value: { mode: 'read_paths', sourceId: 'buildflow', paths: ['README.md'] } },
                searchAndRead: { value: { mode: 'search_and_read', query: 'README', limit: 1, maxBytesPerFile: 2000 } }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Read result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string' },
                    files: { type: 'array', items: fileResultSchema },
                    skipped: { type: 'array', items: skippedReadFileSchema },
                    nextBatch: nextBatchSchema,
                    budgetBytes: { type: 'integer' },
                    returnedBytes: { type: 'integer' },
                    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    activity: activitySchema
                  }
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/run-command': {
      post: {
        operationId: 'runBuildFlowCommand',
        summary: 'Run safe command',
        description: 'Run an allowlisted git/status, validation, or explicit git workflow command. git_push verifies gh auth, normalizes GitHub SSH remotes to HTTPS, runs gh auth setup-git, then pushes without force.',
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
                  sourceId: { type: 'string', description: 'Target source id.' },
                  commandKind: {
                    type: 'string',
                    enum: ['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'git_log_latest', 'git_branch_current', 'verify_public_scope', 'type_check_web', 'type_check_cli', 'verify_write_policy', 'verify_source_reindex_resilience', 'git_diff_cached_stat', 'git_diff_cached_name_only', 'git_add_paths', 'git_commit', 'git_push', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths', 'diagnose_performance', 'local_cli_github_auth_status', 'local_cli_github_repo_view'],
                    description: 'Allowlisted command to run.'
                  },
                  timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds.', minimum: 1000, maximum: 300000 },
                  paths: { type: 'array', description: 'Source-relative explicit paths for git_add_paths, validate_json_files, and security_scan_paths.', items: { type: 'string' }, minItems: 1, maxItems: 50 },
                  packageDir: { type: 'string', description: 'Source-relative package directory containing package.json.' },
                  scriptName: { type: 'string', description: 'Safe package script name for run_package_script.' },
                  marker: { type: 'string', description: 'Safe marker for run_package_test_marker.' },
                  patternSet: { type: 'string', enum: ['forbidden_runtime_execution', 'forbidden_secret_material', 'forbidden_upload_network', 'forbidden_all_high_risk'], description: 'Named security scan pattern set.' },
                  message: { type: 'string', description: 'Single-line git commit message for git_commit.' },
                  body: { type: 'string', description: 'Optional git commit body for git_commit.' },
                  remote: { type: 'string', description: 'Safe remote name for git_push. Defaults to origin.' },
                  branch: { type: 'string', description: 'Safe branch name for git_push. Defaults to current branch.' },
                  confirmedByUser: { type: 'boolean', description: 'Confirm protected destructive command execution.' },
                  confirmationToken: { type: 'string', description: 'Confirmation token returned by a prior needs_confirmation response.' }
                },
                required: ['sourceId', 'commandKind']
              },
              examples: {
                status: { value: { sourceId: 'buildflow', commandKind: 'git_status_short' } },
                typeCheck: { value: { sourceId: 'buildflow', commandKind: 'type_check_web', timeoutMs: 120000 } }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Command result',
            content: {
              'application/json': {
                schema: commandResultSchema
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/agent/start': {
      post: {
        operationId: 'startBuildFlowAgentJob',
        summary: 'Start Agent Mode job',
        description: 'Start the persistent Agent Mode ledger. With hands_off_safe, the local agent immediately runs deterministic server-side preflight validation and updates compact job status; GPT should poll getBuildFlowAgentJob instead of orchestrating those checks.',
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
                  sourceId: { type: 'string', description: 'Target source id.' },
                  goal: { type: 'string', description: 'Implementation goal for the repo-agent loop. Include acceptance criteria and validation expectations when available.' },
                  maxIterations: { type: 'integer', description: 'Maximum repair/validation iterations.', minimum: 1, maximum: 20 },
                  autonomyLevel: { type: 'string', enum: ['supervised', 'hands_off_safe'], description: 'Use hands_off_safe for autonomous work.' },
                  documentationPath: { type: 'string', description: 'Repo-relative progress document path.' },
                  reviewEveryStep: { type: 'boolean', description: 'Review changed files and validation output after every task before continuing.' },
                  autoCommit: { type: 'boolean', description: 'Request automatic git commit after validation passes.' },
                  autoPush: { type: 'boolean', description: 'Request automatic git push after commit and validation pass.' },
                  full: { type: 'boolean', description: 'Return full job state. Usually false for speed.' }
                },
                required: ['sourceId', 'goal']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Agent Mode job',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string' },
                    job: agentJobSchema,
                    activity: activitySchema,
                  },
                  required: ['status', 'job']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/agent/status': {
      post: {
        operationId: 'getBuildFlowAgentJob',
        summary: 'Get or update Agent Mode job',
        description: 'Return or update the dashboard-visible Agent Mode ledger after planning, file changes, validation, commit, push, blockers, and final handoff.',
        'x-openai-isConsequential': false,
        security: [bearer],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  jobId: { type: 'string', description: 'Agent job id. Omit to list jobs.' },
                  status: { type: 'string', enum: ['queued', 'running', 'paused', 'cancelled', 'needs_confirmation', 'blocked', 'completed', 'failed'] },
                  currentIteration: { type: 'integer' },
                  blockedReason: { type: 'string' },
                  requiresConfirmation: { type: 'boolean' },
                  confirmationReason: { type: 'string' },
                  nextActions: { type: 'array', items: { type: 'string' } },
                  summary: { type: 'string' },
                  lastKnownGitStatus: { type: 'string' },
                  roadmapPhases: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Roadmap phases and tasks for the continuous Agent Mode loop.' },
                  activeTaskId: { type: 'string', description: 'Current active roadmap task id.' },
                  completedTaskCount: { type: 'integer', description: 'Completed/skipped roadmap task count.' },
                  full: { type: 'boolean', description: 'Return full job state. Usually false for speed.' },
                  limit: { type: 'integer', description: 'Max jobs when listing.', minimum: 1, maximum: 20 }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Agent Mode job status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string' },
                    job: agentJobSchema,
                    jobs: { type: 'array', items: agentJobSchema },
                    activity: activitySchema,
                  },
                  required: ['status']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/agent/control': {
      post: {
        operationId: 'controlBuildFlowAgentRun',
        summary: 'Control Agent Runtime run',
        description: 'Pause, resume, cancel, or fetch compact events for a local Agent Runtime run.',
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
                  jobId: { type: 'string', description: 'Agent job id.' },
                  action: { type: 'string', enum: ['events', 'pause', 'resume', 'cancel'], description: 'Control action. Use events for compact progress polling.' },
                  reason: { type: 'string', description: 'Optional compact reason for pause, resume, or cancel.' },
                  limit: { type: 'integer', description: 'Max recent events to return.', minimum: 1, maximum: 25 },
                  full: { type: 'boolean', description: 'Return full job state. Usually false for speed.' }
                },
                required: ['jobId']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Agent Runtime control result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string' },
                    action: { type: 'string' },
                    job: agentJobSchema,
                    events: { type: 'array', items: agentEventSchema },
                    returnedBytes: { type: 'integer' },
                    budgetBytes: { type: 'integer' },
                    activity: activitySchema,
                  },
                  required: ['status', 'job', 'events']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/write-artifact': {
      post: {
        operationId: 'writeBuildFlowArtifact',
        summary: 'Write artifact',
        description: 'Create a verified repo-local artifact.',
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
                    sourceId: { type: 'string', description: 'Target source id.' },
                    artifactType: { type: 'string', enum: ['implementation_plan', 'codex_prompt', 'claude_prompt', 'architecture_note', 'research_summary', 'test_plan', 'migration_plan', 'task_brief', 'general_doc'], description: 'Artifact type.' },
                    title: { type: 'string', description: 'Artifact title.' },
                    content: { type: 'string', description: 'Markdown content.' },
                    folder: { type: 'string', description: 'Optional folder.' },
                    filename: { type: 'string', description: 'Optional filename.' },
                    dryRun: { type: 'boolean', description: 'Check whether the artifact write would be allowed without writing.' },
                    preflight: { type: 'boolean', description: 'Alias for dryRun.' }
                  },
                required: ['artifactType', 'title', 'content']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Artifact result',
            content: {
              'application/json': {
                schema: writeResultSchema
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/apply-file-change': {
      post: {
        operationId: 'applyBuildFlowFileChange',
        summary: 'Change file',
        description: 'Append, create, overwrite, or patch a file.',
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
                    changeType: { type: 'string', enum: ['append', 'create', 'overwrite', 'patch', 'delete_file', 'delete_directory', 'move', 'rename', 'mkdir', 'rmdir'], description: 'Choose append, create, overwrite, patch, delete_file, delete_directory, move, rename, mkdir, or rmdir.' },
                    sourceId: { type: 'string', description: 'Target source id.' },
                    path: { type: 'string', description: 'Target file path.' },
                    from: { type: 'string', description: 'Source path for move or rename.' },
                    to: { type: 'string', description: 'Target path for move or rename.' },
                    content: { type: 'string', description: 'Content for append/create/overwrite.' },
                    find: { type: 'string', description: 'Exact text to replace.' },
                    replace: { type: 'string', description: 'Replacement text.' },
                    separator: { type: 'string', description: 'Append separator.', default: '\n\n' },
                    allowMultiple: { type: 'boolean', description: 'Allow multiple patch matches.', default: false },
                    recursive: { type: 'boolean', description: 'Delete recursively when allowed.' },
                    onlyIfEmpty: { type: 'boolean', description: 'Only remove a directory if empty.', default: true },
                    overwrite: { type: 'boolean', description: 'Allow destination overwrite for move or rename.' },
                    createParents: { type: 'boolean', description: 'Create parent directories for move or mkdir.' },
                    createParentDirectories: { type: 'boolean', description: 'Alias for createParents.' },
                    reason: { type: 'string', description: 'Why the file changed.' },
                    dryRun: { type: 'boolean', description: 'Check whether the write would be allowed without writing.' },
                    preflight: { type: 'boolean', description: 'Alias for dryRun.' },
                    confirmedByUser: { type: 'boolean', description: 'Confirm the action when policy requires it.' },
                    confirmationToken: { type: 'string', description: 'Confirmation token returned by preflight.' }
                  },
                required: ['changeType', 'sourceId', 'path', 'reason']
              }
            }
          }
        },
        responses: {
          200: {
            description: 'File change result',
            content: {
              'application/json': {
                schema: writeResultSchema
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/agent/execute-task': {
      post: {
        operationId: 'executeBuildFlowTask',
        summary: 'Execute compound task',
        description: 'Execute steps, validate, commit, and push atomically for a single roadmap task. Reduces 6-8 sequential calls to 1. Steps run sequentially; stops on first failure. Requires an active agent job.',
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
                  jobId: { type: 'string', description: 'Active agent job id.' },
                  sourceId: { type: 'string', description: 'Target source id.' },
                  task: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', description: 'Task id from roadmap.' },
                      title: { type: 'string', description: 'Task title.' },
                      phase: { type: 'string', description: 'Phase name.' }
                    },
                    required: ['id', 'title', 'phase']
                  },
                  steps: {
                    type: 'array',
                    description: 'Ordered steps to execute.',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', enum: ['read_files', 'write_file', 'patch_file', 'append_file', 'delete_file', 'run_command', 'search'], description: 'Step type.' },
                        paths: { type: 'array', items: { type: 'string' }, description: 'Paths for read_files or run_command.' },
                        maxBytesPerFile: { type: 'integer', description: 'Max bytes per file for read_files.' },
                        path: { type: 'string', description: 'Target path for write/patch/append/delete.' },
                        content: { type: 'string', description: 'Content for write/append.' },
                        find: { type: 'string', description: 'Find text for patch.' },
                        replace: { type: 'string', description: 'Replace text for patch.' },
                        allowMultiple: { type: 'boolean', description: 'Allow multiple patch matches.' },
                        separator: { type: 'string', description: 'Separator for append.' },
                        mode: { type: 'string', enum: ['createOnly', 'overwrite'], description: 'Write mode.' },
                        commandKind: { type: 'string', description: 'Command kind for run_command.' },
                        timeoutMs: { type: 'integer', description: 'Timeout for run_command.' },
                        message: { type: 'string', description: 'Message for git_commit via run_command.' },
                        body: { type: 'string', description: 'Body for git_commit via run_command.' },
                        remote: { type: 'string', description: 'Remote for git_push via run_command.' },
                        branch: { type: 'string', description: 'Branch for git_push via run_command.' },
                        query: { type: 'string', description: 'Query for search.' },
                        limit: { type: 'integer', description: 'Limit for search.' }
                      },
                      required: ['type']
                    },
                    minItems: 1,
                    maxItems: 20
                  },
                  validate: {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Validation commands to run after steps succeed.',
                    properties: {
                      commands: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            commandKind: { type: 'string', description: 'Validation command kind.' },
                            timeoutMs: { type: 'integer', description: 'Timeout.' },
                            paths: { type: 'array', items: { type: 'string' }, description: 'Paths for validation.' }
                          },
                          required: ['commandKind']
                        },
                        minItems: 1,
                        maxItems: 5
                      }
                    },
                    required: ['commands']
                  },
                  autoCommit: {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Auto-commit after validation passes.',
                    properties: {
                      message: { type: 'string', description: 'Commit message.' },
                      body: { type: 'string', description: 'Optional commit body.' },
                      paths: { type: 'array', items: { type: 'string' }, description: 'Explicit paths to stage.', minItems: 1, maxItems: 50 }
                    },
                    required: ['message', 'paths']
                  },
                  autoPush: {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Auto-push after commit succeeds.',
                    properties: {
                      remote: { type: 'string', description: 'Remote name. Defaults to origin.' },
                      branch: { type: 'string', description: 'Branch name. Defaults to current.' }
                    }
                  }
                },
                required: ['jobId', 'sourceId', 'task', 'steps']
              },
              examples: {
                patchAndValidate: {
                  value: {
                    jobId: 'job-abc123',
                    sourceId: 'buildflow',
                    task: { id: 'task-1', title: 'Fix type error', phase: 'phase-1' },
                    steps: [
                      { type: 'read_files', paths: ['src/index.ts'] },
                      { type: 'patch_file', path: 'src/index.ts', find: 'old code', replace: 'new code' }
                    ],
                    validate: { commands: [{ commandKind: 'type_check_web', timeoutMs: 60000 }] },
                    autoCommit: { message: 'fix: resolve type error in index', paths: ['src/index.ts'] },
                    autoPush: {}
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Task execution result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: ['completed', 'failed', 'partial'] },
                    completedPhase: { type: 'string', enum: ['steps', 'validation', 'commit', 'push', 'none'] },
                    failedAt: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        phase: { type: 'string' },
                        stepIndex: { type: 'integer' },
                        error: { type: 'string' }
                      },
                      required: ['phase', 'error']
                    },
                    stepResults: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                          type: { type: 'string' },
                          status: { type: 'string', enum: ['ok', 'failed'] },
                          data: { type: 'object', additionalProperties: true },
                          error: { type: 'string' }
                        },
                        required: ['type', 'status']
                      }
                    },
                    validationResults: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          commandKind: { type: 'string' },
                          status: { type: 'string' },
                          durationMs: { type: 'integer' },
                          stdout: { type: 'string' },
                          stderr: { type: 'string' }
                        },
                        required: ['commandKind', 'status', 'durationMs']
                      }
                    },
                    commitResult: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        status: { type: 'string' },
                        stdout: { type: 'string' }
                      },
                      required: ['status']
                    },
                    pushResult: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        status: { type: 'string' },
                        stdout: { type: 'string' }
                      },
                      required: ['status']
                    },
                    gitStatus: { type: 'string' },
                    durationMs: { type: 'integer' },
                    activity: activitySchema
                  },
                  required: ['status', 'completedPhase', 'stepResults', 'durationMs']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    '/api/actions/batch': {
      post: {
        operationId: 'batchBuildFlowOperations',
        summary: 'Batch operations',
        description: 'Execute 2-5 agent operations in a single request. Each operation specifies an agent endpoint and body. Results arrive in order. Use for combining sequential actions like search + read, git_status + git_diff, or sources + active context.',
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
                  operations: {
                    type: 'array',
                    description: 'Operations to execute in order (1-5).',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        endpoint: { type: 'string', description: 'Agent endpoint path (e.g. /api/search, /api/read-files).' },
                        body: { type: 'object', additionalProperties: true, description: 'Request body for the operation.' }
                      },
                      required: ['endpoint', 'body']
                    },
                    minItems: 1,
                    maxItems: 5
                  }
                },
                required: ['operations']
              },
              examples: {
                searchAndRead: {
                  value: {
                    operations: [
                      { endpoint: '/api/search', body: { query: 'README', limit: 3 } },
                      { endpoint: '/api/read-files', body: { paths: ['README.md'] } }
                    ]
                  }
                },
                gitPreCommit: {
                  value: {
                    operations: [
                      { endpoint: '/api/commands/run', body: { sourceId: 'buildflow', commandKind: 'git_status_short' } },
                      { endpoint: '/api/commands/run', body: { sourceId: 'buildflow', commandKind: 'git_diff_stat' } }
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Batch results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          endpoint: { type: 'string' },
                          status: { type: 'integer' },
                          data: { type: 'object', additionalProperties: true }
                        },
                        required: ['endpoint', 'status', 'data']
                      }
                    }
                  },
                  required: ['status', 'results']
                }
              }
            }
          },
          ...errorResponses
        }
      }
    }
  }
}

const compactOpenapi = compactOpenApiDoc(openapi)

export async function GET() {
  return NextResponse.json(compactOpenapi, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  })
}

import { NextResponse } from 'next/server'

const bearer = { bearerAuth: [] }

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
    writePolicy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allowCreate: { type: 'boolean' },
        allowOverwrite: { type: 'boolean' },
        allowAppend: { type: 'boolean' },
        allowPatch: { type: 'boolean' },
        allowCreateParentDirectories: { type: 'boolean' },
        allowDelete: { type: 'boolean' },
        allowDeleteDirectory: { type: 'boolean' },
        allowMove: { type: 'boolean' },
        allowRename: { type: 'boolean' },
        allowMkdir: { type: 'boolean' },
        allowRmdir: { type: 'boolean' },
        recursiveDeleteRequiresConfirmation: { type: 'boolean' },
        maxRecursiveDeleteFilesWithoutConfirmation: { type: 'integer' },
        allowedRoots: { type: 'array', items: { type: 'string' } },
        blockedGlobs: { type: 'array', items: { type: 'string' } },
        blockedWriteGlobs: { type: 'array', items: { type: 'string' } },
        generatedDeleteAllowedGlobs: { type: 'array', items: { type: 'string' } },
        confirmationRequiredGlobs: { type: 'array', items: { type: 'string' } },
        protectedWriteGlobs: { type: 'array', items: { type: 'string' } },
        protectedGlobs: { type: 'array', items: { type: 'string' } },
        blockedContentPatterns: { type: 'array', items: { type: 'string' } },
        binaryWriteBlocked: { type: 'boolean' },
        binaryDeleteAllowedWithConfirmation: { type: 'boolean' },
        maxWriteBytes: { type: 'integer' },
        maxCreateBytes: { type: 'integer' },
        maxOverwriteBytes: { type: 'integer' },
        maxPatchTargetBytes: { type: 'integer' }
      }
    }
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
    goal: { type: 'string' },
    mode: { type: 'string', enum: ['repo_agent'] },
    status: { type: 'string', enum: ['queued', 'running', 'needs_confirmation', 'blocked', 'completed', 'failed'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    maxIterations: { type: 'integer' },
    currentIteration: { type: 'integer' },
    autonomyLevel: { type: 'string', enum: ['supervised', 'hands_off_safe'] },
    documentationPath: { type: 'string' },
    reviewEveryStep: { type: 'boolean' },
    autoCommit: { type: 'boolean' },
    autoPush: { type: 'boolean' },
    requiresConfirmation: { type: 'boolean' },
    confirmationReason: { type: 'string' },
    blockedReason: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
    nextActions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    handoffPath: { type: 'string' },
    resumeInstructions: { type: 'array', items: { type: 'string' } },
    fallbackPrompt: { type: 'string' },
    lastKnownGitStatus: { type: 'string' }
  },
  required: ['id', 'sourceId', 'goal', 'mode', 'status', 'createdAt', 'updatedAt', 'maxIterations', 'currentIteration', 'autonomyLevel', 'documentationPath', 'reviewEveryStep', 'autoCommit', 'autoPush', 'requiresConfirmation', 'steps', 'nextActions', 'summary']
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

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'BuildFlow API',
    version: '3.0.0',
    description: 'BuildFlow GPT actions for status, sources, context, inspection, reading, and verified writes.'
  },
  servers: [
    {
      url: process.env.PUBLIC_BASE_URL || process.env.LOCAL_DASHBOARD_BASE_URL || 'https://buildflow.prochat.tools',
      description: 'BuildFlow public endpoint'
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
                    activity: activitySchema
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
                    activity: activitySchema
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
                    activity: activitySchema
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
        'x-openai-isConsequential': true,
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
                    activity: activitySchema
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
                required: ['mode']
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
                required: ['mode']
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
        description: 'Run an allowlisted git/status, validation, or explicit git workflow command inside a selected source.',
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
                    enum: ['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'git_log_latest', 'git_branch_current', 'verify_public_scope', 'type_check_web', 'type_check_cli', 'verify_write_policy', 'verify_source_reindex_resilience', 'git_diff_cached_stat', 'git_diff_cached_name_only', 'git_add_paths', 'git_commit', 'git_push', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths'],
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
                  confirmedByUser: { type: 'boolean', description: 'Confirm confirmation-gated command execution.' },
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
        description: 'Start a repo-agnostic hands-off implementation loop for one source. The GPT continues the loop with existing read/write/command actions and stops only for policy blocks or confirmations.',
        'x-openai-isConsequential': true,
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
                  goal: { type: 'string', description: 'Implementation goal for the repo-agent loop.' },
                  maxIterations: { type: 'integer', description: 'Maximum repair/validation iterations.', minimum: 1, maximum: 20 },
                  autonomyLevel: { type: 'string', enum: ['supervised', 'hands_off_safe'], description: 'Agentic execution mode. hands_off_safe continues without user interaction until blocked or confirmation is required.' },
                  documentationPath: { type: 'string', description: 'Repo-relative progress document path for the goal/task/review loop.' },
                  reviewEveryStep: { type: 'boolean', description: 'Review changed files and validation output after every task before continuing.' },
                  autoCommit: { type: 'boolean', description: 'Request commit flow when work is complete; confirmation still required.' },
                  autoPush: { type: 'boolean', description: 'Request push flow when work is complete; confirmation still required.' }
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
                    activity: activitySchema
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
        description: 'Return Agent Mode job state or update safe progress fields after a step in the hands-off loop.',
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
                  status: { type: 'string', enum: ['queued', 'running', 'needs_confirmation', 'blocked', 'completed', 'failed'] },
                  currentIteration: { type: 'integer' },
                  blockedReason: { type: 'string' },
                  requiresConfirmation: { type: 'boolean' },
                  confirmationReason: { type: 'string' },
                  nextActions: { type: 'array', items: { type: 'string' } },
                  summary: { type: 'string' },
                  lastKnownGitStatus: { type: 'string' }
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
                    activity: activitySchema
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
    }
  }
}

export async function GET() {
  return NextResponse.json(openapi)
}

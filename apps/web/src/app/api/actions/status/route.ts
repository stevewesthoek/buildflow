import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeActionGET } from '@/lib/actions/transport'
import { GPT_ACTION_RESPONSE_BYTE_LIMIT } from '@/lib/actions/payload-budget'
import { listWorkbenchSources, getWorkbenchActiveContext, setWorkbenchActiveContext, unwrapActionError } from '@/lib/actions/gpt'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'
import { getBuildSha, getBuildTimestamp } from '@/lib/env-compat'
import { recordRuntimeResourceTelemetry } from '@/lib/actions/runtime-tunnel-telemetry'
import { readCompactSloHealth, recordCompactStatusSloTelemetry } from '@/lib/actions/slo-health'

export const dynamic = 'force-dynamic'
export const revalidate = 0

let activeRequests = 0
const STATUS_RESPONSE_BUDGET_BYTES = GPT_ACTION_RESPONSE_BYTE_LIMIT
const WEB_PROCESS_STARTED_AT = new Date().toISOString()
const WEB_PACKAGE_VERSION = process.env.WORKBENCH_PACKAGE_VERSION || process.env.npm_package_version || 'unknown'

function readWebBuildId(): string | undefined {
  try {
    return fs.readFileSync(path.join(process.cwd(), '.next/BUILD_ID'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function ensureSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.map(item => ensureSerializable(item))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith('_') || key === 'diagnostics' || key === 'activity') continue
      const safe = ensureSerializable(val)
      if (safe !== undefined) result[key] = safe
    }
    return result
  }
  return undefined
}

export async function GET(request: NextRequest) {
  const requestStartedAt = Date.now()
  activeRequests++
  try {
    const include = request.nextUrl.searchParams.get('include')
    const validInclude = include === 'sources' || include === 'active' || include === 'all'

    return withGptActionDeadline({
      operationId: 'getWorkbenchStatus',
      route: '/api/actions/status',
      deadlineMs: GPT_ACTION_DEADLINES_MS.status,
      suggestedNextAction: 'Retry status after checking the local BuildFlow stack.'
    }, async (deadline) => {
      deadline.setPhase('authenticate')
      const auth = checkActionAuth(request)
      deadline.markStage('authentication_complete', { authValid: auth.valid })
      if (!auth.valid) return auth.error!

      deadline.setPhase('check_status')
      deadline.addDiagnostics({ mode: validInclude ? include : 'status' })

      const payload: Record<string, unknown> = {
        ok: true,
        connected: true
      }

      if (!validInclude) {
        await executeActionGET('/api/status', auth.bearerToken, {
          signal: deadline.signal,
          timeoutMs: deadline.transportTimeoutMs(3500),
          diagnostics: deadline.diagnostics({ phase: 'status_probe' })
        })
      }

      if (validInclude && (include === 'sources' || include === 'all')) {
        try {
          deadline.setPhase('list_sources')
          const sourcesData = await listWorkbenchSources(auth.bearerToken, {
            signal: deadline.signal,
            timeoutMs: deadline.transportTimeoutMs(2500),
            diagnostics: deadline.diagnostics({ phase: 'list_sources' })
          })
          const rawSources = (sourcesData as Record<string, unknown>).sources
          if (Array.isArray(rawSources)) {
            payload.sources = rawSources
              .filter((s: unknown) => {
                const src = s as Record<string, unknown>
                return src.enabled === true || src.enabled !== false
              })
              .map((s: unknown) => {
                const src = s as Record<string, unknown>
                return {
                  id: typeof src.id === 'string' ? src.id : '',
                  label: typeof src.label === 'string' ? src.label : '',
                  active: src.active === true
                }
              })
              .slice(0, 20)
          }
        } catch (e) {
          payload.sources_error = e instanceof Error ? e.message : 'Failed to list sources'
        }
      }

      if (validInclude && (include === 'active' || include === 'all')) {
        try {
          deadline.setPhase('get_active_context')
          const activeData = await getWorkbenchActiveContext(auth.bearerToken, {
            signal: deadline.signal,
            timeoutMs: deadline.transportTimeoutMs(1500),
            diagnostics: deadline.diagnostics({ phase: 'get_active_context' })
          })
          const normalized = activeData as Record<string, unknown>
          if (Array.isArray(normalized.activeSourceIds)) {
            payload.activeSourceIds = normalized.activeSourceIds
              .filter((id: unknown) => typeof id === 'string')
              .slice(0, 20)
          }
          if (normalized.contextMode === 'single' || normalized.contextMode === 'multi') {
            payload.contextMode = normalized.contextMode
          }
        } catch (e) {
          payload.context_error = e instanceof Error ? e.message : 'Failed to get active context'
        }
      }

      const mem = process.memoryUsage()
      recordRuntimeResourceTelemetry({
        heapBytes: mem.heapUsed,
        rssBytes: mem.rss,
        activeRequests
      })
      payload.runtime = {
        activeRequests,
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        rssMb: Math.round(mem.rss / 1_048_576),
        health: readCompactSloHealth(),
        service: {
          role: 'web',
          packageVersion: WEB_PACKAGE_VERSION,
          gitCommit: getBuildSha(),
          buildTimestamp: getBuildTimestamp(),
          processStartedAt: WEB_PROCESS_STARTED_AT,
          pid: process.pid,
          webBuildId: process.env.WORKBENCH_WEB_BUILD_ID || readWebBuildId() || 'unknown'
        }
      }

      payload.activity = {
        version: WEB_PACKAGE_VERSION,
        operationId: 'getWorkbenchStatus',
        phase: 'completed',
        actionLabel: 'Checked BuildFlow status',
        userMessage: validInclude ? `BuildFlow status OK (${include} included).` : 'BuildFlow is connected.',
        riskLevel: 'low',
        requiresConfirmation: false,
        verified: true,
        nextStep: 'Choose a sourceId and use focused read modes.'
      }

      const safePayload = ensureSerializable(payload) as Record<string, unknown>
      const payloadBytes = Buffer.byteLength(JSON.stringify(safePayload), 'utf8')
      recordCompactStatusSloTelemetry({
        durationMs: Date.now() - requestStartedAt,
        responseBytes: payloadBytes
      })

      if (payloadBytes > STATUS_RESPONSE_BUDGET_BYTES) {
        return NextResponse.json({
          ok: false,
          connected: true,
          error: {
            code: 'STATUS_PAYLOAD_EXCEEDS_BUDGET',
            message: `Status payload exceeds ${STATUS_RESPONSE_BUDGET_BYTES} bytes (was ${payloadBytes} bytes)`,
            recovery: ['Retry with fewer sources', 'Use a narrower include parameter', 'Check local BuildFlow logs']
          },
          activity: {
            version: WEB_PACKAGE_VERSION,
            operationId: 'getWorkbenchStatus',
            phase: 'failed',
            actionLabel: 'BuildFlow status check failed',
            userMessage: 'Status response was too large; check local BuildFlow for issues.',
            riskLevel: 'low',
            requiresConfirmation: false,
            verified: false,
            nextStep: 'Retry status after investigating BuildFlow logs.'
          }
        }, { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } })
      }

      return NextResponse.json(safePayload, {
        status: 200,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
      })
    }).catch((err) => {
      const { error, status } = unwrapActionError(err, 'status error')
      const safe = ensureSerializable(error)
      return NextResponse.json(
        safe && typeof safe === 'object' ? safe : { error: 'Unknown status error', requestId: 'unknown' },
        { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
      )
    })
  } finally {
    activeRequests--
  }
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json().catch(() => ({}))
    const data = await setWorkbenchActiveContext(body, auth.bearerToken) as Record<string, unknown>
    const safeData = ensureSerializable(data) as Record<string, unknown>
    return NextResponse.json({
      ok: true,
      contextMode: safeData.contextMode,
      activeSourceIds: safeData.activeSourceIds
    }, { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'set-context error')
    const safe = ensureSerializable(error)
    return NextResponse.json(
      safe && typeof safe === 'object' ? safe : { error: 'Unknown error', status: 'error' },
      { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    )
  }
}

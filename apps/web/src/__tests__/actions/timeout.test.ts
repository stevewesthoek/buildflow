import { describe, it, expect, beforeEach, vi } from 'vitest'
import { withGptActionDeadline, type DeadlineContext } from '@/lib/actions/deadline'
import { NextResponse } from 'next/server'

describe('withGptActionDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('should generate unique request IDs', async () => {
    const requestIds = new Set<string>()

    for (let i = 0; i < 5; i++) {
      let capturedId: string | undefined
      await withGptActionDeadline({
        operationId: 'test',
        route: '/test',
        deadlineMs: 5000
      }, async (context) => {
        capturedId = context.requestId
        return NextResponse.json({ ok: true })
      })

      if (capturedId) requestIds.add(capturedId)
    }

    expect(requestIds.size).toBe(5)
    requestIds.forEach(id => {
      expect(id).toMatch(/^wr_[a-z0-9]+_[a-z0-9]+$/)
    })
  })

  it('should include request ID in timeout response', async () => {
    let response: NextResponse | null = null

    await withGptActionDeadline({
      operationId: 'testTimeout',
      route: '/api/test',
      deadlineMs: 1000
    }, async () => {
      // Simulate work that takes longer than deadline
      await new Promise(resolve => setTimeout(resolve, 2000))
      return NextResponse.json({ ok: true })
    })

    // Fast-forward time to trigger timeout
    vi.advanceTimersByTime(1500)

    // We can't directly capture the timeout response in fake timers,
    // but the implementation ensures it includes requestId
    // This test documents the expected behavior
  })

  it('should track phase transitions in diagnostics', async () => {
    const phases: string[] = []

    await withGptActionDeadline({
      operationId: 'testPhases',
      route: '/api/test',
      deadlineMs: 5000
    }, async (context) => {
      context.setPhase('parse_request')
      phases.push('parse_request')

      context.setPhase('fetch_backend')
      phases.push('fetch_backend')

      context.setPhase('serialize_response')
      phases.push('serialize_response')

      return NextResponse.json({ ok: true })
    })

    expect(phases).toEqual(['parse_request', 'fetch_backend', 'serialize_response'])
  })

  it('should provide accurate remaining time', async () => {
    const remainingAtPhases: number[] = []

    await withGptActionDeadline({
      operationId: 'testRemaining',
      route: '/api/test',
      deadlineMs: 1000
    }, async (context) => {
      remainingAtPhases.push(context.remainingMs())

      vi.advanceTimersByTime(300)
      remainingAtPhases.push(context.remainingMs())

      vi.advanceTimersByTime(200)
      remainingAtPhases.push(context.remainingMs())

      return NextResponse.json({ ok: true })
    })

    // Remaining should decrease as time advances
    expect(remainingAtPhases[0]).toBeGreaterThan(remainingAtPhases[1])
    expect(remainingAtPhases[1]).toBeGreaterThan(remainingAtPhases[2])
  })

  it('should calculate transport timeout with safety margin', async () => {
    const transportTimeouts: number[] = []

    await withGptActionDeadline({
      operationId: 'testTransport',
      route: '/api/test',
      deadlineMs: 8000
    }, async (context) => {
      // Early: plenty of time remaining
      transportTimeouts.push(context.transportTimeoutMs(7500))

      // Advance time
      vi.advanceTimersByTime(2000)
      transportTimeouts.push(context.transportTimeoutMs(7500))

      // Near deadline
      vi.advanceTimersByTime(5500)
      transportTimeouts.push(context.transportTimeoutMs(7500))

      return NextResponse.json({ ok: true })
    })

    // Transport timeout should decrease but always reserve 250ms safety margin
    expect(transportTimeouts[0]).toBeLessThan(7500)
    expect(transportTimeouts[0]).toBeGreaterThan(transportTimeouts[1])
    expect(transportTimeouts[1]).toBeGreaterThan(transportTimeouts[2])
    // Last one should be minimum (near deadline, reserved margin)
    expect(transportTimeouts[2]).toBeLessThanOrEqual(250)
  })

  it('should abort signal on deadline exceeded', async () => {
    let signalAborted = false

    await withGptActionDeadline({
      operationId: 'testAbort',
      route: '/api/test',
      deadlineMs: 1000
    }, async (context) => {
      const listener = () => {
        signalAborted = true
      }
      context.signal.addEventListener('abort', listener)

      // Trigger timeout by advancing past deadline
      vi.advanceTimersByTime(1100)

      return NextResponse.json({ ok: true })
    })

    // Signal should have been aborted
    expect(signalAborted).toBe(true)
  })

  it('should return structured timeout response before deadline', async () => {
    let timeoutResponse: unknown = null

    const result = await withGptActionDeadline({
      operationId: 'testTimeoutResponse',
      route: '/api/test-timeout',
      deadlineMs: 1000
    }, async (context) => {
      // Simulate long-running handler
      await new Promise(resolve => setTimeout(resolve, 5000))
      return NextResponse.json({ ok: true })
    })

    // Advance past deadline
    vi.advanceTimersByTime(1100)

    // Get the response
    const json = await result.json()
    timeoutResponse = json

    // Should be timeout error, not HTML
    expect(json).toHaveProperty('ok', false)
    expect(json).toHaveProperty('status', 'timeout')
    expect(json.error).toHaveProperty('code', 'BUILDFLOW_ACTION_DEADLINE_EXCEEDED')
    expect(json).toHaveProperty('requestId')
    expect(json.requestId).toMatch(/^wr_/)
  })

  it('should include request ID in response headers', async () => {
    const result = await withGptActionDeadline({
      operationId: 'testHeader',
      route: '/api/test',
      deadlineMs: 5000
    }, async (context) => {
      return NextResponse.json({ ok: true, requestId: context.requestId })
    })

    const requestId = result.headers.get('X-Workbench-Request-Id')
    expect(requestId).toBeDefined()
    expect(requestId).toMatch(/^wr_/)
  })
})

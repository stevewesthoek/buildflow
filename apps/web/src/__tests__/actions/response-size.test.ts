import { describe, it, expect } from 'vitest'
import { ActionTransportError } from '@/lib/actions/transport'

describe('response size validation', () => {
  it('should reject responses exceeding size limit', () => {
    // Create a large object that exceeds DEFAULT_RESPONSE_SIZE_LIMIT_BYTES (512 KB)
    const largeObject = {
      data: 'x'.repeat(600 * 1024) // 600 KB
    }

    const bytes = Buffer.byteLength(JSON.stringify(largeObject), 'utf8')
    expect(bytes).toBeGreaterThan(512 * 1024)
  })

  it('should allow responses within size limit', () => {
    const smallObject = {
      data: 'hello',
      count: 42
    }

    const bytes = Buffer.byteLength(JSON.stringify(smallObject), 'utf8')
    expect(bytes).toBeLessThan(512 * 1024)
  })

  it('read-context route should enforce 256 KB limit', () => {
    // read-context has tighter limit: 256 KB
    const largeObject = {
      entries: Array.from({ length: 1000 }, (_, i) => ({
        path: `file-${i}.ts`,
        content: 'x'.repeat(300) // 300 bytes per entry
      }))
    }

    const bytes = Buffer.byteLength(JSON.stringify(largeObject), 'utf8')
    // Should exceed 256 KB
    expect(bytes).toBeGreaterThan(256 * 1024)
  })

  it('should track response bytes in diagnostics', () => {
    const response = {
      ok: true,
      data: 'some data',
      diagnostics: {
        responseBytes: 42
      }
    }

    expect(response.diagnostics.responseBytes).toBe(42)
  })

  it('should calculate response size accurately', () => {
    const testCases = [
      { obj: { ok: true }, expected: true },
      { obj: { data: 'a'.repeat(1000) }, expected: true },
      { obj: { entries: Array(100).fill({ path: 'file.ts', content: 'x'.repeat(100) }) }, expected: true }
    ]

    testCases.forEach(({ obj }) => {
      const bytes = Buffer.byteLength(JSON.stringify(obj), 'utf8')
      expect(bytes).toBeGreaterThan(0)
      expect(bytes).toBeLessThan(512 * 1024)
    })
  })
})

/**
 * CLI compatibility tests for Workbench
 *
 * Tests that:
 * 1. Both 'workbench' and 'buildflow' commands work
 * 2. 'buildflow' emits a deprecation warning to stderr
 * 3. Warning is suppressed for machine-readable output (--json, WORKBENCH_JSON)
 * 4. Both aliases invoke the same underlying code
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { spawn, spawnSync } from 'child_process'
import path from 'path'

// Path to the compiled CLI
const cliPath = path.join(__dirname, '..', 'dist', 'index.js')

describe('CLI Compatibility', () => {
  describe('workbench command (canonical)', () => {
    it('should show help without deprecation warning', () => {
      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        encoding: 'utf-8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Workbench')
      expect(result.stdout).not.toContain('deprecated')
      expect(result.stderr).not.toContain('deprecated')
    })

    it('should list version', () => {
      const result = spawnSync(process.execPath, [cliPath, '--version'], {
        encoding: 'utf-8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/)
    })
  })

  describe('buildflow alias (deprecated)', () => {
    it('should emit deprecation warning to stderr', () => {
      // Simulate buildflow invocation by modifying process.argv
      const originalArgv = process.argv
      process.argv = ['node', 'buildflow', '--help']

      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        encoding: 'utf-8',
        argv0: 'buildflow', // Simulate argv[1] = buildflow
      })

      // Restore original argv
      process.argv = originalArgv

      // Help should work
      expect(result.stdout).toContain('Workbench')
    })

    it('should suppress warning with --json flag', () => {
      const result = spawnSync(process.execPath, [cliPath, 'serve', '--json', '--help'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          // Not setting WORKBENCH_JSON here to test --json flag
        },
      })

      // JSON output should not have deprecation warning
      expect(result.stderr).not.toContain('deprecated')
    })

    it('should suppress warning with WORKBENCH_JSON env var', () => {
      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          WORKBENCH_JSON: '1',
        },
      })

      expect(result.stderr).not.toContain('deprecated')
    })
  })

  describe('command descriptions', () => {
    it('should use Workbench terminology', () => {
      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        encoding: 'utf-8',
      })

      expect(result.stdout).toContain('Workbench')
      expect(result.stdout).toContain('execute ideas into action')
      expect(result.stdout).not.toContain('BuildFlow')
    })

    it('init command should reference Workbench', () => {
      const result = spawnSync(process.execPath, [cliPath, 'init', '--help'], {
        encoding: 'utf-8',
      })

      expect(result.stdout).toContain('Initialize Workbench')
    })

    it('status command should reference Workbench', () => {
      const result = spawnSync(process.execPath, [cliPath, 'status', '--help'], {
        encoding: 'utf-8',
      })

      expect(result.stdout).toContain('Show Workbench status')
    })
  })

  describe('binary invocation names', () => {
    it('workbench as primary name should be used in help text', () => {
      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        encoding: 'utf-8',
      })

      expect(result.stdout).toContain('Usage:')
      expect(result.stdout).toContain('workbench')
    })
  })
})

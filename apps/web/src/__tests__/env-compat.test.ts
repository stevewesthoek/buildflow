import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'
import {
  getBackendMode,
  getActionToken,
  getWebServerMode,
  getAgentServerMode,
  getBuildSha,
  getBuildTimestamp,
  getActionDiagnostics,
  getApiBaseUrl
} from '../lib/env-compat'

describe('Environment Compatibility Layer', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('getBackendMode', () => {
    it('uses WORKBENCH_BACKEND_MODE when set', () => {
      delete process.env.BUILDFLOW_BACKEND_MODE
      process.env.WORKBENCH_BACKEND_MODE = 'relay-agent'
      assert.equal(getBackendMode(), 'relay-agent')
    })

    it('falls back to BUILDFLOW_BACKEND_MODE when canonical unset', () => {
      delete process.env.WORKBENCH_BACKEND_MODE
      process.env.BUILDFLOW_BACKEND_MODE = 'relay-agent'
      assert.equal(getBackendMode(), 'relay-agent')
    })

    it('uses canonical when both set identically', () => {
      process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
      process.env.BUILDFLOW_BACKEND_MODE = 'direct-agent'
      assert.equal(getBackendMode(), 'direct-agent')
    })

    it('throws when canonical and legacy conflict', () => {
      process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
      process.env.BUILDFLOW_BACKEND_MODE = 'relay-agent'
      assert.throws(
        () => getBackendMode(),
        /Conflicting environment variables/
      )
    })

    it('throws on invalid canonical value', () => {
      delete process.env.BUILDFLOW_BACKEND_MODE
      process.env.WORKBENCH_BACKEND_MODE = 'invalid-mode'
      assert.throws(
        () => getBackendMode(),
        /Invalid WORKBENCH_BACKEND_MODE/
      )
    })

    it('defaults to direct-agent when neither set', () => {
      delete process.env.WORKBENCH_BACKEND_MODE
      delete process.env.BUILDFLOW_BACKEND_MODE
      assert.equal(getBackendMode(), 'direct-agent')
    })
  })

  describe('getActionToken', () => {
    it('uses WORKBENCH_ACTION_TOKEN when set', () => {
      delete process.env.BUILDFLOW_ACTION_TOKEN
      process.env.WORKBENCH_ACTION_TOKEN = 'canonical-token'
      assert.equal(getActionToken(), 'canonical-token')
    })

    it('falls back to BUILDFLOW_ACTION_TOKEN when canonical unset', () => {
      delete process.env.WORKBENCH_ACTION_TOKEN
      process.env.BUILDFLOW_ACTION_TOKEN = 'legacy-token'
      assert.equal(getActionToken(), 'legacy-token')
    })

    it('uses canonical when both set identically', () => {
      process.env.WORKBENCH_ACTION_TOKEN = 'same-token'
      process.env.BUILDFLOW_ACTION_TOKEN = 'same-token'
      assert.equal(getActionToken(), 'same-token')
    })

    it('throws when canonical and legacy tokens conflict', () => {
      process.env.WORKBENCH_ACTION_TOKEN = 'canonical-token'
      process.env.BUILDFLOW_ACTION_TOKEN = 'legacy-token'
      assert.throws(
        () => getActionToken(),
        /Conflicting environment variables/
      )
    })

    it('returns null when neither set', () => {
      delete process.env.WORKBENCH_ACTION_TOKEN
      delete process.env.BUILDFLOW_ACTION_TOKEN
      assert.equal(getActionToken(), null)
    })

    it('does not expose token value in error messages', () => {
      process.env.WORKBENCH_ACTION_TOKEN = 'secret-canonical-token-12345'
      process.env.BUILDFLOW_ACTION_TOKEN = 'secret-legacy-token-67890'
      try {
        getActionToken()
        assert.fail('expected error')
      } catch (err) {
        const errorMsg = String(err)
        assert(!errorMsg.includes('secret-canonical-token-12345'), 'error should not contain canonical token')
        assert(!errorMsg.includes('secret-legacy-token-67890'), 'error should not contain legacy token')
        assert(errorMsg.includes('WORKBENCH_ACTION_TOKEN'), 'error should name canonical var')
        assert(errorMsg.includes('BUILDFLOW_ACTION_TOKEN'), 'error should name legacy var')
      }
    })
  })

  describe('getWebServerMode', () => {
    it('uses WORKBENCH_WEB_SERVER_MODE when set', () => {
      delete process.env.BUILDFLOW_WEB_SERVER_MODE
      process.env.WORKBENCH_WEB_SERVER_MODE = 'dev'
      assert.equal(getWebServerMode(), 'dev')
    })

    it('falls back to BUILDFLOW_WEB_SERVER_MODE when canonical unset', () => {
      delete process.env.WORKBENCH_WEB_SERVER_MODE
      process.env.BUILDFLOW_WEB_SERVER_MODE = 'start'
      assert.equal(getWebServerMode(), 'start')
    })

    it('defaults to production when neither set', () => {
      delete process.env.WORKBENCH_WEB_SERVER_MODE
      delete process.env.BUILDFLOW_WEB_SERVER_MODE
      assert.equal(getWebServerMode(), 'production')
    })

    it('throws on invalid mode', () => {
      delete process.env.BUILDFLOW_WEB_SERVER_MODE
      process.env.WORKBENCH_WEB_SERVER_MODE = 'invalid'
      assert.throws(
        () => getWebServerMode(),
        /Invalid WORKBENCH_WEB_SERVER_MODE/
      )
    })
  })

  describe('getAgentServerMode', () => {
    it('uses WORKBENCH_AGENT_SERVER_MODE when set', () => {
      delete process.env.BUILDFLOW_AGENT_SERVER_MODE
      process.env.WORKBENCH_AGENT_SERVER_MODE = 'production'
      assert.equal(getAgentServerMode(), 'production')
    })

    it('falls back to BUILDFLOW_AGENT_SERVER_MODE when canonical unset', () => {
      delete process.env.WORKBENCH_AGENT_SERVER_MODE
      process.env.BUILDFLOW_AGENT_SERVER_MODE = 'production'
      assert.equal(getAgentServerMode(), 'production')
    })

    it('defaults to dev when neither set', () => {
      delete process.env.WORKBENCH_AGENT_SERVER_MODE
      delete process.env.BUILDFLOW_AGENT_SERVER_MODE
      assert.equal(getAgentServerMode(), 'dev')
    })

    it('throws on invalid mode', () => {
      delete process.env.BUILDFLOW_AGENT_SERVER_MODE
      process.env.WORKBENCH_AGENT_SERVER_MODE = 'invalid'
      assert.throws(
        () => getAgentServerMode(),
        /Invalid WORKBENCH_AGENT_SERVER_MODE/
      )
    })
  })

  describe('getBuildSha', () => {
    it('uses WORKBENCH_BUILD_SHA when set', () => {
      delete process.env.BUILDFLOW_BUILD_SHA
      process.env.WORKBENCH_BUILD_SHA = 'abc123'
      assert.equal(getBuildSha(), 'abc123')
    })

    it('falls back to BUILDFLOW_BUILD_SHA when canonical unset', () => {
      delete process.env.WORKBENCH_BUILD_SHA
      process.env.BUILDFLOW_BUILD_SHA = 'def456'
      assert.equal(getBuildSha(), 'def456')
    })

    it('defaults to unknown when neither set', () => {
      delete process.env.WORKBENCH_BUILD_SHA
      delete process.env.BUILDFLOW_BUILD_SHA
      assert.equal(getBuildSha(), 'unknown')
    })
  })

  describe('getBuildTimestamp', () => {
    it('uses WORKBENCH_BUILD_TIMESTAMP when set', () => {
      delete process.env.BUILDFLOW_BUILD_TIMESTAMP
      process.env.WORKBENCH_BUILD_TIMESTAMP = '2026-06-15T10:00:00Z'
      assert.equal(getBuildTimestamp(), '2026-06-15T10:00:00Z')
    })

    it('falls back to BUILDFLOW_BUILD_TIMESTAMP when canonical unset', () => {
      delete process.env.WORKBENCH_BUILD_TIMESTAMP
      process.env.BUILDFLOW_BUILD_TIMESTAMP = '2026-06-15T10:00:00Z'
      assert.equal(getBuildTimestamp(), '2026-06-15T10:00:00Z')
    })

    it('defaults to unknown when neither set', () => {
      delete process.env.WORKBENCH_BUILD_TIMESTAMP
      delete process.env.BUILDFLOW_BUILD_TIMESTAMP
      assert.equal(getBuildTimestamp(), 'unknown')
    })
  })

  describe('getActionDiagnostics', () => {
    it('uses WORKBENCH_ACTION_DIAGNOSTICS when set to 1', () => {
      delete process.env.BUILDFLOW_ACTION_DIAGNOSTICS
      process.env.WORKBENCH_ACTION_DIAGNOSTICS = '1'
      assert.equal(getActionDiagnostics(), true)
    })

    it('falls back to BUILDFLOW_ACTION_DIAGNOSTICS when canonical unset', () => {
      delete process.env.WORKBENCH_ACTION_DIAGNOSTICS
      process.env.BUILDFLOW_ACTION_DIAGNOSTICS = '1'
      assert.equal(getActionDiagnostics(), true)
    })

    it('returns false when set to anything other than 1', () => {
      delete process.env.BUILDFLOW_ACTION_DIAGNOSTICS
      process.env.WORKBENCH_ACTION_DIAGNOSTICS = '0'
      assert.equal(getActionDiagnostics(), false)
    })

    it('returns false when neither set', () => {
      delete process.env.WORKBENCH_ACTION_DIAGNOSTICS
      delete process.env.BUILDFLOW_ACTION_DIAGNOSTICS
      assert.equal(getActionDiagnostics(), false)
    })

    it('throws when canonical and legacy diagnostics flags conflict', () => {
      process.env.WORKBENCH_ACTION_DIAGNOSTICS = '1'
      process.env.BUILDFLOW_ACTION_DIAGNOSTICS = '0'
      assert.throws(
        () => getActionDiagnostics(),
        /Conflicting environment variables/
      )
    })
  })

  describe('getApiBaseUrl', () => {
    it('uses WORKBENCH_API when set', () => {
      delete process.env.BUILDFLOW_API
      process.env.WORKBENCH_API = 'https://api.example.com'
      assert.equal(getApiBaseUrl(), 'https://api.example.com')
    })

    it('falls back to BUILDFLOW_API when canonical unset', () => {
      delete process.env.WORKBENCH_API
      process.env.BUILDFLOW_API = 'https://legacy-api.example.com'
      assert.equal(getApiBaseUrl(), 'https://legacy-api.example.com')
    })

    it('defaults to http://localhost:3000 when neither set', () => {
      delete process.env.WORKBENCH_API
      delete process.env.BUILDFLOW_API
      assert.equal(getApiBaseUrl(), 'http://localhost:3000')
    })
  })
})

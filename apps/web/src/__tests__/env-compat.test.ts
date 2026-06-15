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
  getApiBaseUrl,
  resolveEnvVariable
} from '../lib/env-compat'

describe('Environment Compatibility Layer', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Fully restore original environment
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    })
    Object.assign(process.env, originalEnv)
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
        /Invalid backend mode/
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
        /Invalid web server mode/
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
        /Invalid agent server mode/
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

  describe('resolveEnvVariable (shared resolver)', () => {
    it('returns canonical value when set', () => {
      process.env.TEST_CANONICAL = 'canonical-value'
      delete process.env.TEST_LEGACY
      const result = resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY')
      assert.equal(result, 'canonical-value')
    })

    it('returns legacy value when canonical unset', () => {
      delete process.env.TEST_CANONICAL
      process.env.TEST_LEGACY = 'legacy-value'
      const result = resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY')
      assert.equal(result, 'legacy-value')
    })

    it('returns canonical when both set identically', () => {
      process.env.TEST_CANONICAL = 'same-value'
      process.env.TEST_LEGACY = 'same-value'
      const result = resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY')
      assert.equal(result, 'same-value')
    })

    it('throws when canonical and legacy conflict', () => {
      process.env.TEST_CANONICAL = 'canonical-val'
      process.env.TEST_LEGACY = 'legacy-val'
      assert.throws(
        () => resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY'),
        /Conflicting environment variables/
      )
    })

    it('returns default when neither set', () => {
      delete process.env.TEST_CANONICAL
      delete process.env.TEST_LEGACY
      const result = resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY', 'default-value')
      assert.equal(result, 'default-value')
    })

    it('returns undefined when neither set and no default', () => {
      delete process.env.TEST_CANONICAL
      delete process.env.TEST_LEGACY
      const result = resolveEnvVariable('TEST_CANONICAL', 'TEST_LEGACY')
      assert.equal(result, undefined)
    })

    it('does not expose values in error messages', () => {
      process.env.SECRET_CANONICAL = 'secret-canonical-token-12345'
      process.env.SECRET_LEGACY = 'secret-legacy-token-67890'
      try {
        resolveEnvVariable('SECRET_CANONICAL', 'SECRET_LEGACY')
        assert.fail('expected error')
      } catch (err) {
        const msg = String(err)
        assert(!msg.includes('secret-canonical-token-12345'), 'error should not contain canonical value')
        assert(!msg.includes('secret-legacy-token-67890'), 'error should not contain legacy value')
        assert(msg.includes('SECRET_CANONICAL'), 'error should name canonical var')
        assert(msg.includes('SECRET_LEGACY'), 'error should name legacy var')
      }
    })
  })
})

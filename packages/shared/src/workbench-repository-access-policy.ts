export type RepositoryPathProtection = {
  code: 'ABSOLUTE_PATH_BLOCKED' | 'PATH_TRAVERSAL_BLOCKED' | 'SECRET_PATH_BLOCKED' | 'PROTECTED_PATH'
  reason: string
  message: string
  hint: string
}

const PRIVATE_KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.ppk'])
const PRIVATE_SECURITY_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube'])

function pathParts(value: string): string[] {
  return value.replace(/\\/g, '/').split('/').filter(Boolean)
}

export function normalizeRepositoryRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

export function evaluateConnectedRepositoryPath(requestedPath: string): RepositoryPathProtection | null {
  const normalized = normalizeRepositoryRelativePath(requestedPath)
  const posix = requestedPath.replace(/\\/g, '/')
  const parts = pathParts(normalized)
  const basename = parts.length > 0 ? parts[parts.length - 1] : ''

  if (!requestedPath.trim() || posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix)) {
    return {
      code: 'ABSOLUTE_PATH_BLOCKED',
      reason: 'absolute_path',
      message: 'Absolute paths outside the connected repository are blocked.',
      hint: 'Use a repository-relative path inside the connected source.'
    }
  }
  if (parts.includes('..')) {
    return {
      code: 'PATH_TRAVERSAL_BLOCKED',
      reason: 'path_traversal',
      message: 'Path traversal outside the connected repository is blocked.',
      hint: 'Use a normalized repository-relative path.'
    }
  }

  if (parts.includes('.git')) {
    return {
      code: 'PROTECTED_PATH',
      reason: 'git_internal',
      message: 'Git internals are protected from repository operations.',
      hint: 'Use normal repository files; do not modify .git/**.'
    }
  }

  const lowerBasename = basename.toLowerCase()
  const isEnvironmentFile = lowerBasename === '.env' || lowerBasename.startsWith('.env.')
  const isPrivateKeyFile = PRIVATE_KEY_EXTENSIONS.has(lowerBasename.slice(lowerBasename.lastIndexOf('.')))
    || /^(id_(rsa|dsa|ecdsa|ed25519)|known_hosts)$/i.test(basename)
  const isCredentialFile = /^(credentials?|secrets?|tokens?)([._-].*)?$/i.test(basename)
    || /^(private[-_]?key|credential|secret|token)([._-].*)?$/i.test(lowerBasename)
  const isPrivateSecurityPath = parts.some(part => PRIVATE_SECURITY_DIRECTORIES.has(part.toLowerCase()))
    || parts.some((part, index) => index > 0 && part.toLowerCase() === 'private' && parts[index - 1].toLowerCase() === 'ai')
    || parts.some((part, index) => index > 0 && part.toLowerCase() === 'secrets' && parts[index - 1].toLowerCase() === 'ai')

  if (isEnvironmentFile || isPrivateKeyFile || isCredentialFile || isPrivateSecurityPath) {
    return {
      code: 'SECRET_PATH_BLOCKED',
      reason: 'protected_security_material',
      message: 'Credentials, secrets, private keys, and private security material are protected.',
      hint: 'Use a non-sensitive repository path or a redacted example file.'
    }
  }

  return null
}

const PROTECTED_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
  /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|sk_live_|rk_live_|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{8,}/,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i
]

export function containsProtectedRepositoryContent(content: string): boolean {
  return PROTECTED_CONTENT_PATTERNS.some(pattern => pattern.test(content))
}

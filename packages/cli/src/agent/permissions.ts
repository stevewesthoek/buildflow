import { IGNORE_PATTERNS } from '@workbench/shared'

const ALLOWED_DOTFILE_READS = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example',
  '.gitignore',
  '.github',
  '.buildflow',
  '.kiro',
  '.ai/current.md'
])

export function isPathAllowed(relativePath: string): boolean {
  // Block only real parent-directory traversal segments. Framework route names such
  // as `[...slug]` and `[[...segments]]` are valid repo-relative path segments.
  const normalizedPath = relativePath.replace(/\\/g, '/')
  if (normalizedPath.startsWith('/') || normalizedPath.split('/').includes('..')) {
    return false
  }

  // Allow a narrow set of safe hidden files/folders for exact reads, but keep
  // real secrets and VCS internals blocked.
  const parts = relativePath.split('/')
  if (parts.some(part => part === '.git')) {
    return false
  }
  if (/^\.env(\..*)?$/i.test(relativePath) && !ALLOWED_DOTFILE_READS.has(relativePath)) {
    return false
  }
  if (parts.some(part => part.startsWith('.'))) {
    if (ALLOWED_DOTFILE_READS.has(parts[0]) || ALLOWED_DOTFILE_READS.has(relativePath)) {
      return true
    }
    return false
  }

  // Check ignore patterns
  for (const pattern of IGNORE_PATTERNS) {
    const normalized = pattern.replace('/**', '').replace('/**/', '/')
    if (relativePath.includes(normalized)) {
      return false
    }
  }

  return true
}

export function validatePath(relativePath: string): { valid: boolean; error?: string } {
  if (!relativePath) {
    return { valid: false, error: 'Path cannot be empty' }
  }

  if (!isPathAllowed(relativePath)) {
    return { valid: false, error: 'Access denied. This file is outside the approved brain folder.' }
  }

  return { valid: true }
}

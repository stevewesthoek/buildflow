import path from 'path'
import os from 'os'

export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1))
  }
  return filePath
}

export function getConfigDir(): string {
  const override = String(process.env.WORKBENCH_CONFIG_DIR || '').trim()
  return override ? path.resolve(expandTilde(override)) : expandTilde('~/.buildflow')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json')
}

export function getAuditLogPath(): string {
  return path.join(getConfigDir(), 'audit.log')
}

export function getIndexPath(): string {
  return path.join(getConfigDir(), 'index.json')
}

export function getIndexDir(): string {
  return path.join(getConfigDir(), 'indexes')
}

export function getSourceIndexPath(sourceId: string): string {
  const safeSourceId = sourceId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(getIndexDir(), `${safeSourceId}.json`)
}

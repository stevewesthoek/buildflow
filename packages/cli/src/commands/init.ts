import fs from 'fs'
import path from 'path'
import { saveConfig } from '../agent/config'
import { getConfigDir } from '../utils/paths'
import { log } from '../utils/logger'
import os from 'os'
import { getApiBaseUrl } from '@workbench/shared'

export async function initCommand(): Promise<void> {
  const configDir = getConfigDir()
  const configPath = path.join(configDir, 'config.json')

  if (fs.existsSync(configPath)) {
    log('BuildFlow is already initialized.')
    return
  }

  const config: any = {
    userId: '',
    deviceId: '',
    deviceToken: '',
    apiBaseUrl: getApiBaseUrl(),
    sources: [],
    vaultPath: '',
    localPort: 3052,
    mode: 'read_create_append',
    activeSourcesMode: 'all',
    activeSourceIds: [],
    writeMode: 'safeWrites',
    ignorePatterns: ['.git/**', '.obsidian/**', 'node_modules/**', '.buildflowignore']
  }

  fs.mkdirSync(configDir, { recursive: true })
  saveConfig(config)

  log('BuildFlow initialized.')
  log(`Config directory: ${configDir}`)
  log('')
  log('Next steps:')
  log('1. Run: buildflow connect <path-to-knowledge-source>')
  log('2. (Optional) Run: buildflow connect <another-path> for additional sources')
  log('3. Run: buildflow serve')
}

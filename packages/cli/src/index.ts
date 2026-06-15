#!/usr/bin/env node

import { Command } from 'commander'
import { initCommand } from './commands/init'
import { loginCommand } from './commands/login'
import { connectCommand } from './commands/connect'
import { indexCommand } from './commands/index'
import { serveCommand } from './commands/serve'
import { statusCommand } from './commands/status'
import { workspaceListCommand } from './commands/workspace'
import { treeCommand } from './commands/tree'
import { grepCommand } from './commands/grep'
import { contextCommand } from './commands/context'
import { diagnosticRedactionCommand } from './commands/diagnose-redaction'

const program = new Command()

// Detect which binary was invoked (workbench vs buildflow)
const invocationName = process.argv[1]?.split('/').pop() || 'workbench'
const isDeprecatedAlias = invocationName === 'buildflow'

// Emit deprecation warning to stderr for buildflow alias (unless JSON/machine-readable output)
if (isDeprecatedAlias && !process.env.WORKBENCH_JSON && !process.argv.includes('--json')) {
  const deprecationWarning = `⚠ WARNING: 'buildflow' command is deprecated. Use 'workbench' instead.\n`
  process.stderr.write(deprecationWarning)
}

program.name('workbench').description('Workbench: execute ideas into action').version('0.1.0')

program
  .command('init')
  .description('Initialize Workbench')
  .action(() => initCommand())

program
  .command('login <apiKey>')
  .description('Login with API key')
  .action((apiKey) => loginCommand(apiKey))

program
  .command('connect <folder>')
  .description('Connect a local vault folder')
  .action((folder) => connectCommand(folder))

program
  .command('index')
  .description('Rebuild the search index')
  .action(() => indexCommand())

program
  .command('serve')
  .description('Start the local agent server')
  .action(() => serveCommand())

program
  .command('status')
  .description('Show Workbench status')
  .action(() => statusCommand())

program
  .command('workspace <action>')
  .description('Manage workspaces')
  .action((action) => {
    if (action === 'list') {
      workspaceListCommand()
    } else {
      console.error(`Unknown action: ${action}`)
    }
  })

program
  .command('tree <workspace> [path]')
  .option('--depth <n>', 'Max depth', '3')
  .description('List workspace tree')
  .action((workspace, path, options) => {
    treeCommand(workspace, path || '', parseInt(options.depth, 10))
  })

program
  .command('grep <workspace> <pattern>')
  .option('--max <n>', 'Max results', '50')
  .description('Search workspace')
  .action((workspace, pattern, options) => {
    grepCommand(workspace, pattern, parseInt(options.max, 10))
  })

program
  .command('context <workspace> [query]')
  .option('--depth <n>', 'Max depth', '2')
  .description('Assemble workspace context')
  .action((workspace, query, options) => {
    contextCommand(workspace, query || '', parseInt(options.depth, 10))
  })

program.addCommand(diagnosticRedactionCommand())

program.parse()

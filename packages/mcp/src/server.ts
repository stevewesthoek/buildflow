#!/usr/bin/env node
import path from 'node:path'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createWorkbenchMcpServer } from './mcp-server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const server = createWorkbenchMcpServer({ repoRoot })
const MAX_STDIN_MESSAGE_BYTES = 64 * 1024
let lineBytes = 0
const boundedStdin = new Transform({
  transform(chunk: Buffer, _encoding, callback) {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        lineBytes = 0
      } else if (++lineBytes > MAX_STDIN_MESSAGE_BYTES) {
        callback(new Error('MCP stdin message exceeded the allowed size.'))
        return
      }
    }
    callback(null, chunk)
  }
})
process.stdin.pipe(boundedStdin)
const transport = new StdioServerTransport(boundedStdin, process.stdout)

let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await server.close().catch(() => undefined)
}

boundedStdin.once('error', error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'MCP stdin framing failed.'}\n`)
  process.exitCode = 1
  void close()
})
process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
process.stdin.once('end', () => { void close() })

await server.connect(transport)

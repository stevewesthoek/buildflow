#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const OUTPUT_FILE = path.resolve(process.cwd(), 'docs/openapi.chatgpt.json')

async function main() {
  const response = await fetch(`${BASE_URL}/api/openapi`)
  if (!response.ok) {
    throw new Error(`Failed to fetch schema from ${BASE_URL}/api/openapi: ${response.status}`)
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON schema, got ${contentType}`)
  }
  const schema = await response.json()
  const serialized = `${JSON.stringify(schema)}\n`
  fs.writeFileSync(OUTPUT_FILE, serialized)
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_FILE)} (${Buffer.byteLength(serialized, 'utf8')} bytes)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})

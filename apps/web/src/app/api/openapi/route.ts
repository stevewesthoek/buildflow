import { NextResponse } from 'next/server'

import canonicalOpenApiSchema from '../../../lib/openapi-chatgpt.json'
const PUBLIC_ACTION_ORIGIN = 'https://workbench.prochat.tools'

const createWorkbenchSchema = () => {
  const schema = structuredClone(canonicalOpenApiSchema) as Record<string, unknown>
  schema.servers = [{ url: PUBLIC_ACTION_ORIGIN }]
  const components = schema.components && typeof schema.components === 'object' && !Array.isArray(schema.components)
    ? schema.components as Record<string, unknown>
    : {}
  schema.components = { ...components, schemas: components.schemas && typeof components.schemas === 'object' && !Array.isArray(components.schemas) ? components.schemas : {} }

  return schema
}

export async function GET() {
  const schema = createWorkbenchSchema()

  return NextResponse.json(schema, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  })
}

import { NextRequest } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { handleProxyAction } from '@/lib/actions/proxy-handler'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  return handleProxyAction(request, auth.valid, auth.error, '/api/set-active-sources', auth.bearerToken)
}

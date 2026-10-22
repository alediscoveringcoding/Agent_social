import { nativeRequest, NativeProviderError } from '../http.ts'
import type { NativeContext } from '../types.ts'

export async function graphql<T>(ctx: NativeContext, url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown>, write = false): Promise<T> {
  const { data } = await nativeRequest<{ data?: T; errors?: Array<{ extensions?: { code?: string; classification?: string } }> }>(ctx, url,
    { method: 'POST', headers, body: { query, variables }, write })
  if (data?.errors?.length) {
    if (write && data.data) throw new NativeProviderError('UNKNOWN_RESULT', 200, true)
    const codes = data.errors.map(error => error.extensions?.code || error.extensions?.classification)
    if (codes.includes('UNAUTHENTICATED')) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
    if (codes.some(code => ['FORBIDDEN', 'INSUFFICIENT_SCOPES'].includes(code || ''))) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (codes.some(code => ['BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'].includes(code || ''))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'INVALID_RESPONSE', 200, write)
  }
  if (!data?.data) throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'INVALID_RESPONSE', 200, write)
  return data.data
}

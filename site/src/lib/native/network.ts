import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { instanceUrl, isPrivateAddress } from './providers/shared.ts'

// Resolve once in the actual socket connection, validating every answer. A
// preflight DNS check followed by ordinary fetch would permit DNS rebinding.
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      callback(new Error('NATIVE_PRIVATE_NETWORK_DENIED'), '', 4)
      return
    }
    const family = typeof options === 'number' ? options : options?.family
    const matches = addresses.filter((item) => !family || item.family === family)
    if (!matches.length) { callback(new Error('NATIVE_DNS_FAILED'), '', 4); return }
    // Node's autoSelectFamily requests all addresses on recent releases.
    if (typeof options === 'object' && options?.all) callback(null, matches)
    else callback(null, matches[0].address, matches[0].family)
  }).catch(() => callback(new Error('NATIVE_DNS_FAILED'), '', 4))
} } })

export const nativeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  instanceUrl(`${url.origin}${url.pathname}`)
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname)) throw new Error('NATIVE_PRIVATE_NETWORK_DENIED')
  return await undiciFetch(url, { ...init, redirect: 'error', dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response
}

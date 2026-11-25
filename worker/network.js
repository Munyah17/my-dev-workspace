import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import ipaddr from 'ipaddr.js'

export function monitorUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid monitor URL.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !url.hostname.includes('.')) {
    throw new Error('Use a public HTTPS URL on port 443 with no credentials or fragment.')
  }
  return url
}

export async function publicAddress(hostname, resolve = lookup) {
  const addresses = await resolve(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => {
    const parsed = ipaddr.process(address)
    return parsed.range() !== 'unicast' || (parsed.kind() === 'ipv6' && !parsed.match(ipaddr.parse('2000::'), 3))
  })) throw new Error('Destination must resolve exclusively to public addresses.')
  return addresses.find(item => item.family === 4) ?? addresses[0]
}

async function resolveForRequest(hostname, signal) {
  if (!signal) return publicAddress(hostname)
  signal.throwIfAborted()
  let abort
  const canceled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([publicAddress(hostname), canceled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function httpsObservation(input, { signal, phrase, includeBody = false, headers, followRedirects = true } = {}) {
  let url = monitorUrl(input)
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted()
    const { address, family } = await resolveForRequest(url.hostname, signal)
    const result = await new Promise((resolve, reject) => {
      const req = request(url, {
        signal, headers, agent: false, autoSelectFamily: false,
        lookup: (_host, _options, callback) => callback(null, address, family),
      }, response => {
        const status = response.statusCode
        if ((!phrase && !includeBody) || (status >= 300 && status < 400 && response.headers.location)) {
          response.destroy()
          resolve({ status, location: response.headers.location })
          return
        }
        const finish = chunks => {
          const body = Buffer.concat(chunks).toString()
          resolve({ status, phraseFound: phrase ? body.includes(phrase) : undefined, body: includeBody ? body : undefined })
        }
        const chunks = []
        let size = 0
        response.on('error', reject)
        response.on('data', chunk => {
          const remaining = 1_000_000 - size
          chunks.push(chunk.subarray(0, remaining))
          size += Math.min(chunk.length, remaining)
          if (size === 1_000_000) {
            response.destroy()
            finish(chunks)
          }
        })
        response.on('end', () => finish(chunks))
      })
      req.on('error', reject)
      req.end()
    })
    if (![301,302,303,307,308].includes(result.status) || !result.location) return result
    if (!followRedirects || headers) throw new Error('Redirect is not allowed for this check.')
    url = monitorUrl(new URL(result.location, url).href)
  }
  throw new Error('Too many redirects.')
}

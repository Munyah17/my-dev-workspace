import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { createApi } from './api.js'
import { appConfig } from './config.js'

const root = resolve('dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
await readFile(resolve(root, 'index.html'))
const api = await createApi(appConfig())
const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
  void api.handle(req, res, async () => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path))
      if (!file.startsWith(root + sep) || !['GET', 'HEAD'].includes(req.method)) {
        return res.writeHead(404).end()
      }
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      res.end(req.method === 'HEAD' ? undefined : data)
    } catch {
      res.writeHead(404).end()
    }
  })
})
server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => {
  console.log('MyDev Workspace listening on port %s', server.address().port)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { void api.close() }))
}

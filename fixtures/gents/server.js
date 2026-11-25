import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

const username = 'mydev-staff-test'
const testName = 'MyDev Test Barber'
const escape = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])
const same = (left, right) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a,b)
}

async function form(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 2048) throw new Error('Fixture form too large')
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString())
}

export function gentsFixture({ password, controlToken, secureCookies = true }) {
  if (!password || !controlToken) throw new Error('Configure fixture credentials.')
  const sessions = new Set()
  let mode = 'lost'
  let hasRecord = false
  return createServer(async (request, response) => {
    const pathname = new URL(request.url,'http://fixture').pathname
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(body)
    }
    const redirect = path => response.writeHead(303, { Location: path }).end()
    try {
      if (request.method === 'POST' && pathname === '/control') {
        if (!same(request.headers.authorization ?? '', 'Bearer ' + controlToken)) return send(404,'Not found')
        const next = (await form(request)).get('mode')
        if (!['lost','saved','expired'].includes(next)) return send(400,'Invalid fixture mode')
        mode = next
        hasRecord = false
        sessions.clear()
        return send(200,'Fixture mode set.')
      }
      if (request.method === 'GET' && pathname === '/') return send(200,'<h1>The Gents staging fixture</h1>')
      const login = `<h1>Staging test sign-in</h1><form method="post" action="/login">
        <label>Test username<input id="test-account" name="username"></label>
        <label>Test password<input type="password" id="test-password" name="password"></label>
        <button id="test-sign-in">Sign in</button></form>`
      if (request.method === 'POST' && pathname === '/login') {
        const fields = await form(request)
        if (mode === 'expired' || fields.get('username') !== username || !same(fields.get('password') ?? '',password)) return send(403,'Test sign-in rejected')
        const session = randomUUID()
        sessions.add(session)
        if (sessions.size > 100) sessions.delete(sessions.values().next().value)
        response.setHeader('Set-Cookie', `fixture_session=${session}; Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`)
        return redirect('/staff')
      }
      const session = request.headers.cookie?.match(/(?:^|;\s*)fixture_session=([a-f0-9-]+)/)?.[1]
      if (pathname === '/staff' && request.method === 'GET') {
        if (!sessions.has(session)) return send(200,login)
        return send(200,`<h1 id="signed-in">Staff workspace</h1><form method="post" action="/staff/write">
          <label>Staff name<input id="staff-name" name="record"></label><button id="save-staff">Save</button></form>
          <div id="staff-list">${hasRecord ? escape(testName) : 'No test record'}</div>
          <form method="post" action="/staff/cleanup"><input name="record" value="${escape(testName)}" type="hidden"><button id="remove-staff">Remove test record</button></form>`)
      }
      if (request.method === 'POST' && ['/staff/write','/staff/cleanup'].includes(pathname)) {
        if (!sessions.has(session)) return send(403,'Test sign-in required')
        if ((await form(request)).get('record') !== testName) return send(400,'Only the named fixture record is allowed')
        hasRecord = pathname === '/staff/write' && mode === 'saved'
        return redirect('/staff')
      }
      return send(404,'Not found')
    } catch {
      return send(400,'Invalid fixture request')
    }
  })
}

if (process.argv[1]?.endsWith('/fixtures/gents/server.js')) {
  gentsFixture({
    password: process.env.FIXTURE_PASSWORD,
    controlToken: process.env.FIXTURE_CONTROL_TOKEN,
  }).listen(Number(process.env.PORT || 8080), '0.0.0.0')
}

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createApi } from './api.js'

async function launch(dataDir) {
  const api = await createApi({ dataDir, demo: true })
  return {
    async fetch(path, cookie, body) {
      const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
        url: '/api/' + path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie },
        socket: {},
      })
      const headers = new Headers()
      let status
      let response
      await api.handle(req, {
        setHeader: (name, value) => headers.set(name, value),
        writeHead(code, fields) {
          status = code
          for (const [name, value] of Object.entries(fields)) headers.set(name, value)
        },
        end(value) { response = new Response(value, { status, headers }) },
      }, () => assert.fail('Expected an API request'))
      return response
    },
    async login(email) {
      const result = await this.fetch('login', '', { email: email + '@example.test', password: 'workspace-demo' })
      assert.equal(result.status, 200)
      assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
      return result.headers.get('set-cookie').split(';')[0]
    },
    async close() {
      await api.close()
    },
  }
}

test('ticket, replies and files persist across restart and stay within authorized projects', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mydev-'))
  const dataDir = join(parent, 'workspace')
  let server
  try {
    server = await launch(dataDir)
    const client = await server.login('gents')
    const agency = await server.login('agency')
    const other = await server.login('other')
    const opening = 'I added a barber, but the record disappears after I reload.'
    const subject = 'Staff record disappears after reload'
    const response = await server.fetch('tickets', client, {
      project: 'gents-staff', subject, message: opening,
      attachment: { name: 'report.txt', content: Buffer.from('Fixture evidence').toString('base64') },
    })
    assert.equal(response.status, 200, await response.clone().text())
    const { id } = await response.json()
    const path = 'tickets/' + id
    const notices = await (await server.fetch('notifications', agency)).json()
    assert.equal(notices[0].ticket_id, id)
    assert.equal(notices[0].read, false)
    assert.equal((await server.fetch('notifications/' + notices[0].id + '/read', agency, {})).status, 200)
    assert.equal((await (await server.fetch('notifications', agency)).json())[0].read, true)
    const agencyTicket = await (await server.fetch(path, agency)).json()
    const attachment = 'attachments/' + agencyTicket.messages[0].attachments[0].id
    assert.equal(await (await server.fetch(attachment, agency)).text(), 'Fixture evidence')
    assert.equal((await server.fetch(path, other)).status, 404)
    assert.equal((await server.fetch(attachment, other)).status, 404)
    assert.deepEqual(await (await server.fetch('tickets?q=Staff', other)).json(), [])
    assert.deepEqual(await (await server.fetch('notifications', other)).json(), [])
    assert.equal((await server.fetch('tickets', other, { project: 'gents-staff', subject, message: opening })).status, 404)
    assert.equal((await server.fetch(path + '/reply', client, { message: 'Private?', internal: true })).status, 403)
    assert.equal((await server.fetch(path + '/state', client, { state: 'Resolved' })).status, 403)
    assert.equal((await server.fetch(path + '/state', agency, { state: 'In progress' })).status, 200)
    assert.equal((await server.fetch(path + '/reply', agency, {
      message: 'Staging investigation only', internal: true,
      attachment: { name: 'private.txt', content: Buffer.from('Internal').toString('base64') },
    })).status, 200)
    const privateThread = await (await server.fetch(path, agency)).json()
    const privateNote = privateThread.messages.find(message => message.internal)
    assert.equal((await server.fetch('attachments/' + privateNote.attachments[0].id, client)).status, 404)
    const reply = 'We are checking why the record disappears after reload.'
    assert.equal((await server.fetch(path + '/reply', agency, { message: reply })).status, 200)
    await server.fetch('logout', client, {})
    await server.fetch('logout', agency, {})
    assert.equal((await server.fetch(path, client)).status, 401)
    await server.close()
    server = await launch(dataDir)
    const fresh = await server.login('gents')
    const freshAgency = await server.login('agency')
    const thread = await (await server.fetch(path, fresh)).json()
    assert.equal(thread.state, 'In progress')
    assert.deepEqual(thread.messages.map(message => message.body), [opening, reply])
    assert.equal((await (await server.fetch(path, freshAgency)).json()).messages.length, 3)
    assert.equal((await (await server.fetch('notifications', fresh)).json()).length, 1)
    assert.equal(await (await server.fetch(attachment, fresh)).text(), 'Fixture evidence')
  } finally {
    if (server) await server.close()
    await rm(parent, { recursive: true, force: true })
  }
})

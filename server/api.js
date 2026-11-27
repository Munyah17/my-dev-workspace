import { workspaceToolsRoute } from './workspace-tools.js'
import { operationsRoute } from './operations.js'
import { billingRoute } from './billing.js'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { openDatabase, scopedTransaction } from './database.js'
import { migrateBilling, migrateBillingEditor, migrateIntegrationCatalog, migrateIntegrationCredentials, migrateMaintenance, migrateMonitoring, migrateOperations, migrateWorkspaceTools } from './migrate.js'
import { monitoringReady, monitoringRoute } from './monitoring.js'
import { maintenanceRoute } from './maintenance.js'

const migration = new URL('./schema.sql', import.meta.url)
const digest = token => createHash('sha256').update(token).digest('hex')
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex')
export function encodePassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${passwordHash(password, salt)}`
}
const demoAccounts = [
  ['agency', 'agency@example.test', 'Morgan Ellis', null, 'owner'],
  ['gents', 'gents@example.test', 'The Gents Reception', 'gents', 'client_manager'],
  ['other', 'other@example.test', 'Harbor Reception', 'harbor', 'client_member'],
]
const states = ['New', 'In progress', 'Awaiting agency', 'Awaiting client', 'Resolved', 'Reopened']
const ticketId = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const match = (url, pattern) => url.match(new RegExp(`^${pattern}$`, 'i'))
const fail = (status, message) => Object.assign(new Error(message), { status })
const requiredText = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, 'Check the required fields and their length.')
  return value.trim()
}

export async function initialize(db, demo) {
  await scopedTransaction(db, async tx => {
    const { rows } = await tx.query("SELECT to_regclass('workspace_private.workspaces') AS initialized")
    if (!rows[0].initialized) await tx.exec(await readFile(migration, 'utf8'))
    await migrateMonitoring(tx)
    await migrateMaintenance(tx)
    await migrateBilling(tx)
    await migrateBillingEditor(tx)
    await migrateOperations(tx)
    await migrateWorkspaceTools(tx)
    await migrateIntegrationCatalog(tx)
    await migrateIntegrationCredentials(tx)
    if (!demo) return
    const seeded = await tx.query("SELECT id FROM workspaces WHERE id='demo'")
    if (seeded.rows.length) return
    await tx.exec(`
      INSERT INTO workspaces VALUES ('demo','MyDev Workspace');
      INSERT INTO organizations VALUES ('gents','demo','The Gents'),('harbor','demo','Harbor Studio');
      INSERT INTO projects VALUES ('gents-staff','demo','gents','The Gents Staff Portal'),('harbor-site','demo','harbor','Harbor Studio Website'),('agency-site','demo',NULL,'Agency Website');
    `)
    for (const [id, email, name, organization, role] of demoAccounts) {
      await tx.query('INSERT INTO accounts (id,email,name,password) VALUES ($1,$2,$3,$4)', [id,email,name,encodePassword(randomBytes(32).toString('base64url'))])
      await tx.query("INSERT INTO memberships VALUES ($1,'demo',$2,$3)", [id,organization,role])
    }
    await tx.exec("INSERT INTO project_access VALUES ('gents','gents-staff'),('other','harbor-site')")
  })
}

async function jsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_500_000) throw fail(413, 'Attachments are limited to 1 MB.')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch { /* handled below */ }
  throw fail(400, 'Expected a JSON object.')
}

async function addMessage(tx, account, ticket, body) {
  const result = await tx.query(
    'INSERT INTO messages (ticket_id,author_id,body,internal) VALUES ($1,$2,$3,$4) RETURNING id',
    [ticket, account, requiredText(body.message, 8000), body.internal === true],
  )
  if (body.attachment) {
    const filename = requiredText(body.attachment.name, 200)
    const content = body.attachment.content
    if (typeof content !== 'string' || content.length > 1_398_104 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4) {
      throw fail(400, 'Invalid attachment.')
    }
    await tx.query('INSERT INTO attachments (message_id,name,content) VALUES ($1,$2,$3)', [result.rows[0].id, filename, content])
  }
}

async function supabaseIdentity(email, password, config) {
  const response = await fetch(new URL('/auth/v1/token?grant_type=password', config.url), {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  })
  if (response.status === 429) throw fail(429, 'Too many sign-in attempts. Try again shortly.')
  if (response.status >= 500) throw fail(502, 'Sign-in service is unavailable.')
  if (!response.ok) return null
  const result = await response.json()
  return result.user?.email_confirmed_at ? result.user.id : null
}

export async function createApi({ dataDir, demo = false, supabase } = {}) {
  if (demo && (process.env.VERCEL || ['preview', 'production'].includes(process.env.VERCEL_ENV))) throw new Error('Demo authentication is disabled on hosted deployments.')
  if (demo && supabase) throw new Error('Demo mode requires an isolated local database.')
  if (!demo && !supabase) throw new Error('Configure Supabase or run npm run demo.')
  const db = await openDatabase({ dataDir, url: supabase?.databaseUrl })
  try {
    if (demo) await initialize(db, true)
    else await scopedTransaction(db, async tx => {
      await tx.query('SELECT id FROM accounts LIMIT 0')
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query('SELECT id FROM projects LIMIT 0')
    })
  } catch (error) {
    await db.close()
    throw error
  }
  const transaction = work => scopedTransaction(db, work)
  const query = (sql, args) => transaction(tx => tx.query(sql, args))
  return {
    close: () => db.close(),
    async handle(req, res, next) {
      const url = new URL(req.url, 'http://localhost').pathname
      if (!url.startsWith('/api/')) return next()
      const method = req.method
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const token = req.headers.cookie?.match(/(?:^|;\s*)workspace_session=([a-f0-9]{64})(?:;|$)/)?.[1]
      const secure = Boolean(supabase) || req.socket.encrypted || process.env.WORKSPACE_SECURE_COOKIES === '1'
      const setSession = (value, age) => res.setHeader('Set-Cookie', `workspace_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`)
      try {
        if (method === 'POST') {
          if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) throw fail(403, 'Cross-origin request denied.')
          if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
            throw fail(415, 'Expected application/json.')
        }
        if (method === 'GET' && url === '/api/config') return send(200, { demo })
        if (method === 'POST' && url === '/api/demo-login' && !demo) throw fail(404, 'Page not found.')
        if (method === 'POST' && (url === '/api/login' || url === '/api/demo-login')) {
          const form = await jsonBody(req)
          let account
          if (url === '/api/demo-login') {
            const principal = demoAccounts.find(([id]) => form.account === id)
            if (principal) ({ rows: [account] } = await query('SELECT id FROM accounts WHERE id=$1 AND auth_user_id IS NULL', [principal[0]]))
          } else if (supabase) {
            const email = requiredText(form.email, 254).toLowerCase()
            const password = form.password
            if (typeof password !== 'string' || !password || password.length > 256) throw fail(401, 'Email or password is incorrect.')
            const identity = await supabaseIdentity(email, password, supabase)
            if (identity) ({ rows: [account] } = await query(`SELECT a.id FROM accounts a WHERE a.auth_user_id=$1
              AND EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=a.id)`, [identity]))
          }
          if (!account) throw fail(401, 'Email or password is incorrect.')
          const session = randomBytes(32).toString('hex')
          await transaction(async tx => {
            await tx.query('DELETE FROM sessions WHERE expires_at <= now() OR token_hash=$1', [token ? digest(token) : null])
            await tx.query("INSERT INTO sessions VALUES ($1,$2,now()+interval '8 hours')", [digest(session),account.id])
          })
          setSession(session, 28800)
          return send(200, { signedIn: true })
        }
        const { rows: [account] } = token ? await query(
          `SELECT a.id,a.name,a.email,coalesce(bool_or(m.role IN ('owner','support')),false) agency, coalesce(bool_or(m.role IN ('owner','finance')),false) billing
           FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN memberships m ON m.account_id=a.id
           WHERE s.token_hash=$1 AND s.expires_at>now() GROUP BY a.id`, [digest(token)],
        ) : { rows: [] }
        if (!account) throw fail(401, 'Sign in to continue.')
        if (method === 'POST' && url === '/api/logout') {
          await query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)])
          setSession('', 0)
          return send(200, { signedIn: false })
        }
        if (method === 'GET' && url === '/api/me') return send(200, account)
        const body = method === 'POST' && url !== '/api/logout' ? await jsonBody(req) : null
        const result = await transaction(async tx => {
          await tx.exec('SET LOCAL ROLE workspace_app')
          await tx.query("SELECT set_config('workspace.actor',$1,true)", [account.id])
          const readCore = async path => {
            if (path === '/api/projects') return (await tx.query('SELECT id,name FROM projects ORDER BY name')).rows
            if (path === '/api/tickets') return (await tx.query(
              `SELECT t.id,t.subject,t.state,p.name project,t.created_at FROM tickets t JOIN projects p ON p.id=t.project_id
               WHERE t.subject ILIKE '%' || $1 || '%' ORDER BY t.created_at DESC,t.id`, [new URL(req.url,'http://localhost').searchParams.get('q') ?? ''],
            )).rows
            if (path === '/api/notifications' && account.agency && await monitoringReady(tx)) {
              return (await tx.query(`
                SELECT * FROM (
                  SELECT msg.id,msg.ticket_id,NULL::uuid AS incident_id,NULL::uuid AS monitor_id,t.subject,msg.created_at,(r.message_id IS NOT NULL) AS read
                  FROM messages msg JOIN tickets t ON t.id=msg.ticket_id LEFT JOIN notification_reads r ON r.message_id=msg.id
                  WHERE msg.author_id<>actor()
                  UNION ALL
                  SELECT e.id,NULL::uuid,e.incident_id,e.monitor_id,
                    p.name || ' · ' || m.name || ' · ' || CASE e.kind WHEN 'incident' THEN 'Incident opened' WHEN 'recovery' THEN 'Recovered' ELSE 'Monitor needs attention' END,
                    e.created_at,(r.event_id IS NOT NULL)
                  FROM monitoring_events e JOIN monitors m ON m.id=e.monitor_id JOIN projects p ON p.id=m.project_id
                  LEFT JOIN monitoring_event_reads r ON r.event_id=e.id
                ) activity ORDER BY created_at DESC LIMIT 100`)).rows
            }
            if (path === '/api/notifications') return (await tx.query(
              `SELECT m.id,m.ticket_id,t.subject,m.created_at,(r.message_id IS NOT NULL) AS read
               FROM messages m JOIN tickets t ON t.id=m.ticket_id
               LEFT JOIN notification_reads r ON r.message_id=m.id
               WHERE m.author_id<>actor() ORDER BY m.created_at DESC LIMIT 100`,
            )).rows
          }
          if (method === 'GET') {
            if (url === '/api/dashboard/core') return [
              await readCore('/api/tickets'),
              await readCore('/api/projects'),
              await readCore('/api/notifications'),
            ]
            if (['/api/tickets','/api/projects','/api/notifications'].includes(url)) return readCore(url)
          }
          if (url.startsWith('/api/erp/') || url.startsWith('/api/developer-tools/') || url.startsWith('/api/platform/')) return workspaceToolsRoute(tx,{ method,pathname:url,body,account,search:new URL(req.url,'http://localhost').searchParams })
          if (url.startsWith('/api/operations/')) return operationsRoute(tx,{ method,pathname:url,body,account,search:new URL(req.url,'http://localhost').searchParams })
          if (url.startsWith('/api/billing/')) return billingRoute(tx, { method, pathname:url, body, account, search:new URL(req.url,'http://localhost').searchParams })
          if (url.startsWith('/api/maintenance/')) return maintenanceRoute(tx, { method, pathname: url, body, account })
          if (url === '/api/monitoring' || url.startsWith('/api/monitoring/')) return monitoringRoute(tx, { method, pathname: url, body, account, addMessage })
          const notice = match(url, `/api/notifications/(${ticketId})/read`)
          if (method === 'POST' && notice) {
            if (account.agency && await monitoringReady(tx)) {
              await tx.query('INSERT INTO monitoring_event_reads SELECT actor(),id FROM monitoring_events WHERE id=$1 ON CONFLICT DO NOTHING', [notice[1]])
            }
            await tx.query('INSERT INTO notification_reads SELECT actor(),id FROM messages WHERE id=$1 AND author_id<>actor() ON CONFLICT DO NOTHING', [notice[1]])
            return { saved: true }
          }
          if (method === 'POST' && url === '/api/tickets') {
            const project = requiredText(body.project, 120)
            const visible = await tx.query('SELECT id FROM projects WHERE id=$1', [project])
            if (!visible.rows.length) throw fail(404, 'Project not found.')
            const { rows: [ticket] } = await tx.query(
              'INSERT INTO tickets (project_id,author_id,subject) VALUES ($1,$2,$3) RETURNING id',
              [project, account.id, requiredText(body.subject, 160)],
            )
            await addMessage(tx, account.id, ticket.id, { ...body, internal: false })
            return ticket
          }
          const attachment = match(url, `/api/attachments/(${ticketId})`)
          if (method === 'GET' && attachment) {
            const { rows: [file] } = await tx.query('SELECT name,content FROM attachments WHERE id=$1', [attachment[1]])
            if (!file) throw fail(404, 'Attachment not found.')
            return { file }
          }
          const route = match(url, `/api/tickets/(${ticketId})(?:/(reply|state))?`)
          if (!route) throw fail(404, 'Page not found.')
          const { rows: [ticket] } = await tx.query(
            'SELECT t.id,t.subject,t.state,p.name project,project_allowed(p.id,true) AS agency FROM tickets t JOIN projects p ON p.id=t.project_id WHERE t.id=$1',
            [route[1]],
          )
          if (!ticket) throw fail(404, 'Ticket not found.')
          if (method === 'GET' && !route[2]) {
            const { rows: messages } = await tx.query(
              `SELECT m.id,m.body,m.internal,m.created_at,author_name(m.author_id) AS author,m.author_id=actor() AS mine,
                coalesce((SELECT json_agg(json_build_object('id',a.id,'name',a.name)) FROM attachments a WHERE a.message_id=m.id),'[]') AS attachments
               FROM messages m WHERE m.ticket_id=$1 ORDER BY m.created_at,m.id`, [ticket.id],
            )
            return { ...ticket, messages }
          }
          if (method === 'POST' && route[2] === 'reply') {
            if (body.internal && !ticket.agency) throw fail(403, 'Internal notes require agency access.')
            await addMessage(tx, account.id, ticket.id, body)
            return { saved: true }
          }
          if (method === 'POST' && route[2] === 'state') {
            if (!ticket.agency) throw fail(403, 'Changing a ticket state requires agency access.')
            if (!states.includes(body.state)) throw fail(400, 'Invalid ticket state.')
            await tx.query('UPDATE tickets SET state=$1 WHERE id=$2', [body.state, ticket.id])
            return { saved: true }
          }
          throw fail(404, 'Page not found.')
        })
        if (result.file) {
          const name = encodeURIComponent(result.file.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16))
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` })
          return res.end(Buffer.from(result.file.content, 'base64'))
        }
        send(200, result)
      } catch (error) {
        if (!error.status && error.code !== '42501') console.error(error.code ?? error.message)
        send(error.status ?? (error.code === '42501' ? 403 : 500), { error: error.status ? error.message : error.code === '42501' ? 'Access denied.' : 'The request could not be completed.' })
      }
    },
  }
}

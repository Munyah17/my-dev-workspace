import { monitorUrl } from '../worker/network.js'

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const key = /^[A-Z][A-Z0-9_]{0,39}$/
const issue = (status, message) => Object.assign(new Error(message), { status })

export async function monitoringReady(tx) {
  return (await tx.query("SELECT to_regclass('workspace_private.monitors') IS NOT NULL AS ready")).rows[0].ready
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw issue(400, 'Check the required text fields.')
  return value.trim()
}

function number(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw issue(400, `Use a whole number between ${min} and ${max}.`)
  return value
}

function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw issue(404, 'Monitoring record not found.')
  return value
}

function workflowFields(body) {
  if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > 35) throw issue(400, 'Provide between one and 35 workflow steps.')
  const secret = body.secretName || null
  if (secret && (typeof secret !== 'string' || !key.test(secret))) throw issue(400, 'Use an uppercase secret name.')
  const normalize = steps => steps.map(step => {
    if (!step || !['navigate','assert','click','fill','fresh'].includes(step.action)) throw issue(400, 'Invalid workflow step.')
    const normalized = { action: step.action, label: text(step.label, 100), credential: step.credential === true }
    if (['assert','click','fill'].includes(step.action)) normalized.selector = text(step.selector, 200)
    if (step.action === 'navigate') {
      normalized.path = text(step.path, 500)
      if (!/^\/(?![\\/])/.test(normalized.path)) throw issue(400, 'Navigation requires a same-origin path.')
    }
    if (step.action === 'assert') {
      normalized.value = text(step.value, 300)
    }
    if (step.action === 'fill') {
      if (step.secret) {
        if (!secret || typeof step.secret !== 'string' || !key.test(step.secret)) throw issue(400, 'Set a valid secret name and field.')
        normalized.secret = step.secret
      } else {
        normalized.value = text(step.value, 300)
      }
    }
    return normalized
  })
  const steps = normalize(body.steps)
  if (!steps.some(step => step.action === 'assert')) throw issue(400, 'Include a success assertion.')
  if (body.cleanup !== undefined && (!Array.isArray(body.cleanup) || body.cleanup.length > 15))
    throw issue(400, 'Provide up to 15 cleanup steps.')
  const cleanup = normalize(body.cleanup ?? [])
  if (cleanup.length && cleanup.at(-1).action !== 'assert') throw issue(400, 'End cleanup with a verification assertion.')
  return [JSON.stringify(steps),JSON.stringify(cleanup), secret, body.writes === true]
}

export async function monitoringRoute(tx, { method, pathname, body, account, addMessage }) {
  const [, , section, id, action, extra] = pathname.split('/')
  if (section !== 'monitoring') return undefined
  if (!account.agency) throw issue(404, 'Monitoring record not found.')
  if (!(await monitoringReady(tx))) throw issue(503, 'Monitoring needs the Supabase migration.')
  if (extra) throw issue(404, 'Monitoring record not found.')
  if (method === 'GET' && section && !id) {
    const { rows: monitors } = await tx.query(`
      SELECT m.id,m.project_id,p.name AS project,m.environment,m.kind,m.name,m.health,m.paused,m.needs_attention,
        m.last_check,m.last_observation,m.next_due,m.interval_seconds,m.timeout_seconds,m.expected_status,m.phrase,m.url,m.failure_threshold,m.recovery_threshold,
        heartbeat.observed_at AS heartbeat,
        (NOT m.paused AND (heartbeat.observed_at IS NULL OR heartbeat.observed_at<now()-interval '3 minutes'
          OR greatest(m.last_observation,m.created_at)<now()-make_interval(secs=>2*m.interval_seconds+m.timeout_seconds))) AS stale,
        latest.duration_ms, latest.state AS run_state,
        COALESCE(stats.observed,0) AS observed,COALESCE(stats.passed,0) AS passed,
        greatest(0,floor(extract(epoch FROM now()-greatest(m.created_at,now()-interval '7 days'))/m.interval_seconds))::integer AS expected_samples,
        EXISTS(SELECT 1 FROM maintenance_windows w WHERE w.monitor_id=m.id AND now() BETWEEN w.starts_at AND w.ends_at) AS in_maintenance
      FROM monitors m JOIN projects p ON p.id=m.project_id LEFT JOIN worker_status heartbeat ON heartbeat.kind=m.kind
      LEFT JOIN LATERAL(SELECT r.state,r.duration_ms FROM check_runs r WHERE r.monitor_id=m.id ORDER BY (r.state IN ('queued','running')) DESC,coalesce(r.finished_at,r.scheduled_for) DESC,r.id LIMIT 1) latest ON true
      LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE r.outcome IN ('pass','failure'))::integer AS observed,
        count(*) FILTER(WHERE r.outcome='pass')::integer AS passed FROM check_runs r
        WHERE r.monitor_id=m.id AND NOT r.manual AND r.finished_at>=now()-interval '7 days') stats ON true
      ORDER BY p.name,m.environment,m.kind,m.name`)
    const { rows: incidents } = await tx.query(`
      SELECT i.id,i.monitor_id,i.updated_at,i.first_failure_at,i.failure_count,i.acknowledged_at,
        m.name,p.name AS project,r.step,r.planned
      FROM incidents i JOIN monitors m ON m.id=i.monitor_id JOIN projects p ON p.id=m.project_id
        JOIN check_runs r ON r.id=i.latest_run WHERE i.recovered_at IS NULL ORDER BY i.updated_at DESC`)
    return { monitors, incidents }
  }
  if (id === 'projects' && !action && method === 'GET') {
    return (await tx.query('SELECT id,name FROM projects WHERE project_allowed(id,true) ORDER BY name')).rows
  }
  if (id === 'workflows' && !action) {
    if (method === 'GET') return (await tx.query('SELECT id,project_id,name,writes FROM workflows ORDER BY name')).rows
    if (method === 'POST') {
      const project = text(body.project, 120)
      const allowed = await tx.query('SELECT id FROM projects WHERE id=$1 AND project_allowed(id,true)', [project])
      if (!allowed.rows.length) throw issue(404, 'Project not found.')
      const { rows } = await tx.query('INSERT INTO workflows(project_id,name,steps,cleanup,secret_name,writes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [project,text(body.name,120),...workflowFields(body)])
      return rows[0]
    }
  }
  if (id === 'monitors' && !action && method === 'POST') {
    const project = text(body.project, 120)
    const allowed = await tx.query('SELECT id FROM projects WHERE id=$1 AND project_allowed(id,true)', [project])
    if (!allowed.rows.length) throw issue(404, 'Project not found.')
    const environment = body.environment
    const kind = body.kind
    if (!['Production','Staging'].includes(environment) || !['availability','workflow'].includes(kind)) throw issue(400, 'Select a check type and environment.')
    let url
    try { url = monitorUrl(body.url).href } catch { throw issue(400, 'Enter a public HTTPS URL on port 443.') }
    let workflow = null
    if (kind === 'workflow') {
      workflow = identifier(body.workflow)
      const { rows } = await tx.query('SELECT writes,secret_name,jsonb_array_length(cleanup)>0 AS has_cleanup FROM workflows WHERE id=$1 AND project_id=$2', [workflow,project])
      if (!rows.length) throw issue(404, 'Workflow not found.')
      if (rows[0].writes && environment === 'Production' && (!rows[0].secret_name || !rows[0].has_cleanup))
        throw issue(400, 'Production writes require a named test account and verified cleanup.')
    }
    await tx.query('INSERT INTO monitor_environments VALUES($1,$2) ON CONFLICT DO NOTHING', [project,environment])
    const { rows } = await tx.query(`
      INSERT INTO monitors(project_id,environment,kind,name,url,expected_status,phrase,interval_seconds,timeout_seconds,failure_threshold,recovery_threshold,workflow_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [
      project,environment,kind,text(body.name,120),url,number(body.expectedStatus ?? 200,200,599),
      body.phrase ? text(body.phrase,300) : null,number(body.interval ?? (kind === 'availability' ? 300 : 900),60,86400),
      number(body.timeout ?? (kind === 'availability' ? 10 : 60),2,120),number(body.failures ?? 2,1,10),number(body.recoveries ?? 1,1,10),workflow,
    ])
    return rows[0]
  }
  if (id === 'incident') {
    const incident = identifier(action)
    const { rows: [record] } = await tx.query(`
      SELECT i.*,r.finished_at AS last_failure_at,m.name,m.kind,m.environment,p.name AS project,r.step,r.expected,r.actual
      FROM incidents i JOIN monitors m ON m.id=i.monitor_id JOIN projects p ON p.id=m.project_id
        JOIN check_runs r ON r.id=i.latest_run WHERE i.id=$1`, [incident])
    if (!record) throw issue(404, 'Incident not found.')
    if (method === 'GET') {
      const { rows: history } = await tx.query(`SELECT id,finished_at,outcome,attempts,step,expected,actual,planned,
        coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.number) FROM check_attempts a WHERE a.run_id=check_runs.id),'[]'::jsonb) AS retry_history
        FROM check_runs WHERE monitor_id=$1 AND finished_at BETWEEN $2 AND coalesce($3,now())
        ORDER BY finished_at DESC LIMIT 50`, [record.monitor_id,record.first_failure_at,record.recovered_at])
      const { rows: assignees } = await tx.query('SELECT * FROM monitor_assignees($1)', [record.monitor_id])
      const { rows: tickets } = await tx.query('SELECT t.id,t.subject FROM tickets t JOIN monitors m ON m.project_id=t.project_id WHERE m.id=$1 ORDER BY t.created_at DESC', [record.monitor_id])
      return { ...record, history, assignees, tickets }
    }
    if (method === 'POST') {
      if (body.operation === 'acknowledge') await tx.query('UPDATE incidents SET acknowledged_at=coalesce(acknowledged_at,now()) WHERE id=$1', [incident])
      else if (body.operation === 'assign') {
        const assignee = body.account ? text(body.account,120) : null
        if (assignee && !(await tx.query('SELECT assignment_allowed($1,$2) AS allowed', [record.monitor_id,assignee])).rows[0].allowed) throw issue(404, 'Assignee not found.')
        await tx.query('UPDATE incidents SET assigned_to=$2 WHERE id=$1', [incident,assignee])
      } else if (body.operation === 'link') {
        const ticket = body.ticket ? identifier(body.ticket) : null
        if (ticket && !(await tx.query('SELECT t.id FROM tickets t JOIN monitors m ON m.project_id=t.project_id WHERE m.id=$1 AND t.id=$2', [record.monitor_id,ticket])).rows.length) throw issue(404, 'Ticket not found.')
        await tx.query('UPDATE incidents SET ticket_id=$2 WHERE id=$1', [incident,ticket])
      } else if (body.operation === 'publish' && record.ticket_id) {
        await addMessage(tx, account.id, record.ticket_id, { message: text(body.message,8000) })
      } else throw issue(400, 'Select an incident action and link a ticket before posting an update.')
      return { saved: true }
    }
  }
  if (id === 'monitor') {
    const monitor = identifier(action)
    const { rows: [record] } = await tx.query('SELECT id,paused FROM monitors WHERE id=$1', [monitor])
    if (!record) throw issue(404, 'Monitor not found.')
    if (method === 'GET') {
      const { rows: history } = await tx.query(`SELECT id,state,scheduled_for,finished_at,outcome,duration_ms,step,expected,actual,attempts,planned,
        coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.number) FROM check_attempts a WHERE a.run_id=check_runs.id),'[]'::jsonb) AS retry_history FROM check_runs WHERE monitor_id=$1 ORDER BY (state IN ('queued','running')) DESC,coalesce(finished_at,scheduled_for) DESC,id LIMIT 25`, [monitor])
      const { rows: windows } = await tx.query('SELECT id,starts_at,ends_at,suppress FROM maintenance_windows WHERE monitor_id=$1 ORDER BY starts_at DESC LIMIT 15', [monitor])
      return { history, windows }
    }
    if (method === 'POST') {
      if (body.operation === 'run') {
        if (record.paused) throw issue(409, 'Resume the monitor before running a check.')
        await tx.query('INSERT INTO check_runs(monitor_id,manual) VALUES($1,true) ON CONFLICT DO NOTHING', [monitor])
      } else if (body.operation === 'pause') {
        await tx.query('UPDATE monitors SET paused=$2,next_due=CASE WHEN $2 THEN next_due ELSE now() END WHERE id=$1', [monitor,body.paused === true])
      } else if (body.operation === 'settings') {
        await tx.query(`UPDATE monitors SET interval_seconds=$2,timeout_seconds=$3,expected_status=$4,phrase=$5,
          failure_threshold=$6,recovery_threshold=$7,next_due=least(next_due,now()+make_interval(secs=>$2)) WHERE id=$1`, [
          monitor,number(body.interval,60,86400),number(body.timeout,2,120),number(body.expectedStatus,200,599),
          body.phrase ? text(body.phrase,300) : null,number(body.failures,1,10),number(body.recoveries,1,10),
        ])
      } else if (body.operation === 'maintenance') {
        const start = Date.parse(body.start)
        const end = Date.parse(body.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Math.max(start,Date.now())) throw issue(400, 'Enter a valid maintenance window with an end in the future.')
        await tx.query('INSERT INTO maintenance_windows(monitor_id,starts_at,ends_at,suppress) VALUES($1,$2,$3,$4)', [monitor,new Date(start),new Date(end),body.suppress === true])
        await tx.query('UPDATE monitors SET next_due=least(next_due,$2) WHERE id=$1', [monitor,new Date(end)])
      } else throw issue(400, 'Select a monitor action.')
      return { saved: true }
    }
  }
  throw issue(404, 'Monitoring record not found.')
}

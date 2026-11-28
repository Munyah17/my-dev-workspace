import { cpanelUrl,monitorUrl } from '../worker/network.js'

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const taskStates = ['Open','In progress','Awaiting review','Done']
const fail = (status, message) => Object.assign(new Error(message), { status })

function id(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw fail(404, 'Maintenance record not found.')
  return value
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, 'Check the required fields and their length.')
  return value.trim()
}

function dueDate(value) {
  if (!value) return null
  if (!Number.isFinite(Date.parse(value))) throw fail(400, 'Enter a valid due date.')
  return new Date(value)
}

const refs = /^[A-Z][A-Z0-9_]{0,35}$/
const sha = /^[0-9a-f]{40}$/
const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const branches = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,100}$/

function config(provider, input) {
  if (!input || typeof input !== 'object') throw fail(400, 'Enter the connection configuration.')
  if (provider === 'github') {
    const repository = text(input.repository,150)
    const branch = text(input.branch,100)
    const installation = text(input.installation,30)
    const paths = text(input.paths,1000).split(',').map(path => path.trim())
    if (!repo.test(repository) || !branches.test(branch) || branch.includes('..') || !/^\d+$/.test(installation)
      || paths.length > 8 || paths.some(path => !/^[a-zA-Z0-9_./-]+\.php$/.test(path) || path.startsWith('/') || path.split('/').includes('..'))) {
      throw fail(400, 'Enter a repository, installation ID, release branch and up to eight repository-relative PHP files.')
    }
    return { repository,branch,installation,paths }
  }
  if (provider === 'agent') return { model:text(input.model,100) }
  let origin, panel
  try {
    origin = monitorUrl(input.site).origin
    panel = cpanelUrl(input.panel).origin
  } catch {
    throw fail(400, 'Use a public HTTPS site and a public cPanel HTTPS origin on port 443 or 2083.')
  }
  const root = text(input.root,250)
  const repositoryRoot = text(input.repositoryRoot,250)
  const baseline = text(input.baseline,40).toLowerCase()
  if (!root.startsWith('/') || !repositoryRoot.startsWith('/') || !sha.test(baseline)) throw fail(400, 'Enter absolute roots and the known 40-character baseline revision.')
  return {
    origin,panel,root,repositoryRoot,baseline,method:'manual',
    monitor:id(input.monitor),failureStep:input.failureStep ? text(input.failureStep,100) : null,exclusions:text(input.exclusions,500),
  }
}

export async function maintenanceRoute(tx, { method, pathname, body, account }) {
  if (!account.agency) throw fail(404, 'Maintenance record not found.')
  if (!(await tx.query("SELECT to_regclass('workspace_private.maintenance_tasks') IS NOT NULL ready")).rows[0].ready) {
    throw fail(503, 'Private maintenance needs the Phase 3 database migration.')
  }
  const [, , , resource, rawId, action, extra] = pathname.split('/')
  if (extra) throw fail(404, 'Maintenance record not found.')
  const query = async (sql, args) => (await tx.query(sql, args)).rows
  const queue = (kind, project, target) => query('SELECT maintenance_queue($1,$2,$3)', [kind,project,target])
  if (resource === 'attention' && !rawId && method === 'GET') return query(`
    SELECT r.id,'run' AS kind,r.state,p.name project FROM maintenance_runs r
      JOIN maintenance_tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.state='ready'
    UNION ALL
    SELECT rel.id,'release',rel.state,p.name FROM maintenance_releases rel JOIN maintenance_connections c ON c.id=rel.target_id
      JOIN projects p ON p.id=c.project_id WHERE rel.state IN ('verification_failed','target_mismatch')`)
  if (resource === 'projects' && rawId && !action && method === 'GET') {
    const [project] = await query('SELECT id,name FROM projects WHERE id=$1 AND project_allowed(id,true)',[decodeURIComponent(rawId)])
    if (!project) throw fail(404,'Project not found.')
    const connections = await query(`SELECT c.id,c.provider,c.environment,c.account_name,c.configuration,
      (SELECT m.detail FROM maintenance_capabilities m WHERE m.connection_id=c.id AND m.state='verified' ORDER BY m.checked_at DESC LIMIT 1) AS health,
      (SELECT rel.published_sha FROM maintenance_releases rel WHERE rel.target_id=c.id AND rel.published_sha IS NOT NULL ORDER BY rel.approved_at DESC LIMIT 1) AS reported_revision,
      (SELECT r.staged_sha FROM maintenance_runs r WHERE r.staging_connection=c.id AND r.staged_sha IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS tested_revision
      FROM maintenance_connections c WHERE c.project_id=$1 AND c.revoked_at IS NULL ORDER BY provider,environment`,[project.id])
    return { project,connections }
  }
  if (resource === 'catalog' && !rawId && method === 'GET') {
    const projects = await query(`SELECT id,name,maintenance_owner(id) AS editable FROM projects
      WHERE project_allowed(id,true) ORDER BY name`)
    const connections = await query(`SELECT c.id,c.provider,c.project_id,c.environment,c.account_name,c.configuration,
      coalesce((SELECT jsonb_agg(jsonb_build_object('capability',m.capability,'state',m.state,'detail',m.detail,'at',m.checked_at))
        FROM maintenance_capabilities m WHERE m.connection_id=c.id),'[]'::jsonb) AS capabilities
      FROM maintenance_connections c WHERE c.revoked_at IS NULL ORDER BY c.provider,c.environment`)
    const monitors = await query('SELECT id,project_id,environment,name,kind FROM monitors ORDER BY name')
    return { projects,connections,monitors }
  }
  if (resource === 'connections' && method === 'POST') {
    if (!rawId && !action) {
      const project = text(body.project,120)
      const [owner] = await query('SELECT maintenance_owner($1) AS allowed', [project])
      if (!owner.allowed) throw fail(404, 'Project not found.')
      const { provider } = body
      if (!['github','agent','cpanel'].includes(provider)) throw fail(400, 'Select an integration.')
      const environment = provider === 'cpanel' ? body.environment : 'Project'
      if (provider === 'cpanel' && !['Staging','Production'].includes(environment)) throw fail(400, 'Select the cPanel environment.')
      if (!refs.test(body.secretRef ?? '')) throw fail(400, 'Use an uppercase credential reference.')
      const setup = config(provider,body.configuration)
      if (provider === 'cpanel') {
        const [monitor] = await query(`SELECT m.id,m.url,m.kind,coalesce(w.writes,false) AS writes,
          EXISTS(SELECT 1 FROM jsonb_array_elements(w.steps) WITH ORDINALITY fresh(step,position)
            JOIN jsonb_array_elements(w.steps) WITH ORDINALITY assertion(step,position) ON assertion.position>fresh.position
            WHERE fresh.step->>'action'='fresh' AND assertion.step->>'action'='assert') AS fresh_check
          FROM monitors m LEFT JOIN workflows w ON w.id=m.workflow_id WHERE m.id=$1 AND m.project_id=$2 AND m.environment=$3`,
        [setup.monitor,project,environment])
        if (environment === 'Staging' && !setup.failureStep) throw fail(400,'Name the expected failing workflow step.')
        const [failureStep] = environment === 'Staging' ? await query(`SELECT 1 FROM monitors m JOIN workflows w ON w.id=m.workflow_id
          JOIN LATERAL jsonb_array_elements(w.steps) step ON step->>'label'=$2 AND step->>'action'='assert'
          WHERE m.id=$1`,[setup.monitor,setup.failureStep]) : [true]
        if (!failureStep || !monitor || new URL(monitor.url).origin !== setup.origin || (environment === 'Staging' && (monitor.kind !== 'workflow' || !monitor.fresh_check)) ||
          (environment === 'Production' && monitor.writes)) throw fail(400, 'Choose a same-origin staging workflow with a fresh-session assertion or a production-safe check for this project.')
      }
      const [connection] = await query(`INSERT INTO maintenance_connections(project_id,provider,environment,account_name,configuration,secret_ref,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [project,provider,environment,text(body.account,150),setup,body.secretRef,account.id])
      if (!connection) throw fail(409, 'Revoke the existing connection before registering another for this scope.')
      await queue('test',project,connection.id)
      return connection
    }
    const [connection] = await query(`SELECT id,project_id FROM maintenance_connections
      WHERE id=$1 AND revoked_at IS NULL AND maintenance_owner(project_id)`, [id(rawId)])
    if (!connection) throw fail(404, 'Connection not found.')
    if (action === 'test') await queue('test',connection.project_id,connection.id)
    else if (action === 'revoke') {
      if ((await query("SELECT id FROM maintenance_releases WHERE target_id=$1 AND state IN ('preparing','awaiting_manual','verifying')",[connection.id])).length)
        throw fail(409, 'Finish the active release before revoking its target.')
      await query('UPDATE maintenance_connections SET revoked_at=now() WHERE id=$1', [connection.id])
    }
    else throw fail(404, 'Connection action not found.')
    return { saved:true }
  }
  if (resource === 'releases') {
    const select = `SELECT rel.*,c.account_name,c.configuration->>'origin' AS domain,c.configuration->>'repositoryRoot' AS repository_root,c.configuration->>'root' AS document_root,c.project_id,maintenance_owner(c.project_id) AS can_release,r.ticket_id,
      g.configuration->>'repository' AS repository,g.configuration->>'branch' AS release_branch,r.pull_request,
      r.proposed_sha,r.staged_sha,author_name(rel.approved_by) AS approver,r.state AS run_state,s.configuration->>'origin' AS staging_domain
      FROM maintenance_releases rel JOIN maintenance_runs r ON r.id=rel.run_id
      JOIN maintenance_connections c ON c.id=rel.target_id
      JOIN maintenance_connections g ON g.id=r.github_connection JOIN maintenance_connections s ON s.id=r.staging_connection`
    if (method === 'GET' && !rawId) return query(select + ' ORDER BY rel.approved_at DESC')
    const [release] = await query(select + ' WHERE rel.id=$1', [id(rawId)])
    if (!release) throw fail(404, 'Release not found.')
    if (method === 'GET' && !action) {
      const history = await query('SELECT state,observed_sha,evidence,created_at FROM maintenance_release_checks WHERE release_id=$1 ORDER BY created_at DESC', [release.id])
      return { ...release,history }
    }
    if (method === 'POST' && ['deploy','verify'].includes(action)) {
      if (!(await query('SELECT maintenance_owner($1) AS allowed', [release.project_id]))[0].allowed) throw fail(403, 'Release authority is required.')
      if (release.run_state !== 'ready' || release.proposed_sha !== release.commit_sha || release.staged_sha !== release.commit_sha)
        throw fail(409, 'The candidate changed. Verify and approve the tested revision again.')
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', ['maintenance-release:' + release.target_id])
      const [latest] = await query('SELECT state FROM maintenance_releases WHERE id=$1',[release.id])
      if (action === 'deploy' && ['preparing','awaiting_manual','verifying','verified'].includes(latest.state)) return { saved:true }
      const [active] = await query(`SELECT id FROM maintenance_releases WHERE target_id=$1 AND id<>$2
        AND state IN ('preparing','awaiting_manual','verifying')`,[release.target_id,release.id])
      if (active) throw fail(409, 'This deployment target already has an active release.')
      const expected = action === 'deploy' ? ['approved','target_mismatch'] : ['awaiting_manual','verification_failed','verifying']
      if (!expected.includes(latest.state)) throw fail(409, 'That release action is unavailable in the current state.')
      const [changed] = await query(`UPDATE maintenance_releases SET state=$2 WHERE id=$1 AND state=ANY($3::text[]) RETURNING id`,
      [release.id,action === 'deploy' ? 'preparing' : 'verifying',expected])
      if (!changed) throw fail(409, 'The release state changed. Reload and try again.')
      await queue(action === 'deploy' ? 'preflight' : 'production',release.project_id,release.id)
      return { saved:true }
    }
  }
  if (resource === 'runs' && rawId) {
    const [run] = await query(`SELECT r.*,t.project_id,p.name AS project,maintenance_owner(t.project_id) AS can_release,g.configuration->>'repository' AS repository,
      g.configuration->>'branch' AS release_branch,s.configuration->>'origin' AS staging_domain
      FROM maintenance_runs r JOIN maintenance_tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
      JOIN maintenance_connections g ON g.id=r.github_connection JOIN maintenance_connections s ON s.id=r.staging_connection
      WHERE r.id=$1`, [id(rawId)])
    if (!run) throw fail(404, 'Maintenance run not found.')
    const [production] = await query(`SELECT id,configuration FROM maintenance_connections WHERE project_id=$1 AND provider='cpanel'
      AND environment='Production' AND revoked_at IS NULL`, [run.project_id])
    if (method === 'GET' && !action) return { ...run, production }
    if (method === 'POST' && action === 'staging') {
      if (!run.proposed_sha || !['awaiting_staging','ready'].includes(run.state)) throw fail(409, 'The proposal is not ready for staging verification.')
      const [updated] = await query("UPDATE maintenance_runs SET state='staging_queued' WHERE id=$1 AND state IN ('awaiting_staging','ready') RETURNING id", [run.id])
      if (updated) await queue('staging',run.project_id,run.id)
      return { saved:true }
    }
    if (method === 'POST' && action === 'approve') {
      const [owner] = await query('SELECT maintenance_owner($1) AS allowed', [run.project_id])
      if (!owner.allowed) throw fail(403, 'Release authority is required.')
      if (!production || body.target !== production.id || body.sha !== run.proposed_sha ||
        !sha.test(body.sha ?? '') || run.staged_sha !== body.sha || run.state !== 'ready')
        throw fail(409, 'Approve the exact tested revision and current production target.')
      const [release] = await query(`INSERT INTO maintenance_releases(run_id,target_id,commit_sha,approved_by,previous_sha)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [run.id,production.id,body.sha,account.id,production.configuration.baseline])
      return release ?? (await query('SELECT id FROM maintenance_releases WHERE run_id=$1 AND target_id=$2 AND commit_sha=$3',[run.id,production.id,body.sha]))[0]
    }
  }
  if (resource === 'workspaces' && !rawId && method === 'GET') {
    return query('SELECT * FROM maintenance_workspaces()')
  }
  if (resource === 'team' && rawId && !action && method === 'GET') {
    return query('SELECT * FROM maintenance_team($1)', [decodeURIComponent(rawId)])
  }
  if (resource === 'tasks' && !rawId) {
    if (method === 'GET') return query(`
      SELECT t.id,t.title,t.assigned_to,t.due_at,t.state,p.name AS project,
        (SELECT a.name FROM maintenance_team(t.workspace_id) a WHERE a.id=t.assigned_to) AS assignee
      FROM maintenance_tasks t LEFT JOIN projects p ON p.id=t.project_id
      ORDER BY (t.state='Done'),t.due_at NULLS LAST,t.created_at DESC`)
    if (method === 'POST') {
      const workspace = text(body.workspace,120)
      const assignee = text(body.assignee,120)
      if (!(await query('SELECT id FROM maintenance_team($1) WHERE id=$2', [workspace,assignee])).length) throw fail(404, 'Assignee not found.')
      return (await query('INSERT INTO maintenance_tasks(workspace_id,title,assigned_to,due_at,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
        workspace,text(body.title,160),assignee,dueDate(body.due),account.id,
      ]))[0]
    }
  }
  if (resource === 'tasks' && rawId) {
    const [task] = await query('SELECT * FROM maintenance_tasks WHERE id=$1', [id(rawId)])
    if (!task) throw fail(404, 'Task not found.')
    const assignees = task.project_id
      ? await query('SELECT * FROM maintenance_assignees($1)', [task.project_id])
      : await query('SELECT * FROM maintenance_team($1)', [task.workspace_id])
    if (method === 'GET' && !action) {
      const tickets = await query('SELECT t.id,t.subject FROM tickets t JOIN maintenance_task_tickets l ON t.id=l.ticket_id WHERE l.task_id=$1', [task.id])
      const incidents = task.project_id ? await query(`SELECT i.id,m.name,i.recovered_at,
        EXISTS(SELECT 1 FROM maintenance_task_incidents j WHERE j.task_id=$1 AND j.incident_id=i.id) AS linked
        FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE m.project_id=$2 ORDER BY i.opened_at DESC`,[task.id,task.project_id]) : []
      return { ...task, assignees, tickets, incidents }
    }
    if (method === 'POST' && action === 'incident' && task.project_id) {
      const incident = id(body.incident)
      const [matching] = await query('SELECT i.id FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=$1 AND m.project_id=$2',[incident,task.project_id])
      if (!matching) throw fail(404, 'Incident not found.')
      await query('INSERT INTO maintenance_task_incidents VALUES($1,$2) ON CONFLICT DO NOTHING',[task.id,incident])
      return { saved:true }
    }
    if (method === 'POST' && !action) {
      const assignee = text(body.assignee,120)
      if (!assignees.some(item => item.id === assignee)) throw fail(404, 'Assignee not found.')
      if (!taskStates.includes(body.state)) throw fail(400, 'Select a valid task state.')
      await query('UPDATE maintenance_tasks SET assigned_to=$2,due_at=$3,state=$4 WHERE id=$1', [task.id,assignee,dueDate(body.due),body.state])
      return { saved:true }
    }
  }
  if (resource === 'tickets' && rawId) {
    const [ticket] = await query(`
      SELECT t.id,t.project_id,p.workspace_id,t.subject,p.name AS project FROM tickets t JOIN projects p ON p.id=t.project_id
      WHERE t.id=$1 AND project_allowed(t.project_id,true)`, [id(rawId)])
    if (!ticket) throw fail(404, 'Ticket not found.')
    const assignees = await query('SELECT * FROM maintenance_assignees($1)', [ticket.project_id])
    if (method === 'GET' && !action) {
      const tasks = await query(`SELECT t.id,t.title,t.state,t.due_at,t.assigned_to,
        EXISTS(SELECT 1 FROM maintenance_task_tickets l WHERE l.task_id=t.id AND l.ticket_id=$1) AS linked
        FROM maintenance_tasks t WHERE t.project_id=$2 ORDER BY t.created_at DESC`, [ticket.id,ticket.project_id])
      const connections = await query(`SELECT id,provider,environment,account_name,configuration
        FROM maintenance_connections WHERE project_id=$1 AND revoked_at IS NULL ORDER BY provider,environment`, [ticket.project_id])
      const runs = await query('SELECT * FROM maintenance_runs WHERE ticket_id=$1 ORDER BY created_at DESC', [ticket.id])
      return { ticket, assignees, tasks, connections, runs }
    }
    if (method === 'POST' && action === 'investigate') {
      const [task] = await query(`SELECT t.id FROM maintenance_tasks t JOIN maintenance_task_tickets l ON l.task_id=t.id
        WHERE t.id=$1 AND l.ticket_id=$2 AND (t.assigned_to=actor() OR maintenance_owner(t.project_id))`, [id(body.task),ticket.id])
      if (!task) throw fail(404, 'Assigned task not found.')
      const connections = await query(`SELECT c.id,c.provider,c.environment FROM maintenance_connections c
        WHERE c.project_id=$1 AND c.revoked_at IS NULL AND EXISTS(
          SELECT 1 FROM maintenance_capabilities m WHERE m.connection_id=c.id AND m.state='verified')
        ORDER BY c.created_at DESC`, [ticket.project_id])
      const github = connections.find(c => c.provider === 'github')
      const agent = connections.find(c => c.provider === 'agent')
      const staging = connections.find(c => c.provider === 'cpanel' && c.environment === 'Staging')
      if (!github || !agent || !staging) throw fail(409, 'Test GitHub, the maintenance agent, and the staging target before starting.')
      const [run] = await query(`INSERT INTO maintenance_runs(task_id,ticket_id,requested_by,github_connection,agent_connection,staging_connection,prompt)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [task.id,ticket.id,account.id,github.id,agent.id,staging.id,text(body.prompt,2400)])
      if (!run) throw fail(409, 'This task already has an active investigation.')
      await queue('investigate',ticket.project_id,run.id)
      return run
    }
    if (method === 'POST' && action === 'assign') {
      let task
      if (body.existing) {
        task = (await query('SELECT id FROM maintenance_tasks WHERE id=$1 AND project_id=$2', [id(body.existing),ticket.project_id]))[0]
        if (!task) throw fail(404, 'Task not found.')
      } else {
        const assignee = text(body.assignee,120)
        if (!assignees.some(item => item.id === assignee)) throw fail(404, 'Assignee not found.')
        task = (await query(`INSERT INTO maintenance_tasks(workspace_id,project_id,title,assigned_to,due_at,created_by)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [
          ticket.workspace_id,ticket.project_id,text(body.title,160),assignee,dueDate(body.due),account.id,
        ]))[0]
      }
      await query('INSERT INTO maintenance_task_tickets VALUES($1,$2) ON CONFLICT DO NOTHING', [task.id,ticket.id])
      return task
    }
  }
  throw fail(404, 'Maintenance record not found.')
}

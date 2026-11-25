import { useState } from 'react'
import { useRecord } from './useRecord.js'

const formatDate = value => value ? new Date(value).toLocaleString() : '—'
const percent = (part, total) => total ? Math.min(100, 100 * part / total).toFixed(1) + '%' : '—'
const sample = [
  { action: 'navigate', label: 'Open the staff form', path: '/staff' },
  { action: 'fill', label: 'Enter test staff name', selector: '#staff-name', value: 'MyDev Test Barber' },
  { action: 'click', label: 'Save staff record', selector: '#save-staff' },
  { action: 'fresh', label: 'Start a fresh session' },
  { action: 'navigate', label: 'Reopen staff list', path: '/staff' },
  { action: 'assert', label: 'Staff record missing after reload', selector: '#staff-list', value: 'MyDev Test Barber' },
]

export function NeedsAttention({ data }) {
  if (!data) return null
  return <section className="panel">
    <h2>Needs attention</h2>
    {data.incidents.map(item => <a className="row ticket-link" key={item.id} href={'#incident/' + item.id}>
      <div><strong>{item.project} · {item.step || item.name}</strong><small>Updated {formatDate(item.updated_at)} · Review incident</small></div>
      <span className={item.planned ? "badge status-warning" : "badge status-error"}>{item.planned ? 'Planned maintenance' : 'Active incident'}</span>
    </a>)}
    {data.monitors.filter(item => item.needs_attention || item.stale).map(item => <a className="row ticket-link" key={item.id} href={'#apps/' + item.id}>
      <div><strong>{item.project} · {item.name}</strong><small>Last observation {formatDate(item.last_observation)} · Review monitor</small></div>
      <span className="badge status-warning">{item.needs_attention ? 'Monitor needs attention' : 'Monitoring stale'}</span>
    </a>)}
    {!data.incidents.length && !data.monitors.some(item => item.stale || item.needs_attention) && <p className="empty">No monitoring items need attention.</p>}
  </section>
}

function CheckSettings({ monitor, kind, formKey }) {
  return <div className="monitor-fields" key={formKey}>
    <label>Interval (seconds)<input name="interval" type="number" min="60" max="86400" defaultValue={monitor?.interval_seconds ?? (kind === 'workflow' ? 900 : 300)} required /></label>
    <label>Timeout (seconds)<input name="timeout" type="number" min="2" max="120" defaultValue={monitor?.timeout_seconds ?? (kind === 'workflow' ? 60 : 10)} required /></label>
    <label>Failures to open incident<input name="failures" type="number" min="1" max="10" defaultValue={monitor?.failure_threshold ?? 2} required /></label>
    <label>Successes to recover<input name="recoveries" type="number" min="1" max="10" defaultValue={monitor?.recovery_threshold ?? 1} required /></label>
    {kind === 'availability' && <>
      <label>Expected HTTP status<input name="expectedStatus" type="number" min="200" max="599" defaultValue={monitor?.expected_status ?? 200} required /></label>
      <label>Expected page phrase<input name="phrase" maxLength="300" defaultValue={monitor?.phrase ?? ''} /></label>
    </>}
  </div>
}

const settings = fields => ({
  interval: Number(fields.get('interval')), timeout: Number(fields.get('timeout')),
  failures: Number(fields.get('failures')), recoveries: Number(fields.get('recoveries')),
  expectedStatus: Number(fields.get('expectedStatus') ?? 200), phrase: fields.get('phrase'),
})

function History({ runs }) {
  return <div className="monitor-history">{runs.length ? runs.map(run => <article className="row" key={run.id}>
    <div><strong>{run.step || run.outcome || run.state}</strong><small>{formatDate(run.finished_at || run.scheduled_for)} · {run.attempts} attempt{run.attempts === 1 ? '' : 's'}{run.planned ? ' · Planned maintenance' : ''}</small>
      {run.expected && <p>Expected {run.expected}</p>}{run.actual && <p>{run.actual}</p>}
      {run.retry_history?.length > 1 && <ul>{run.retry_history.map(attempt =>
        <li key={attempt.number}>Attempt {attempt.number} · {attempt.state} · {formatDate(attempt.started_at)}</li>
      )}</ul>}</div>
    {run.state && <span className="badge">{run.state}</span>}
  </article>) : <p className="empty">No checks recorded yet.</p>}</div>
}

export function Apps({ data, id, api, revision, busy, action }) {
  const [project, setProject] = useState('')
  const [kind, setKind] = useState('availability')
  const [adding, setAdding] = useState(false)
  const [addingWorkflow, setAddingWorkflow] = useState(false)
  const projects = useRecord(api, 'monitoring/projects', revision)
  const workflows = useRecord(api, 'monitoring/workflows', revision)
  const detail = useRecord(api, id ? 'monitoring/monitor/' + id : null, revision)
  const selected = data?.monitors.find(item => item.id === id)
  const costs = useRecord(api,project ? 'operations/project-costs/' + encodeURIComponent(project) : null,revision)
  const projectDetails = useRecord(api,project ? 'maintenance/projects/' + encodeURIComponent(project) : null,revision)
  const save = (path, value, after) => action(async () => {
    const result = await api(path, value)
    after?.(result)
  })
  function create(event) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    save('monitoring/monitors', {
      ...settings(fields), project, kind, environment: fields.get('environment'), name: fields.get('name'),
      url: fields.get('url'), workflow: fields.get('workflow'),
    }, result => {
      setAdding(false)
      window.location.hash = 'apps/' + result.id
    })
  }
  function createWorkflow(event) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    action(async () => {
      let steps
      try { steps = JSON.parse(fields.get('steps')) } catch { throw new Error('Enter a valid JSON array of steps.') }
      let cleanup
      try { cleanup = fields.get('cleanup').trim() ? JSON.parse(fields.get('cleanup')) : undefined } catch { throw new Error('Enter a valid cleanup JSON array.') }
      await api('monitoring/workflows', { project, steps, cleanup, name: fields.get('name'), secretName: fields.get('secret'), writes: fields.has('writes') })
      setAddingWorkflow(false)
    })
  }
  return <>
    <section className="panel">
      <div className="thread-heading"><div><h2>Monitoring</h2><small>Availability and browser checks by app and environment</small></div>
        <button className="primary" onClick={() => setAdding(value => !value)}>{adding ? 'Close form' : 'Add monitor'}</button>
      </div>
      {(projects.error || workflows.error) && <p role="alert" className="error">{projects.error || workflows.error}</p>}
      <label className="search">{adding ? 'App' : 'Project'}<select value={project} onChange={event => setProject(event.target.value)}>
          <option value="">Choose an app</option>{projects.value?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
      {projectDetails.value && <details className="monitor-details">
        <summary>Repository, targets, and revisions</summary>
        {projectDetails.value.connections.length ? projectDetails.value.connections.map(connection => <article className="row" key={connection.id}>
          <div><strong>{connection.configuration.origin || connection.configuration.repository || connection.configuration.model}</strong>
            <small>{connection.environment} · {connection.account_name}</small>
            {connection.configuration.branch && <small>Release branch {connection.configuration.branch}</small>}
            {connection.tested_revision && <small>Tested revision {connection.tested_revision}</small>}
            {connection.reported_revision && <small>Last observed revision {connection.reported_revision}</small>}
            <small>{connection.health || 'Connection test pending'}</small>
          </div>
        </article>) : <p className="empty">No connections registered for this project.</p>}
      </details>}
      {costs.value?.length>0 && <details className="monitor-details">
        <summary>Recorded project costs</summary>
        {costs.value.map(cost=><div className="row" key={cost.currency}><strong>{cost.currency}</strong>
          <small>Recorded {(Number(cost.recorded)/100).toFixed(2)} · Paid {(Number(cost.paid)/100).toFixed(2)}</small></div>)}
      </details>}
      {adding && <>
        <form className="fields" onSubmit={create}>
          <label>Check type<select value={kind} onChange={event => setKind(event.target.value)}><option value="availability">Availability</option><option value="workflow">Browser workflow</option></select></label>
          <label>Environment<select name="environment" defaultValue="Staging"><option>Staging</option><option>Production</option></select></label>
          <label>Monitor name<input name="name" maxLength="120" required /></label>
          <label>Public HTTPS URL<input name="url" type="url" placeholder="https://example.com" required /></label>
          {kind === 'workflow' && <label>Saved workflow<select name="workflow" required defaultValue=""><option value="" disabled>Choose a workflow</option>
            {workflows.value?.filter(item => item.project_id === project).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>}
          <CheckSettings kind={kind} formKey={kind} />
          <button className="primary" disabled={busy || !project}>Save monitor</button>
        </form>
        {kind === 'workflow' && <details className="monitor-details" open={addingWorkflow} onToggle={event => setAddingWorkflow(event.currentTarget.open)}>
          <summary>Save a workflow</summary>
          <form className="fields" onSubmit={createWorkflow}>
            <label>Workflow name<input name="name" required maxLength="120" /></label>
            <label>Credential secret name<input name="secret" placeholder="STAFF_TEST" /></label>
            <label className="checkbox"><input name="writes" type="checkbox" defaultChecked />Writes test data</label>
            <label>Workflow steps<textarea name="steps" rows="10" defaultValue={JSON.stringify(sample,null,2)} required /></label>
            <label>Cleanup steps for approved production writes<textarea name="cleanup" rows="3" /></label>
            <button disabled={busy || !project}>Save workflow</button>
          </form>
        </details>}
      </>}
      {data?.monitors.map(item => <a className={'row ticket-link' + (id === item.id ? ' active' : '')} href={'#apps/' + item.id} key={item.id}>
        <div><strong>{item.project} · {item.name}</strong><small>{item.environment} · {item.kind === 'availability' ? 'Availability' : 'Workflow'} · Last check {formatDate(item.last_check)}</small></div>
        <span className="badge">{item.paused ? 'Paused' : item.needs_attention ? 'Needs attention' : item.stale ? 'Stale' : item.health}</span>
      </a>)}
      {data && !data.monitors.length && <p className="empty">No monitors yet.</p>}
    </section>
    {detail.error && <p role="alert" className="error">{detail.error}</p>}
    {selected && <section className="panel" key={selected.id}>
      <h2>{selected.project} · {selected.name}</h2>
      <p>{selected.environment} · {selected.run_state ?? 'Waiting for first check'}{selected.in_maintenance ? ' · Planned maintenance' : ''}</p>
      <dl className="monitor-fields">
        <div><dt>Last observed status</dt><dd>{selected.health}</dd></div>
        <div><dt>Last observation</dt><dd>{formatDate(selected.last_observation)}</dd></div>
        <div><dt>Last worker heartbeat</dt><dd>{formatDate(selected.heartbeat)}</dd></div>
        <div><dt>Response time</dt><dd>{selected.duration_ms == null ? '—' : selected.duration_ms + ' ms'}</dd></div>
        <div><dt>Next check</dt><dd>{selected.paused ? 'Paused' : formatDate(selected.next_due)}</dd></div>
        <div><dt>{selected.kind === 'availability' ? 'Observed uptime' : 'Workflow pass rate'} · Last 7 days</dt><dd>{percent(selected.passed,selected.observed)}</dd></div>
        <div><dt>Estimated scheduled coverage · Last 7 days</dt><dd>{percent(selected.observed,selected.expected_samples)} · {selected.observed} observed / {selected.expected_samples} expected</dd></div>
      </dl>
      <div className="monitor-actions">
        <button disabled={busy || selected.paused} onClick={() => save('monitoring/monitor/' + id,{ operation: 'run' })}>Run now</button>
        <button disabled={busy} onClick={() => save('monitoring/monitor/' + id,{ operation: 'pause', paused: !selected.paused })}>{selected.paused ? 'Resume' : 'Pause'}</button>
      </div>
      <details className="monitor-details"><summary>Check settings</summary>
        <form className="fields" onSubmit={event => {
          event.preventDefault()
          save('monitoring/monitor/' + id,{ operation: 'settings', ...settings(new FormData(event.currentTarget)) })
        }}><CheckSettings monitor={selected} kind={selected.kind} /><button disabled={busy}>Save settings</button></form>
      </details>
      <details className="monitor-details"><summary>Schedule maintenance</summary>
        <form className="fields" onSubmit={event => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          const start = new Date(fields.get('start')).toISOString()
          const end = new Date(fields.get('end')).toISOString()
          save('monitoring/monitor/' + id, { operation: 'maintenance', start, end, suppress: fields.has('suppress') })
        }}>
          <label>Starts (local time)<input type="datetime-local" name="start" required /></label>
          <label>Ends (local time)<input type="datetime-local" name="end" required /></label>
          <label className="checkbox"><input type="checkbox" name="suppress" defaultChecked />Suppress alerts during maintenance</label>
          <button disabled={busy}>Save maintenance window</button>
        </form>
        {detail.value?.windows.map(item => <p key={item.id}>{formatDate(item.starts_at)} – {formatDate(item.ends_at)} · {item.suppress ? 'Alerts suppressed' : 'Alerts enabled'}</p>)}
      </details>
      <details className="monitor-details" open><summary>Recent checks</summary><History runs={detail.value?.history ?? []} /></details>
    </section>}
  </>
}

export function Incident({ id, api, revision, busy, action }) {
  const detail = useRecord(api, 'monitoring/incident/' + id, revision)
  if (detail.error) return <section className="panel"><p role="alert">{detail.error}</p></section>
  const incident = detail.value
  if (!incident) return <section className="panel">Opening incident…</section>
  const save = (operation, fields = {}) => action(() => api('monitoring/incident/' + id, { operation, ...fields }))
  return <section className="panel">
    <div className="thread-heading"><div><small>{incident.project} · {incident.environment}</small><h2>{incident.step || incident.name}</h2>
      <p>Last failure {formatDate(incident.last_failure_at)}</p></div>
      <span className={incident.recovered_at ? "badge status-success" : "badge status-error"}>{incident.recovered_at ? 'Recovered' : 'Active incident'}</span>
    </div>
    <dl className="monitor-fields">
      <div><dt>First observed failure</dt><dd>{formatDate(incident.first_failure_at)}</dd></div>
      <div><dt>Confirmed failures</dt><dd>{incident.failure_count}</dd></div>
      <div><dt>Expected result</dt><dd>{incident.expected || '—'}</dd></div>
      <div><dt>Observed result</dt><dd>{incident.actual || '—'}</dd></div>
      <div><dt>Recovery observed</dt><dd>{formatDate(incident.recovered_at)}</dd></div>
      <div><dt>Acknowledged</dt><dd>{formatDate(incident.acknowledged_at)}</dd></div>
    </dl>
    <div className="monitor-actions">
      <button disabled={busy || Boolean(incident.acknowledged_at)} onClick={() => save('acknowledge')}>Acknowledge</button>
      <label>Assign <select value={incident.assigned_to ?? ''} disabled={busy} onChange={event => save('assign',{ account: event.target.value })}><option value="">Unassigned</option>
        {incident.assignees.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label>Link ticket <select value={incident.ticket_id ?? ''} disabled={busy} onChange={event => save('link',{ ticket: event.target.value })}><option value="">No ticket linked</option>
        {incident.tickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.subject}</option>)}</select></label>
    </div>
    {incident.ticket_id && <form className="fields" onSubmit={event => {
      event.preventDefault()
      const form = event.currentTarget
      const fields = new FormData(form)
      action(async () => {
        await api('monitoring/incident/' + id, { operation: 'publish', message: fields.get('message') })
        form.reset()
      })
    }}>
      <a href={'#inbox/' + incident.ticket_id}>Open linked ticket</a>
      <label>Client update<textarea name="message" required maxLength="8000" rows="3" /></label>
      <button className="primary" disabled={busy}>Publish to client thread</button>
    </form>}
    <details className="monitor-details" open><summary>Check and retry history</summary><History runs={incident.history} /></details>
  </section>
}

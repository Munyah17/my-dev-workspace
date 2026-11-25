import { useState } from 'react'
import { useRecord } from './useRecord.js'

const statuses = ['Open','In progress','Awaiting review','Done']
const due = value => value ? new Date(value).toLocaleString() : 'No deadline'
const soon = task => task.state !== 'Done' && task.due_at && new Date(task.due_at).getTime() < Date.now() + 7*86400000

function fields(event) {
  event.preventDefault()
  return new FormData(event.currentTarget)
}

function fieldsDue(data) {
  return data.get('due') ? new Date(data.get('due')).toISOString() : null
}

function localInput(value) {
  if (!value) return ''
  const source = new Date(value)
  return new Date(source.getTime() - source.getTimezoneOffset() * 60000).toISOString().slice(0,16)
}

function TaskRow({ task }) {
  return <a className="row ticket-link" href={'#tasks/' + task.id}>
    <div><strong>{task.title}</strong><small>{task.assignee || 'Assigned'} · {due(task.due_at)}{task.project ? ' · ' + task.project : ''}</small></div>
    <span className="badge">{task.state}</span>
  </a>
}

export function DueTasks({ api, revision }) {
  const tasks = useRecord(api, 'maintenance/tasks', revision)
  const dueSoon = tasks.value?.filter(soon) ?? []
  if (!dueSoon.length) return null
  return <section className="panel"><h2>Tasks due soon</h2>{dueSoon.map(task => <TaskRow key={task.id} task={task} />)}</section>
}

export function TaskBoard({ api, revision, actor, id, action, busy }) {
  const [filter, setFilter] = useState('My tasks')
  const [workspace, setWorkspace] = useState('')
  const [adding, setAdding] = useState(false)
  const listing = useRecord(api, id ? null : 'maintenance/tasks', revision)
  const detail = useRecord(api, id ? 'maintenance/tasks/' + id : null, revision)
  const workspaces = useRecord(api, adding ? 'maintenance/workspaces' : null, revision)
  const team = useRecord(api, adding && workspace ? 'maintenance/team/' + encodeURIComponent(workspace) : null, revision)
  if (detail.error || listing.error) return <p className="error" role="alert">{detail.error || listing.error}</p>
  if (id) {
    const task = detail.value
    if (!task) return <p>Opening task…</p>
    return <section className="panel"><a href="#tasks">All tasks</a><h2>{task.title}</h2>
      <form key={task.id} className="fields" onSubmit={event => {
        const data = fields(event)
        action(() => api('maintenance/tasks/' + task.id, { assignee: data.get('assignee'), state: data.get('state'), due: fieldsDue(data) }))
      }}>
        <Person options={task.assignees} defaultValue={task.assigned_to} />
        <label>Status<select name="state" defaultValue={task.state}>{statuses.map(state => <option key={state}>{state}</option>)}</select></label>
        <label>Due date<input name="due" type="datetime-local" defaultValue={localInput(task.due_at)} /></label>
        <button className="primary" disabled={busy}>Save task</button>
      </form>
      {task.incidents.filter(incident => incident.linked).map(incident =>
        <a className="row ticket-link" href={'#incident/' + incident.id} key={incident.id}>{incident.name} · Review incident</a>)}
      {task.incidents.some(incident => !incident.linked) && <form className="fields monitor-details" onSubmit={event => {
        const data = fields(event)
        action(() => api('maintenance/tasks/' + task.id + '/incident',{ incident:data.get('incident') }))
      }}>
        <label>Incident<select name="incident" required defaultValue=""><option value="">Choose an incident</option>
          {task.incidents.filter(incident => !incident.linked).map(incident => <option key={incident.id} value={incident.id}>{incident.name}</option>)}
        </select></label><button disabled={busy}>Link incident</button>
      </form>}
      {task.tickets.map(ticket => <a className="row ticket-link" key={ticket.id} href={'#maintenance/' + ticket.id}>{ticket.subject}</a>)}
    </section>
  }
  const tasks = listing.value?.filter(task => filter === 'Team board' || (filter === 'Due soon' ? soon(task) : task.assigned_to === actor)) ?? []
  return <section className="panel">
    <div className="monitor-actions">{['My tasks','Team board','Due soon'].map(label =>
      <button key={label} type="button" aria-pressed={filter === label} onClick={() => setFilter(label)}>{label}</button>)}
      <button className="primary" onClick={() => setAdding(value => !value)}>{adding ? 'Close form' : 'New task'}</button>
    </div>
    {adding && <form className="fields" onSubmit={event => {
      const data = fields(event)
      action(async () => {
        const result = await api('maintenance/tasks', { workspace, title: data.get('title'), assignee: data.get('assignee'), due: fieldsDue(data) })
        setAdding(false)
        window.location.hash = 'tasks/' + result.id
      })
    }}>
      <label>Workspace<select value={workspace} required onChange={event => setWorkspace(event.target.value)}>
        <option value="">Choose a workspace</option>{workspaces.value?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
      <label>Task name<input name="title" required maxLength="160" /></label>
      <Person options={team.value ?? []} key={workspace} />
      <label>Due date<input name="due" type="datetime-local" /></label>
      <button className="primary" disabled={busy}>Create task</button>
    </form>}
    {tasks.length ? tasks.map(task => <TaskRow key={task.id} task={task} />) : <p className="empty">No tasks here yet.</p>}
  </section>
}

function Person({ options, defaultValue = '' }) {
  return <label>Assignee<select name="assignee" required defaultValue={defaultValue}>
    <option value="">Choose an assignee</option>{options.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
  </select></label>
}

export function TicketMaintenance({ api, revision, ticketId, action, busy }) {
  const [assigning, setAssigning] = useState(false)
  const [linking, setLinking] = useState(false)
  const { error, value } = useRecord(api, 'maintenance/tickets/' + ticketId, revision)
  if (error) return <p role="alert" className="error">{error}</p>
  if (!value) return <p>Opening maintenance details…</p>
  const linked = value.tasks.filter(task => task.linked)
  return <div className="monitor-details">
    <div className="monitor-actions"><button onClick={() => setAssigning(show => !show)}>{assigning ? 'Close assignment' : 'Assign work'}</button></div>
    {linked.map(task => <a className="row ticket-link" key={task.id} href={'#tasks/' + task.id}><strong>{task.title}</strong><span className="badge">{task.state}</span></a>)}
    {assigning && <>
      <div className="monitor-actions">
        <button aria-pressed={!linking} onClick={() => setLinking(false)}>Create task</button>
        <button aria-pressed={linking} onClick={() => setLinking(true)}>Link existing task</button>
      </div>
      <form className="fields" onSubmit={event => {
        const data = fields(event)
        action(async () => {
          await api('maintenance/tickets/' + ticketId + '/assign', linking ? { existing: data.get('existing') } : {
            title:data.get('title'), assignee:data.get('assignee'), due:fieldsDue(data),
          })
          setAssigning(false)
        })
      }}>
        {linking ? <label>Existing task<select name="existing" required defaultValue=""><option value="">Choose a task</option>
          {value.tasks.filter(task => !task.linked).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select></label> : <>
          <label>Task name<input name="title" maxLength="160" required defaultValue={value.ticket.subject} /></label>
          <Person options={value.assignees} />
          <label>Due date<input name="due" type="datetime-local" /></label>
        </>}
        <button className="primary" disabled={busy}>Save assignment</button>
      </form>
    </>}
    <Investigation value={value} api={api} action={action} busy={busy} />
  </div>
}

function Investigation({ value,api,action,busy }) {
  const linked = value.tasks.filter(task => task.linked)
  const github = value.connections.find(item => item.provider === 'github')
  const agent = value.connections.find(item => item.provider === 'agent')
  const staging = value.connections.find(item => item.provider === 'cpanel' && item.environment === 'Staging')
  const available = linked.length > 0 && github && agent && staging
  return <section className="monitor-details">
    <h3>Maintenance investigation</h3>
    {available ? <form className="fields" onSubmit={event => {
      const data = fields(event)
      action(async () => {
        const run = await api('maintenance/tickets/' + value.ticket.id + '/investigate',{ task:data.get('task'),prompt:data.get('prompt') })
        window.location.hash = 'releases/run-' + run.id
      })
    }}>
      <p>{value.ticket.project} · {github.configuration.repository} · {github.configuration.branch}</p>
      <p>Staging target <strong>{staging.configuration.origin}</strong> · {agent.account_name}</p>
      <label>Repair task<select name="task">{linked.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label>Request for @Maintenance<textarea name="prompt" required rows="3" maxLength="2400" placeholder="Describe what to reproduce and verify on staging." /></label>
      <button className="primary" disabled={busy}>Start staging investigation</button>
    </form> : <p className="empty">Link a repair task and configure GitHub, a Maintenance agent, and cPanel staging to start.</p>}
    {value.runs.map(run => <a className="row ticket-link" key={run.id} href={'#releases/run-' + run.id}>
      <strong>{run.proposed_sha ? 'Proposed fix · ' + run.proposed_sha.slice(0,8) : 'Maintenance investigation'}</strong>
      <span className="badge">{state(run.state)}</span>
    </a>)}
  </section>
}

const labels = { github:'GitHub',agent:'Maintenance agent',cpanel:'cPanel' }
const descriptions = {
  github:'Read an authorized repository and prepare changes for review.',
  agent:'Investigate the linked ticket and propose scoped PHP changes.',
  cpanel:'Test account access, establish the baseline, and verify a Git deployment.',
}
const entries = {
  github:[['installation','GitHub App installation ID'],['repository','Owner/repository'],['branch','Release branch'],['paths','Allowed PHP paths (comma-separated)']],
  agent:[['model','OpenAI model']],
  cpanel:[['panel','cPanel HTTPS service origin'],['site','Public site HTTPS origin'],['root','Document root'],['repositoryRoot','cPanel repository root'],['baseline','Known baseline commit SHA'],['exclusions','Runtime files, media and persistent data to exclude']],
}

const state = value => ({
  awaiting_manual:'Awaiting manual deployment',awaiting_staging:'Awaiting staging verification',staging_queued:'Staging verification queued',
  verification_failed:'Production verification failed',target_mismatch:'Target or revision mismatch',ready:'Fix ready for review',
  verified:'Production check passed',verifying:'Verifying the live revision',not_reproduced:'Issue not reproduced',
  no_proposal:'No safe proposal',blocked:'Investigation blocked',
})[value] ?? String(value).replaceAll('_',' ').replace(/^./,character => character.toUpperCase())

export function Integrations({ api, revision, action, busy }) {
  const catalog = useRecord(api,'maintenance/catalog',revision)
  const [provider,setProvider] = useState('')
  const [project,setProject] = useState('')
  const [environment,setEnvironment] = useState('Staging')
  const [preview,setPreview] = useState(null)
  if (catalog.error) return <p className="error" role="alert">{catalog.error}</p>
  if (!catalog.value) return <p>Opening integrations…</p>
  const { projects,connections,monitors } = catalog.value
  const name = id => projects.find(item => item.id === id)?.name ?? id
  return <section className="panel">
    <h2>Integrations</h2>
    {Object.entries(labels).map(([key,label]) => <div className="row" key={key}>
      <div><strong>{label}</strong><small>{descriptions[key]}</small></div>
      {projects.some(item => item.editable) && <button onClick={() => { setProvider(key); setPreview(null) }}>Connect {label}</button>}
    </div>)}
    {provider && !preview && <form className="fields monitor-details" key={provider} onSubmit={event => {
      const values = fields(event)
      setPreview({
        provider,project,environment,account:values.get('account'),secretRef:values.get('secretRef'),
        configuration:Object.fromEntries([...entries[provider].map(([field]) => [field,values.get(field)]),['monitor',values.get('monitor')],['failureStep',values.get('failureStep')]]),
      })
    }}>
      <h3>Connect {labels[provider]}</h3>
      <label>Project scope<select value={project} required onChange={event => setProject(event.target.value)}><option value="">Choose a project</option>
        {projects.filter(item => item.editable).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>Authorized account<input name="account" required /></label>
      <label>Worker credential reference<input name="secretRef" pattern="[A-Z][A-Z0-9_]{0,35}" required /></label>
      {provider === 'cpanel' && <label>Target environment<select value={environment} onChange={event => setEnvironment(event.target.value)}><option>Staging</option><option>Production</option></select></label>}
      {entries[provider].map(([field,label]) => <label key={field}>{label}<input name={field} required /></label>)}
      {provider === 'cpanel' && environment === 'Staging' && <label>Expected failing assertion label<input name="failureStep" required maxLength="100" /></label>}
      {provider === 'cpanel' && <label>Verification monitor<select name="monitor" key={project+environment} required defaultValue=""><option value="">Choose a monitor</option>
        {monitors.filter(item => item.project_id === project && item.environment === environment).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      <button className="primary">Review authorization</button>
    </form>}
    {preview && <div className="monitor-details">
      <h3>Review {labels[preview.provider]} scope</h3>
      <p>{preview.account} · {name(preview.project)}{provider === 'cpanel' ? ' · ' + preview.environment : ''}</p>
      <p>{preview.configuration.site ?? preview.configuration.repository ?? preview.configuration.model}</p>
      <p>Store the credential in the Fly worker before testing. The connection test reports each capability separately.</p>
      <div className="monitor-actions"><button onClick={() => setPreview(null)}>Back</button><button className="primary" disabled={busy} onClick={() => action(async () => {
        await api('maintenance/connections',preview)
        setPreview(null)
        setProvider('')
      })}>Save and test</button></div>
    </div>}
    <div className="monitor-details">
      <h3>Registered connections</h3>
      {connections.length ? connections.map(item => <article className="row" key={item.id}>
        <div><strong>{labels[item.provider]} · {item.account_name}</strong><small>{name(item.project_id)} · {item.environment}</small>
          <p>{item.configuration.origin || item.configuration.repository || item.configuration.model}</p>
          {item.configuration.baseline && <small>Saved baseline {item.configuration.baseline}</small>}
          {item.capabilities.length ? item.capabilities.map(cap => <p key={cap.capability}><strong>{cap.capability} · {state(cap.state)}</strong><br />{cap.detail}</p>)
            : <p className="empty">Connection tests pending.</p>}
        </div>
        {projects.find(project => project.id===item.project_id)?.editable && <div className="monitor-actions">
          <button disabled={busy} onClick={() => action(() => api('maintenance/connections/' + item.id + '/test',{}))}>Test again</button>
          <button disabled={busy} onClick={() => action(() => api('maintenance/connections/' + item.id + '/revoke',{}))}>Revoke</button>
        </div>}
      </article>) : <p className="empty">No integrations registered.</p>}
    </div>
  </section>
}

function Evidence({ evidence }) {
  if (!evidence) return null
  return <div className="monitor-details">
    {evidence.reported && <p>Reported: {evidence.reported}</p>}
    {evidence.reproduced !== undefined && <p>{evidence.reproduced ? 'Reproduced on staging.' : 'The investigation did not reproduce the issue.'}</p>}
    {evidence.cause && <p>{evidence.cause}</p>}
    {evidence.lint && <p>{evidence.lint}</p>}
    {evidence.baseline && <p>Baseline check: {evidence.baseline.actual || evidence.baseline.outcome}</p>}
    {evidence.staging && <p>Candidate check: {evidence.staging.actual || evidence.staging.outcome}{evidence.staging.revision ? ' · ' + evidence.staging.revision : ''}</p>}
    {evidence.staging?.checks?.length > 0 && <ul>{evidence.staging.checks.map((check,index) => <li key={index}>{check.step} · {check.outcome}</li>)}</ul>}
    {evidence.manual && <p>Release notes: {evidence.manual}</p>}
    {evidence.files?.map(file => <details className="monitor-details" key={file.path}><summary>{file.path}</summary><pre className="maintenance-diff">{file.diff}</pre></details>)}
  </div>
}

export function ReleaseBoard({ api,revision,id,action,busy }) {
  const isRun = id?.startsWith('run-')
  const { value,error } = useRecord(api,isRun ? 'maintenance/runs/' + id.slice(4) : id ? 'maintenance/releases/' + id : 'maintenance/releases',revision)
  if (error) return <p className="error" role="alert">{error}</p>
  if (!value) return <p>Opening release records…</p>
  if (!id) return <section className="panel"><h2>Release history</h2>{value.length ? value.map(release =>
    <a key={release.id} className="row ticket-link" href={'#releases/' + release.id}><div><strong>{release.domain}</strong><small>{release.commit_sha}</small></div><span className="badge">{state(release.state)}</span></a>
  ) : <p className="empty">No release approvals yet. Start with a ticket in Private maintenance.</p>}</section>
  if (isRun) return <section className="panel">
    <a href={'#maintenance/' + value.ticket_id}>Open original ticket</a>
    <h2>{value.proposed_sha ? 'Proposed fix' : 'Maintenance investigation'}</h2>
    <p>{value.project} · {value.repository} · {state(value.state)}</p>
    {value.base_sha && <p>Baseline <code>{value.base_sha}</code></p>}
    {value.proposed_sha && <p>Candidate <code>{value.proposed_sha}</code> · {value.evidence?.branch}</p>}
    {value.pull_request && <a href={'https://github.com/' + value.repository + '/pull/' + value.pull_request} target="_blank" rel="noreferrer">Open GitHub pull request</a>}
    <details className="monitor-details" open><summary>Review changes and evidence</summary><Evidence evidence={value.evidence} /></details>
    {value.state === 'awaiting_staging' && <div className="monitor-details">
      <p>Deploy the exact candidate to {value.staging_domain}, then run the staging check.</p>
      <button className="primary" disabled={busy} onClick={() => action(() => api('maintenance/runs/' + value.id + '/staging',{}))}>Verify staging revision</button>
    </div>}
    {value.state === 'ready' && value.production && value.can_release && <div className="monitor-details">
      <h3>Approve production release</h3>
      <p>{value.production.configuration.origin} · <code>{value.staged_sha}</code></p>
      <p>Manual cPanel Git deployment. Known recovery baseline <code>{value.production.configuration.baseline}</code>.</p>
      <button className="primary" disabled={busy} onClick={() => action(async () => {
        const release = await api('maintenance/runs/' + value.id + '/approve',{ target:value.production.id,sha:value.staged_sha })
        window.location.hash = 'releases/' + release.id
      })}>Approve exact revision</button>
    </div>}
  </section>
  return <section className="panel"><a href={'#maintenance/' + value.ticket_id}>Open original ticket</a><h2>{state(value.state)}</h2>
    <dl className="monitor-fields">
      <div><dt>Production target</dt><dd>{value.domain}</dd></div>
      <div><dt>Approved revision</dt><dd><code>{value.commit_sha}</code></dd></div>
      <div><dt>Last observed revision</dt><dd><code>{value.published_sha || 'Awaiting observation'}</code></dd></div>
      <div><dt>Approved by</dt><dd>{value.approver || value.approved_by} · {due(value.approved_at)}</dd></div>
      <div><dt>Known recovery revision</dt><dd><code>{value.previous_sha || 'Unrecorded'}</code></dd></div>
      <div><dt>Post-release check</dt><dd>{value.verification || 'Awaiting verification'}</dd></div>
    </dl>
    {value.can_release && ['approved','target_mismatch'].includes(value.state) && <button className="primary" disabled={busy} onClick={() => action(() => api('maintenance/releases/' + value.id + '/deploy',{}))}>Start manual deployment</button>}
    {['awaiting_manual','verification_failed'].includes(value.state) && <>
      {value.published_sha !== value.commit_sha && <ol>
        <li>Open Git Version Control in cPanel and manage <code>{value.repository_root}</code>.</li>
        <li>Update the repository through the site’s approved Git procedure. Confirm HEAD is exactly <code>{value.commit_sha}</code>.</li>
        <li>Choose Deploy HEAD Commit for <code>{value.document_root}</code>, then verify the live revision here.</li>
      </ol>}
      {value.can_release && <button className="primary" disabled={busy} onClick={() => action(() => api('maintenance/releases/' + value.id + '/verify',{}))}>Verify live revision and check</button>}
    </>}
    {value.history?.length > 0 && <details className="monitor-details"><summary>Deployment verification history</summary>
      {value.history.map((check,index) => <div className="row" key={check.created_at + index}>
        <div><strong>{state(check.state)}</strong><small>{due(check.created_at)}</small><p>{check.evidence.verification}</p></div>
      </div>)}
    </details>}
  </section>
}

export function ReleaseAttention({ api,revision }) {
  const { value } = useRecord(api,'maintenance/attention',revision)
  if (!value?.length) return null
  return <section className="panel"><h2>Maintenance needs attention</h2>
    {value.map(item => <a className="row ticket-link" key={item.id} href={'#releases/' + (item.kind === 'run' ? 'run-' : '') + item.id}>
      <strong>{item.project} · {state(item.state)}</strong><small>Review {item.kind === 'run' ? 'fix' : 'release'}</small>
    </a>)}
  </section>
}

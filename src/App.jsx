import { useEffect, useState } from 'react'
import './App.css'

const states = ['New', 'In progress', 'Awaiting agency', 'Awaiting client', 'Resolved', 'Reopened']
const sections = { today: 'Today', inbox: 'Client inbox', maintenance: 'Private maintenance' }
const date = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const result = await response.json()
    throw Object.assign(new Error(result.error), { status: response.status })
  }
  return response.json()
}

function upload(file) {
  if (!file?.size) return undefined
  if (file.size > 1024 * 1024) throw new Error('Attachments are limited to 1 MB.')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The attachment could not be read.'))
    reader.onload = () => resolve({ name: file.name, content: reader.result.split(',')[1] })
    reader.readAsDataURL(file)
  })
}

function currentRoute() {
  const [section, id] = window.location.hash.slice(1).split('/')
  return { section: Object.hasOwn(sections, section) ? section : 'today', id }
}

export default function App() {
  const [user, setUser] = useState(undefined)
  const [demo, setDemo] = useState(false)
  const [route, setRoute] = useState(currentRoute)
  const [tickets, setTickets] = useState([])
  const [projects, setProjects] = useState([])
  const [notifications, setNotifications] = useState([])
  const [ticket, setTicket] = useState(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)

  function clearSession() {
    setUser(null)
    setTickets([])
    setProjects([])
    setNotifications([])
    setTicket(null)
    setQuery('')
    setSearchResults(null)
    setDetailError('')
  }

  useEffect(() => {
    const change = () => { setRoute(currentRoute()); setError('') }
    window.addEventListener('hashchange', change)
    api('config').then(result => setDemo(result.demo)).catch(() => {})
    api('me').then(setUser).catch(problem => { setUser(null); if (problem.status !== 401) setError(problem.message) })
    return () => window.removeEventListener('hashchange', change)
  }, [])

  useEffect(() => {
    if (!user) return
    let active = true
    const refresh = async () => {
      try {
        const [nextTickets, nextProjects, nextNotifications] = await Promise.all([api('tickets'), api('projects'), api('notifications')])
        if (active) { setTickets(nextTickets); setProjects(nextProjects); setNotifications(nextNotifications) }
      } catch (problem) {
        if (active && problem.status === 401) clearSession()
        else if (active) setError(problem.message)
      }
    }
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [user, revision])

  useEffect(() => {
    if (!user || !query.trim()) return
    let active = true
    api('tickets?q=' + encodeURIComponent(query.trim()))
      .then(results => { if (active) setSearchResults(results) })
      .catch(problem => { if (active) setError(problem.message) })
    return () => { active = false }
  }, [user, query, revision])

  useEffect(() => {
    if (!user || !route.id || route.id === 'new') return
    let active = true
    const refresh = () => api('tickets/' + encodeURIComponent(route.id))
      .then(result => { if (active) { setTicket(result); setDetailError('') } })
      .catch(problem => { if (active) { setTicket(null); setDetailError(problem.message) } })
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [user, route.id, revision])

  async function action(task) {
    setBusy(true)
    setError('')
    try { await task(); setRevision(value => value + 1) }
    catch (problem) { setError(problem.message) }
    finally { setBusy(false) }
  }

  async function signIn(email, password) {
    await api('login', { email, password })
    setUser(await api('me'))
  }

  async function send(event, creating) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    await action(async () => {
      const payload = { message: fields.get('message'), attachment: await upload(fields.get('attachment')) }
      if (creating) {
        const created = await api('tickets', { ...payload, project: fields.get('project'), subject: fields.get('subject') })
        window.location.hash = 'inbox/' + created.id
      } else {
        await api('tickets/' + route.id + '/reply', { ...payload, internal: fields.has('internal') })
      }
      form.reset()
    })
  }

  if (user === undefined) return <main className="login"><p>Opening workspace…</p></main>
  if (!user) return <main className="login">
    <div className="login-card">
      <Brand />
      <h1>Sign in to your workspace</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <form className="fields" onSubmit={event => {
        event.preventDefault()
        const fields = new FormData(event.currentTarget)
        action(() => signIn(fields.get('email'), fields.get('password')))
      }}>
        <label>Email<input name="email" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="primary" disabled={busy}>Sign in</button>
      </form>
      {demo && <div className="demo"><strong>Demo accounts</strong><div className="demo-buttons">
        {[['Agency', 'agency'], ['The Gents', 'gents'], ['Harbor Studio', 'other']].map(([label, account]) =>
          <button key={account} disabled={busy} onClick={() => action(() => signIn(account + '@example.test', 'workspace-demo'))}>{label}</button>
        )}
      </div></div>}
    </div>
  </main>

  const section = route.section === 'maintenance' && !user.agency ? 'inbox' : route.section
  const visibleTicket = ticket?.id === route.id ? ticket : null
  const unread = notifications.filter(item => !item.read)
  const displayedTickets = query.trim() ? searchResults ?? [] : tickets
  return <div className="workspace">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Workspace">{Object.entries(sections).filter(([key]) => key !== 'maintenance' || user.agency).map(([key, label], index) =>
        <a key={key} href={'#' + key} aria-current={section === key ? 'page' : undefined}><span aria-hidden="true">{['◉', '▤', '◇'][index]}</span>{label}</a>
      )}</nav>
      <div className="account">
        <div className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</div>
        <div><strong>{user.name}</strong><small>{user.agency ? 'Agency' : 'Client'}</small></div>
        <button disabled={busy} onClick={() => action(async () => {
          await api('logout', {})
          clearSession()
        })}>Sign out</button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><span>{sections[section]}</span>{demo && <span className="badge demo-badge">Demo workspace</span>}</header>
      <div className="content">
        {error && <p role="alert" className="error">{error}</p>}
        <div className="heading">
          <div><h1>{sections[section]}</h1>
            <p>{section === 'today' ? 'Support activity across your authorized projects.' : section === 'inbox' ? 'Report an issue and keep the conversation in one place.' : 'Review tickets, record internal notes, and prepare staging work.'}</p></div>
          <a className="primary" href="#inbox/new">{user.agency ? 'New ticket' : 'Report an issue'}</a>
        </div>
        {section === 'today' ? <>
          <div className="metrics">
            <Metric label="Open tickets" value={tickets.filter(item => item.state !== 'Resolved').length} />
            <Metric label="Unread updates" value={unread.length} />
            <Metric label="Projects" value={projects.length} />
          </div>
          <section className="panel">
            <h2>Notifications</h2>
            {notifications.length ? notifications.map(item => <div key={item.id} className="row">
              <a href={'#inbox/' + item.ticket_id} onClick={() => {
                if (!item.read) action(() => api('notifications/' + item.id + '/read', {}))
              }}><strong>{item.subject}</strong><small>{date(item.created_at)}</small></a>
              {!item.read && <span className="badge">Unread</span>}
            </div>) : <p className="empty">New ticket activity will appear here.</p>}
          </section>
        </> : <div className="inbox">
          <section className="panel ticket-list">
            <h2>Tickets</h2>
            <label className="search">Search tickets<input type="search" placeholder="Search by subject" value={query} onChange={event => { setSearchResults(null); setQuery(event.target.value) }} /></label>
            {displayedTickets.length ? displayedTickets.map(item => <a className={'row ticket-link' + (route.id === item.id ? ' active' : '')} key={item.id} href={'#' + section + '/' + item.id}>
              <div><strong>{item.subject}</strong><small>{item.project}</small></div><span className="badge">{item.state}</span>
            </a>) : <p className="empty">{query.trim() ? 'No matching tickets.' : 'No tickets yet.'}</p>}
          </section>
          <section className="panel thread" key={route.id ?? section}>
            {route.id === 'new' ? <>
              <h2>Report an issue</h2>
              <form className="fields" onSubmit={event => send(event, true)}>
                <label>Project<select name="project" required defaultValue=""><option value="" disabled>Choose a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                <label>Subject<input name="subject" maxLength="160" required placeholder="What went wrong?" /></label>
                <label>Message<textarea name="message" rows="5" maxLength="8000" required placeholder="Tell us what happened" /></label>
                <label>Attachment <small>(optional, up to 1 MB)</small><input type="file" name="attachment" /></label>
                <button className="primary" disabled={busy || !projects.length}>Send report</button>
              </form>
            </> : visibleTicket ? <>
              <div className="thread-heading"><div><small>{visibleTicket.project}</small><h2>{visibleTicket.subject}</h2></div>
                {visibleTicket.agency ? <label className="state">Status<select value={visibleTicket.state} disabled={busy} onChange={event => action(() => api('tickets/' + visibleTicket.id + '/state', { state: event.target.value }))}>{states.map(state => <option key={state}>{state}</option>)}</select></label> : <span className="badge">{visibleTicket.state}</span>}
              </div>
              {section === 'maintenance' && <p className="notice">Engineering agent, staging, GitHub, and cPanel integrations are unconfigured.</p>}
              <div className="messages">{visibleTicket.messages.map(message => <article key={message.id} className={message.internal ? 'message internal' : message.mine ? 'message mine' : 'message'}>
                <div><strong>{message.author}</strong>{message.internal && <span className="badge">Internal note</span>}<small>{date(message.created_at)}</small></div>
                <p>{message.body}</p>
                {message.attachments.map(file => <a key={file.id} href={'/api/attachments/' + file.id}>{file.name}</a>)}
              </article>)}</div>
              <form className="fields reply" onSubmit={event => send(event, false)}>
                <label>Reply<textarea name="message" rows="3" maxLength="8000" required /></label>
                <label>Attachment <small>(optional, up to 1 MB)</small><input type="file" name="attachment" /></label>
                {visibleTicket.agency && <label className="checkbox"><input type="checkbox" name="internal" />Internal note</label>}
                <button className="primary" disabled={busy}>Send reply</button>
              </form>
            </> : <p className="empty">{route.id ? detailError || 'Opening ticket…' : 'Select a ticket to open its conversation.'}</p>}
          </section>
        </div>}
      </div>
    </main>
  </div>
}

function Brand() {
  return <div className="brand"><span aria-hidden="true">M</span>MyDev Workspace</div>
}

function Metric({ label, value }) {
  return <div className="panel metric"><span>{label}</span><strong>{value}</strong></div>
}

import { useState } from 'react'
import { buildStackWorkflow,stackTargets } from './stack-workflow.js'
import { useRecord } from './useRecord.js'

const aiProviders=['Devin','Cursor','Claude','Codex','ChatGPT','Grok']
const infrastructure=['Vercel','Supabase','Cloudflare','Firebase','Netlify','WHM','cPanel']
const operationsProviders=['Stripe','Sentry','GitHub Actions']
const promptProviders=['Claude','Codex','ChatGPT','Grok']
const scopeLabels={
  Grok:'xAI model ID',Devin:'Devin organization ID',Claude:'Claude model ID',Codex:'OpenAI Codex model ID',ChatGPT:'OpenAI GPT model ID',
  Vercel:'Vercel project ID or project ID/team ID',Supabase:'Supabase project reference',Cloudflare:'Cloudflare zone ID',
  Firebase:'Firebase project ID',Netlify:'Netlify site ID',
  'GitHub Actions':'Repository and workflow ref (owner/repo/ref)',
  WHM:'WHM hostname/username',cPanel:'cPanel hostname/username',Stripe:'Stripe account ID',Sentry:'Sentry organization/project slug',
}
const providers=[...aiProviders,...infrastructure,...operationsProviders]
const kinds={'credit-note':'Credit note','debit-note':'Debit note',notice:'Notice',claim:'Claim',proposal:'Proposal',boq:'Bill of Quantities',bom:'Bill of Materials'}
const directions={collection:'Collect from client',supplier:'Pay supplier',domain:'Renew domain'}
const today=()=>new Date().toISOString().slice(0,10)
const date=value=>String(value??'').slice(0,10)
const minor=value=>Math.round(Number(value)*100)
const money=(amount,code)=>code+' '+(Number(amount)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})
const form=event=>{event.preventDefault();return Object.fromEntries(new FormData(event.currentTarget))}
const sectionLinks={crm:'CRM',billing:'Quotes and invoices',orders:'Orders',inventory:'Inventory',transactions:'Transactions'}

function AgencyIntegrations({api,workspace,action,busy,providers}){
  const [report,setReport]=useState(null)
  const [appTag,setAppTag]=useState('')
  const [filters,setFilters]=useState(null)
  const [knownTags,setKnownTags]=useState([])
  const [hosting,setHosting]=useState(null)
  const [issues,setIssues]=useState(null)
  const scope=new URLSearchParams({workspace}).toString()
  const rows=new Map()
  for(const [code,value] of Object.entries(report?.stripe??{})) rows.set(code,{...value})
  for(const item of report?.paynow??[]){
    const row=rows.get(item.currency)??{gross:0,refund:0}
    rows.set(item.currency,{gross:row.gross+Number(item.gross),refund:row.refund+Number(item.refund)})
  }
  const amount=(value,code)=>{
    const format=new Intl.NumberFormat(undefined,{style:'currency',currency:code,currencyDisplay:'code'})
    const digits=['isk','ugx'].includes(code)?2:format.resolvedOptions().maximumFractionDigits
    return format.format(value/10**digits)
  }
  const loadCollections=values=>{
    setReport(null)
    setFilters(null)
    action(async()=>{
      const result=await api('developer-tools/collections?'+new URLSearchParams({workspace,...values}))
      setReport(result)
      setFilters(values)
      if(!values.app.trim()) setKnownTags([...new Set((result.byApp??[]).map(row=>row.app).filter(Boolean))])
    })
  }
  return <section className="monitor-details">
    <h3>Collections reporting</h3>
    <p>Shows captured payments less recorded refunds, grouped by currency. Refunds follow the original payment date. Fees and payouts are tracked separately by your provider.</p>
    <form className="fields" onSubmit={event=>loadCollections(form(event))}>
      <label>From<input type="date" name="start" required defaultValue={today().slice(0,7)+'-01'} /></label>
      <label>Through<input type="date" name="end" required defaultValue={today()} /></label>
      <label>Payment provider<select name="provider"><option value="all">All providers</option><option value="stripe">Stripe</option><option value="paynow">Paynow</option></select></label>
      <label>App or business tag<input name="app" maxLength="120" list="collection-tags" value={appTag} onChange={event=>setAppTag(event.target.value)} /></label>
      <datalist id="collection-tags">{knownTags.map(tag=><option key={tag} value={tag} />)}</datalist>
      <small>Run the report with the tag blank to discover tags from Stripe charges and Paynow records.</small>
      <button disabled={busy}>View collections</button>
    </form>
    {report && <div>
      {report.stripe===null && <p>Stripe data is excluded. Check the provider filter and connection status.</p>}
      {filters?.app.trim() && <button disabled={busy} onClick={()=>{setAppTag('');loadCollections({...filters,app:''})}}>Show all apps and businesses</button>}
      {!rows.size && <p>No matching collections.</p>}
      {[...rows].map(([code,row])=><p key={code}>
        {amount(row.gross,code)} captured · {amount(row.refund,code)} refunded · {amount(row.gross-row.refund,code)} after refunds
      </p>)}
      {report.byApp?.length>0 && !filters?.app.trim() && <details className="monitor-details">
        <summary>Breakdown by app or business</summary>
        {report.byApp.map(row=><div className="row" key={JSON.stringify([row.app,row.currency])}>
          <div><strong>{row.app||'Untagged'}</strong><small>{amount(row.gross-row.refund,row.currency)} after refunds</small></div>
          {row.app && <button disabled={busy} onClick={()=>{setAppTag(row.app);loadCollections({...filters,app:row.app})}}>Filter by {row.app}</button>}
        </div>)}
      </details>}
    </div>}
    <details className="monitor-details"><summary>Record a settled Paynow collection</summary>
      <form className="fields" onSubmit={event=>{
        const element=event.currentTarget
        const values=form(event)
        action(async()=>{
          await api('developer-tools/collections/paynow',{...values,workspace,gross:minor(values.gross),refund:minor(values.refund)})
          element.reset()
          setReport(null)
        })
      }}>
        <label>Paynow reference<input name="reference" maxLength="120" required /></label>
        <label>Payment date<input type="date" name="date" required defaultValue={today()} /></label>
        <label>Currency<select name="currency">{['USD','ZWG','ZWL','ZAR'].map(code=><option key={code}>{code}</option>)}</select></label>
        <label>Gross collected<input type="number" min=".01" step=".01" name="gross" required /></label>
        <label>Refunds already recorded<input type="number" min="0" step=".01" name="refund" /></label>
        <label>App or business tag<input name="app" maxLength="120" /></label>
        <button disabled={busy}>Save Paynow collection</button>
      </form>
    </details>
    {providers.some(provider=>['WHM','cPanel'].includes(provider)) && <div className="monitor-details">
      <h3>Hosting inventory</h3>
      {['WHM','cPanel'].filter(provider=>providers.includes(provider)).map(provider=><button key={provider} disabled={busy}
        onClick={()=>{setHosting(null);action(async()=>setHosting({provider,rows:await api('developer-tools/hosting/'+provider+'?'+scope)}))}}>View {provider} accounts or domains</button>)}
      {hosting && providers.includes(hosting.provider) && (hosting.rows.length ? hosting.rows.map(item=><div className="row" key={item.domain}>
        <strong>{item.domain}</strong><small>{item.user}{item.suspended?' · Suspended':''}</small>
      </div>) : <p>No accounts or domains returned.</p>)}
    </div>}
    {providers.includes('Sentry') && <div className="monitor-details">
      <h3>Sentry issues</h3>
      <button disabled={busy} onClick={()=>{setIssues(null);action(async()=>setIssues(await api('developer-tools/sentry?'+scope)))}}>Load unresolved issues</button>
      {issues?.length===0 && <p>No unresolved issues returned.</p>}
      {issues?.map(issue=><div className="row" key={issue.id}><div><strong>{issue.key} · {issue.title}</strong><small>{date(issue.lastSeen)}</small></div>
        <button disabled={busy} onClick={()=>action(async()=>{
          const task=await api('developer-tools/sentry/'+issue.id,{workspace})
          window.location.hash='tasks/'+task.id
        })}>Open or create task</button>
      </div>)}
    </div>}
  </section>
}

function StackSetup({connection}){
  const [targets,setTargets]=useState(['vercel'])
  const generated=buildStackWorkflow(targets)
  return <section className="monitor-details">
    <h3>Development tools and deployment setup</h3>
    <div className="fields">
      <p><strong>Use the same GitHub repository.</strong> Use the shared checkout in tools such as Cursor, Claude Code, VS Code, Visual Studio, and Windsurf. For tools such as Grok Build, Lovable, Aura.build, Muse, or Grok bots, use this flow wherever the tool supports GitHub sync or source export.</p>
      <p>MyDev connects supported APIs separately. The Grok connection runs xAI prompts. It does not launch a Grok Build session or connect a bot.</p>
      {connection && <a href={'https://github.com/'+connection.external_scope.split('/').slice(0,2).join('/')} target="_blank" rel="noreferrer">Open release repository</a>}
    </div>
    <details className="monitor-details">
      <summary>Build a multi-target release workflow</summary>
      <p>Choose destinations, then commit the generated file as <code>.github/workflows/mydev-release.yml</code> in a Node repository with a lockfile and test script. Configure and protect each named GitHub environment before dispatch.</p>
      <fieldset className="fields">
        <legend>Deployment targets</legend>
        {Object.entries(stackTargets).map(([key,target])=><div key={key}>
          <label className="checkbox"><input type="checkbox" checked={targets.includes(key)} onChange={event=>{
            const checked=event.target.checked
            setTargets(current=>checked?[...current,key]:current.filter(item=>item!==key))
          }} />{target.label}</label>
          {targets.includes(key) && <small><code>mydev-{key}</code> · {target.setup}</small>}
        </div>)}
      </fieldset>
      {generated && <div className="fields">
        <label>GitHub Actions workflow<textarea readOnly rows="10" value={generated} /></label>
        <button type="button" onClick={()=>{
          const url=URL.createObjectURL(new Blob([generated],{type:'text/yaml'}))
          const link=document.createElement('a')
          link.href=url
          link.download='mydev-release.yml'
          link.click()
          setTimeout(()=>URL.revokeObjectURL(url),1000)
        }}>Download workflow</button>
      </div>}
    </details>
  </section>
}

function StackDeploy({api,revision,action,busy,connection}){
  const workspace=connection.workspace_id
  const [results,setResults]=useState({})
  const history=useRecord(api,'developer-tools/stack-deploy?'+new URLSearchParams({workspace}),revision)
  return <section className="monitor-details">
    <h3>Deploy your stack</h3>
    <p>Run the configured GitHub release workflow for <strong>{connection.external_scope}</strong>. The workflow chooses the destinations and uses its own deployment secrets.</p>
    <form className="fields" onSubmit={event=>{
      const values=form(event)
      action(()=>api('developer-tools/stack-deploy',{workspace,scope:connection.external_scope,requestId:crypto.randomUUID(),revision:values.revision.toLowerCase()}))
    }}>
      <label>Git commit SHA<input name="revision" pattern="[0-9a-fA-F]{40}" required maxLength="40" /></label>
      <button className="primary" disabled={busy}>Run release workflow</button>
    </form>
    {history.error && <p className="error" role="alert">{history.error}</p>}
    {history.value?.map(item=><div className="row" key={item.request_id}>
      <div><strong>{item.scope} · {item.revision.slice(0,12)}</strong><small>{{
        accepted:'GitHub accepted dispatch. Check workflow results.',
        rejected:'GitHub rejected dispatch.',
        uncertain:'Delivery uncertain. Check GitHub before retrying.',
      }[item.state]}</small></div>
      <div>
        {item.state!=='rejected' && <button disabled={busy} onClick={()=>action(async()=>{
          const result=await api('developer-tools/stack-deploy/'+item.request_id+'?'+new URLSearchParams({workspace}))
          setResults(current=>({...current,[item.request_id]:result}))
        })}>Check target results</button>}
        {results[item.request_id]?.found===false && <small>No matching GitHub run found yet.</small>}
        {results[item.request_id]?.found && <>
          <a href={results[item.request_id].url} target="_blank" rel="noreferrer">Open run</a>
          <small>{results[item.request_id].conclusion??results[item.request_id].status}</small>
          {results[item.request_id].jobs.map(job=><small key={job.id}>{job.name} · {job.conclusion??job.status}</small>)}
        </>}
      </div>
    </div>)}
  </section>
}

export function DeveloperTools({section,api,revision,action,busy}){
  const catalog=useRecord(api,'developer-tools/connections',revision)
  const work=useRecord(api,section==='models'?'developer-tools/links':null,revision)
  const runs=useRecord(api,section==='models'?'developer-tools/runs':null,revision)
  const [provider,setProvider]=useState('Devin')
  const [adding,setAdding]=useState(false)
  const [useReference,setUseReference]=useState(false)
  const [workspace,setWorkspace]=useState('')
  const [statuses,setStatuses]=useState({})
  const scopes=catalog.value?.workspaces ?? []
  const selected=workspace || scopes[0]?.id
  const canEdit=scopes.some(scope=>scope.id===selected && scope.editable)
  const releaseConnection=catalog.value?.connections.find(item=>item.workspace_id===selected && item.provider==='GitHub Actions' && item.checked_at)
  const save=(path,payload)=>action(()=>api('developer-tools/'+path,payload))
  const headings={integrations:'Integrations',models:'AI agents and models',deploy:'Deployments',operations:'Operations'}
  return <section id="configure-provider" className="panel">
    <div className="thread-heading"><h2>{headings[section]}</h2>
      {section==='integrations' && canEdit && <button className="primary" aria-expanded={adding} onClick={()=>setAdding(value=>!value)}>{adding?'Close setup':'Add integration'}</button>}
    </div>
    {section==='models' && <p className="empty">Attach agent runs to tasks and keep model responses in MyDev.</p>}
    {(catalog.error || work.error || runs.error) && <p className="error" role="alert">{catalog.error || work.error || runs.error}</p>}
    {scopes.length>1 && <label className="search app-picker">Workspace<select value={selected} onChange={event=>setWorkspace(event.target.value)}>
      {scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.name}</option>)}
    </select></label>}
    {section==='integrations' && canEdit && adding && <section className="monitor-details">
      <h3>Configure a provider</h3>
      <form className="fields" onSubmit={event=>{
        const element=event.currentTarget
        const values=form(event)
        action(async()=>{
          await api('developer-tools/connections',{...values,provider,workspace:selected})
          element.reset()
          setAdding(false)
        })
      }}>
        <label>Provider<select value={provider} onChange={event=>setProvider(event.target.value)}>{providers.map(name=><option key={name}>{name}</option>)}</select></label>
        {useReference
          ? <label>Server credential reference<input name="secretRef" pattern="[A-Z][A-Z0-9_]{0,40}" defaultValue="PRIMARY" required /></label>
          : <label>{['Firebase','Supabase','Netlify','Vercel','Cloudflare','WHM','cPanel','Sentry','GitHub Actions'].includes(provider)?'API access token':'API key'}<input
            type="password" name="apiKey" autoComplete="off" required maxLength="2048" /></label>}
        <label className="checkbox"><input type="checkbox" checked={useReference} onChange={event=>setUseReference(event.target.checked)} />Use a server environment variable instead</label>
        {!useReference && provider==='Firebase' && <small>Use a Google OAuth access token with access to this project.</small>}
        {!useReference && provider==='Supabase' && <small>Use a personal access token from your Supabase account settings.</small>}
        {!useReference && ['Codex','ChatGPT'].includes(provider) && <small>Use an OpenAI API key and a model ID available to that API project.</small>}
        {!useReference && provider==='Grok' && <small>Use an xAI API key and a model ID available to your xAI project.</small>}
        {!useReference && provider==='Stripe' && <small>Use a live restricted key with account and charges read access.</small>}
        {!useReference && provider==='GitHub Actions' && <small>Use a fine-grained GitHub token with Actions write access for the selected repository.</small>}
        {!useReference && provider==='Sentry' && <small>Use a Sentry token with project and event read access.</small>}
        {!useReference && ['WHM','cPanel'].includes(provider) && <small>Use the hosting account’s API token and enter the server hostname followed by /username.</small>}
        {provider!=='Cursor' && <label>{scopeLabels[provider]}<input key={provider} name="scope" required /></label>}
        <button disabled={busy}>Save provider configuration</button>
      </form>
    </section>}
    {section==='integrations' && [['AI providers',aiProviders],['Hosting and infrastructure',infrastructure],['Payments and error tracking',operationsProviders]].map(([group,names])=><section key={group} className="monitor-details">
      <h3>{group}</h3>
      <div className="settings-provider-grid">{names.map(name=>{
      const connection=catalog.value?.connections.find(item=>item.provider===name && item.workspace_id===selected)
      return <article key={name} className="settings-provider">
        <div><strong>{name}</strong><small>{connection?.checked_at?'Connection verified':connection?'Credential test pending':'Not configured'}</small>
          {connection && <small>Scope {connection.verified_details?.name ?? connection.external_scope}{connection.verified_details?.status ? ' · '+connection.verified_details.status : ''}</small>}
          {connection?.credential_stored && <small>API credential saved</small>}
          {connection && canEdit && !connection.credential_stored && <small>Server environment variable <code>{connection.environmentKey}</code></small>}
        </div>
        {!connection && canEdit && <button onClick={()=>{setProvider(name);setAdding(true);document.getElementById('configure-provider')?.scrollIntoView({block:'nearest'})}}>Add {name}</button>}
        {connection && canEdit && <div className="monitor-actions">
          <button disabled={busy} onClick={()=>save('connections/'+name+'/check',{workspace:selected})}>Test {name}</button>
          <button disabled={busy} onClick={()=>save('connections/'+name+'/disconnect',{workspace:selected})}>Disconnect {name}</button>
        </div>}
      </article>
      })}</div>
    </section>)}
    {section==='deploy' && canEdit && <StackSetup connection={releaseConnection} />}
    {section==='deploy' && canEdit && releaseConnection && <StackDeploy api={api} revision={revision} action={action} busy={busy} connection={releaseConnection} />}
    {section==='operations' && canEdit && <AgencyIntegrations api={api} workspace={selected} action={action} busy={busy}
      providers={catalog.value?.connections.filter(item=>item.workspace_id===selected && item.checked_at).map(item=>item.provider)??[]} key={selected} />}
    {section==='deploy' && !releaseConnection && canEdit && <p><a href="#settings">Connect GitHub Actions to run a release.</a></p>}
    {section==='models' && work.value && !work.value.tasks.length && <p className="empty">Create a task to link agent work or run a model prompt.</p>}
    {section==='models' && (work.value?.tasks.length??0)>0 && <>
      <details className="monitor-details"><summary>Link agent work to a task</summary>
        <form className="fields" onSubmit={event=>save('links',form(event))}>
          <TaskPicker tasks={work.value.tasks} />
          <label>Provider<select name="provider">{aiProviders.map(name=><option key={name}>{name}</option>)}</select></label>
          <label>Work title<input name="title" maxLength="160" required /></label>
          <label>Provider session or agent URL<input name="url" type="url" required /></label>
          <button disabled={busy}>Save work link</button>
        </form>
      </details>
      <details className="monitor-details"><summary>Ask a model from a MyDev task</summary>
        <form className="fields" onSubmit={event=>save('runs',form(event))}>
          <TaskPicker tasks={work.value.tasks} />
          <label>Model provider<select name="provider">{promptProviders.map(name=><option key={name}>{name}</option>)}</select></label>
          <label>Prompt<textarea name="prompt" rows="4" maxLength="4000" required /></label>
          <button className="primary" disabled={busy}>Run model prompt</button>
        </form>
      </details>
    </>}
    {section==='models' && work.value?.links.map(link=><article className="row" key={link.id}>
      <div><strong>{link.provider} · {link.title}</strong><small><a href={'#tasks/'+link.task_id}>{link.task_title}</a>{statuses[link.id]?' · '+statuses[link.id]:''}</small>
        <a href={link.url} target="_blank" rel="noreferrer">Open provider work</a></div>
      <div className="monitor-actions">
        {['Cursor','Devin'].includes(link.provider) && <button disabled={busy} onClick={()=>action(async()=>{
          const result=await api('developer-tools/links/'+link.id+'/status')
          setStatuses(current=>({...current,[link.id]:result.status}))
        })}>Check status</button>}
        <button disabled={busy} onClick={()=>save('links/'+link.id+'/remove',{})}>Remove</button>
      </div>
    </article>)}
    {section==='models' && runs.value?.map(run=><details className="monitor-details" key={run.id}><summary>{run.provider || 'Claude'} · {run.task_title}</summary>
      <p><strong>Prompt</strong></p><pre className="maintenance-diff">{run.prompt}</pre>
      <p><strong>Response</strong></p><pre className="maintenance-diff">{run.response}</pre>
    </details>)}
  </section>
}

function TaskPicker({tasks}){
  return <label>MyDev task<select name="task" required defaultValue=""><option value="">Choose a task</option>
    {tasks.map(task=><option value={task.id} key={task.id}>{task.title}</option>)}
  </select></label>
}

export function Accounting({api,revision,action,busy,recordId}){
  const [workspace,setWorkspace]=useState('')
  const [section,setSection]=useState('documents')
  const [documentSearch,setDocumentSearch]=useState('')
  const setup=useRecord(api,'erp/setup'+(workspace?'?workspace='+encodeURIComponent(workspace):''),revision)
  const chosen=workspace || setup.value?.scopes[0]?.id
  const suffix=chosen?'?workspace='+encodeURIComponent(chosen):''
  const documents=useRecord(api,chosen && section==='documents'?'erp/documents'+suffix:null,revision)
  const document=useRecord(api,chosen && recordId?'erp/documents/'+recordId+suffix:null,revision)
  const personnel=useRecord(api,chosen && section==='staff'?'erp/staff'+suffix:null,revision)
  const types=useRecord(api,chosen && section==='types'?'erp/service-types'+suffix:null,revision)
  const save=(path,payload,after)=>action(async()=>{
    const result=await api('erp/'+path,{...payload,workspace:chosen});after?.(result)
  })
  const error=setup.error||documents.error||document.error||personnel.error||types.error
  if(error) return <p className="error" role="alert">{error}</p>
  if(!chosen) return <p>Opening Accounts &amp; ERP…</p>
  if(recordId) return document.value?<PrintableDocument document={document.value} />:<p>Opening document…</p>
  return <section className="panel">
    <details className="monitor-details"><summary>Related finance tools</summary>
      <div className="monitor-actions">{Object.entries(sectionLinks).map(([key,label])=><a href={'#'+key} key={key}>{label}</a>)}</div>
    </details>
    {setup.value.scopes.length>1 && <label className="search app-picker">Workspace<select value={chosen} onChange={event=>setWorkspace(event.target.value)}>
      {setup.value.scopes.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    <nav className="settings-nav" aria-label="Accounts and ERP tools">
      {[['documents','Document generators'],['types','Billing service types'],['staff','HR and payroll']].map(([key,label])=><button key={key}
        aria-pressed={section===key} onClick={()=>setSection(key)}>{label}</button>)}
    </nav>
    {section==='documents' && <>
      <div className="monitor-actions"><a href="#billing">Quotation generator</a><a href="#billing">Invoice generator</a></div>
      <details className="monitor-details"><summary>New ERP document</summary>
        <DocumentForm setup={setup.value} save={save} busy={busy} />
      </details>
      <label className="search">Find documents<input type="search" value={documentSearch} onChange={event=>setDocumentSearch(event.target.value)} placeholder="Title, type or recipient" /></label>
      {documents.value?.filter(item=>[item.title,kinds[item.kind],item.recipient,item.number].join(' ').toLowerCase()
        .includes(documentSearch.trim().toLowerCase())).map(item=><a href={'#erp/'+item.id} className="row ticket-link" key={item.id}>
        <div><strong>{item.title}</strong><small>{kinds[item.kind]} {item.number} · {item.recipient} · {date(item.issued_on)}</small></div>
      </a>)}
    </>}
    {section==='types' && <>
      <h2>Billing service types</h2>
      <p className="empty">Create reusable defaults for hosting, renewals, tracking, subscriptions, and additional services.</p>
      <details className="monitor-details"><summary>Add billing service type</summary>
      <form className="fields" onSubmit={event=>{const values=form(event);save('service-types',{
        ...values,interval:Number(values.interval),reminder:Number(values.reminder),
      })}}>
        <label>Service name<input name="name" required list="service-presets" /></label>
        <datalist id="service-presets">{types.value?.defaults.map(([name])=><option value={name} key={name} />)}</datalist>
        <label>Billing direction<select name="direction">{Object.entries(directions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Interval in months<input name="interval" type="number" min="1" max="120" defaultValue="1" required /></label>
        <label>Reminder days<input name="reminder" type="number" min="0" max="365" defaultValue="7" required /></label>
        <button disabled={busy}>Save billing service type</button>
      </form>
      </details>
      {types.value?.custom.map(type=><div className="row" key={type.id}><strong>{type.name}</strong>
        <small>{directions[type.direction]} · Every {type.interval_months} month(s) · {type.reminder_days} day reminder</small></div>)}
    </>}
    {section==='staff' && <Personnel key={chosen} data={personnel.value} save={save} busy={busy} />}
  </section>
}

function DocumentForm({setup,save,busy}){
  const [kind,setKind]=useState('proposal')
  const [organization,setOrganization]=useState('')
  const [lineCount,setLineCount]=useState(0)
  return <form className="fields monitor-details" onSubmit={event=>{
    const values=form(event)
    const lines=Array.from({length:lineCount},(_,i)=>({description:values['description'+i],unit:values['unit'+i],
      quantity:Number(values['quantity'+i]),unitMinor:minor(values['rate'+i])}))
    save('documents',{...values,kind,organization,lines,currency:values.currency.toUpperCase()},result=>{window.location.hash='erp/'+result.id})
  }}>
    <h2>Generate document</h2>
    <label>Document type<select value={kind} onChange={event=>{
      const next=event.target.value
      setKind(next)
      if(['credit-note','debit-note','boq','bom'].includes(next) && !lineCount) setLineCount(1)
    }}>{Object.entries(kinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label>Title<input name="title" maxLength="160" required /></label>
    <label>Client<select value={organization} onChange={event=>setOrganization(event.target.value)}><option value="">External recipient or internal</option>
      {setup.organizations.map(org=><option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
    {!organization && <label>Recipient<input name="recipient" /></label>}
    {['credit-note','debit-note','claim'].includes(kind) && organization && <label>Reference invoice<select name="invoice" key={organization}><option value="">No invoice reference</option>
      {setup.invoices.filter(invoice=>invoice.organization_id===organization).map(invoice=><option key={invoice.id} value={invoice.id}>Invoice {invoice.number}</option>)}</select></label>}
    <label>Document date<input name="date" type="date" defaultValue={today()} required /></label>
    <label>Currency<input name="currency" defaultValue="USD" maxLength="3" required /></label>
    <label>{kind==='boq'||kind==='bom'?'Scope or specifications':'Document body'}<textarea name="body" rows="5" maxLength="12000" /></label>
    {Array.from({length:lineCount},(_,i)=><fieldset className="monitor-fields" key={i}><legend>Line item {i+1}</legend>
      <label>Description<input name={'description'+i} required /></label><label>Unit<input name={'unit'+i} /></label>
      <label>Quantity<input name={'quantity'+i} type="number" min="1" defaultValue="1" required /></label>
      <label>Unit rate<input name={'rate'+i} type="number" min="0" step=".01" defaultValue="0" required /></label>
    </fieldset>)}
    <div className="monitor-actions"><button type="button" disabled={lineCount===50} onClick={()=>setLineCount(lineCount+1)}>Add line item</button>
      {lineCount>0 && <button type="button" onClick={()=>setLineCount(lineCount-1)}>Remove last item</button>}</div>
    {['credit-note','debit-note'].includes(kind) && <p className="empty">Generating this document leaves the invoice balance unchanged.</p>}
    <button className="primary" disabled={busy}>Generate and save document</button>
  </form>
}

function PrintableDocument({document}){
  return <section className="panel billing-document">
    <div className="monitor-actions screen-only"><a href="#erp">All ERP tools</a><button onClick={()=>window.print()}>Print or save as PDF</button></div>
    <h2>{document.issuer}</h2><p>{kinds[document.kind]} {document.number} · {date(document.issued_on)}</p>
    <h3>{document.title}</h3><p>{document.recipient}</p>
    <p className="document-prose">{document.body}</p>
    {document.lines.map((line,index)=><div className="row" key={index}><strong>{line.description}</strong>
      <span>{line.quantity} {line.unit} · {money(line.quantity*line.unitMinor,document.currency)}</span></div>)}
    {document.lines.length>0 && <p><strong>Total {money(document.total_minor,document.currency)}</strong></p>}
    {document.invoice_id && <p className="screen-only"><a href={'#billing/'+document.invoice_id}>Referenced invoice</a></p>}
    <small className="billing-credit">Prepared with MyDev Workspace</small>
  </section>
}

function Personnel({data,save,busy}){
  const [employee,setEmployee]=useState('')
  const [kind,setKind]=useState('leave')
  const [payslip,setPayslip]=useState('')
  const selected=data?.employees.find(item=>item.id===employee)
  const slip=data?.payroll.find(item=>item.id===payslip)
  if(slip) return <section className="billing-document">
    <div className="monitor-actions screen-only"><button onClick={()=>setPayslip('')}>Back to HR and payroll</button><button onClick={()=>window.print()}>Print or save as PDF</button></div>
    <h2>{slip.issuer}</h2><h3>Payslip · {slip.employee_name}</h3><p>{date(slip.start_on)} to {date(slip.end_on)}</p>
    <div className="row"><strong>Base earnings</strong>{money(slip.base_minor,slip.currency)}</div>
    <div className="row"><strong>Approved bonuses</strong>{money(slip.bonus_minor,slip.currency)}</div>
    <div className="row"><strong>Deductions entered</strong>{money(slip.deduction_minor,slip.currency)}</div>
    <div className="row"><strong>Net pay</strong>{money(Number(slip.base_minor)+Number(slip.bonus_minor)-Number(slip.deduction_minor),slip.currency)}</div>
    <small>Approved hours {(Number(slip.paid_minutes)/60).toFixed(2)}</small><p>{slip.notes}</p>
  </section>
  return <>
    <h2>Human resources and payroll</h2>
    <details className="monitor-details"><summary>Add employee</summary>
      <form className="fields" onSubmit={event=>save('staff',form(event),result=>setEmployee(result.id))}>
        <label>Employee name<input name="name" required /></label><label>Email<input name="email" type="email" /></label>
        <label>Job title<input name="job" required /></label><label>Start date<input name="start" type="date" defaultValue={today()} required /></label>
        <button disabled={busy}>Save employee</button>
      </form>
    </details>
    <label className="search app-picker">Employee<select value={employee} onChange={event=>setEmployee(event.target.value)}><option value="">Choose an employee</option>
      {data?.employees.map(item=><option key={item.id} value={item.id}>{item.name}{item.active?'':' (inactive)'}</option>)}</select></label>
    {selected && <>
      <details className="monitor-details" key={selected.id}><summary>Edit employee</summary>
        <form className="fields" onSubmit={event=>{const values=form(event);save('staff/'+selected.id+'/edit',{...values,active:values.active==='on'})}}>
          <label>Employee name<input name="name" defaultValue={selected.name} required /></label>
          <label>Email<input name="email" type="email" defaultValue={selected.email} /></label>
          <label>Job title<input name="job" defaultValue={selected.job_title} required /></label>
          <label className="checkbox"><input name="active" type="checkbox" defaultChecked={selected.active} />Active employee</label>
          <button disabled={busy}>Update employee</button>
        </form>
      </details>
      {selected.active && <>
        <details className="monitor-details"><summary>Record leave, hours or bonus</summary>
          <form className="fields" onSubmit={event=>{const values=form(event);save('staff/'+selected.id+'/entry',{
            ...values,kind,end:values.end||values.start,minutes:Number(values.minutes),amount:minor(values.amount),currency:values.currency?.toUpperCase(),
          })}}>
            <label>Entry type<select value={kind} onChange={event=>setKind(event.target.value)}><option value="leave">Leave</option><option value="hours">Work hours</option><option value="bonus">Bonus</option></select></label>
            <label>{kind==='leave'?'Leave from':'Date'}<input name="start" type="date" defaultValue={today()} required /></label>
            {kind==='leave' && <label>Leave through<input name="end" type="date" required /></label>}
            {kind==='hours' && <label>Minutes worked<input name="minutes" type="number" min="1" max="1440" required /></label>}
            {kind==='bonus' && <><label>Bonus amount<input name="amount" type="number" min="0" step=".01" required /></label><label>Currency<input name="currency" defaultValue="USD" maxLength="3" required /></label></>}
            <label>Reason or description<input name="description" required /></label>
            <button disabled={busy}>Submit for approval</button>
          </form>
        </details>
        <details className="monitor-details"><summary>Generate payroll record and payslip</summary>
          <p className="empty">Uses approved bonuses and hours from the selected period. Enter deductions and base earnings manually.</p>
          <form className="fields" onSubmit={event=>{const values=form(event);save('staff/'+selected.id+'/payroll',{
            ...values,base:minor(values.base),deductions:minor(values.deductions),currency:values.currency.toUpperCase(),
          },result=>setPayslip(result.id))}}>
            <label>Period start<input name="start" type="date" required /></label><label>Period end<input name="end" type="date" required /></label>
            <label>Currency<input name="currency" defaultValue="USD" maxLength="3" required /></label>
            <label>Base earnings<input name="base" type="number" min="0" step=".01" required /></label>
            <label>Deductions<input name="deductions" type="number" min="0" step=".01" defaultValue="0" required /></label>
            <label>Payroll notes<textarea name="notes" /></label>
            <button disabled={busy}>Generate payslip</button>
          </form>
        </details>
      </>}
    </>}
    {data?.entries.filter(item=>!employee||item.employee_id===employee).map(item=><div className="row" key={item.id}>
      <div><strong>{item.name} · {item.kind}</strong><small>{date(item.start_on)} · {item.description} · {item.status}</small></div>
      {item.status==='pending' && <div className="monitor-actions">{['approved','declined'].map(status=><button key={status} disabled={busy}
        onClick={()=>save('entries/'+item.id+'/review',{status})}>{status==='approved'?'Approve':'Decline'}</button>)}</div>}
    </div>)}
    {data?.payroll.filter(item=>!employee||item.employee_id===employee).map(item=><div className="row" key={item.id}>
      <div><strong>{item.employee_name}</strong><small>Pay period ending {date(item.end_on)}</small></div><button onClick={()=>setPayslip(item.id)}>View payslip</button>
    </div>)}
  </>
}

export function PlatformAdmin({api,revision,action,busy}){
  const {value,error}=useRecord(api,'platform/workspaces',revision)
  if(error) return <p role="alert" className="error">{error}</p>
  if(!value) return <p>Opening platform records…</p>
  return <section className="panel"><h2>Tenant management</h2>
    <p className="empty">Plan and lifecycle records track your SaaS operations. Changes here do not charge tenants or suspend access.</p>
    {value.map(workspace=><details className="monitor-details" key={workspace.workspace_id}>
      <summary>{workspace.name} · {workspace.plan} · {workspace.lifecycle}</summary>
      <p>{workspace.members} members · {workspace.projects} projects</p>
      <form className="fields" onSubmit={event=>{
        const values=form(event)
        action(()=>api('platform/workspaces/'+encodeURIComponent(workspace.workspace_id),values))
      }}>
        <label>Plan<select name="plan" defaultValue={workspace.plan}>{['pilot','starter','agency','enterprise'].map(plan=><option key={plan}>{plan}</option>)}</select></label>
        <label>Lifecycle<select name="lifecycle" defaultValue={workspace.lifecycle}>{['trial','active','paused','closed'].map(state=><option key={state}>{state}</option>)}</select></label>
        <button disabled={busy}>Save SaaS record</button>
      </form>
    </details>)}
  </section>
}

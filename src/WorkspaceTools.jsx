import { useState } from 'react'
import { useRecord } from './useRecord.js'

const providers=['Devin','Cursor','Claude']
const kinds={'credit-note':'Credit note','debit-note':'Debit note',notice:'Notice',claim:'Claim',proposal:'Proposal',boq:'Bill of Quantities',bom:'Bill of Materials'}
const directions={collection:'Collect from client',supplier:'Pay supplier',domain:'Renew domain'}
const today=()=>new Date().toISOString().slice(0,10)
const date=value=>String(value??'').slice(0,10)
const minor=value=>Math.round(Number(value)*100)
const money=(amount,code)=>code+' '+(Number(amount)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})
const form=event=>{event.preventDefault();return Object.fromEntries(new FormData(event.currentTarget))}
const sectionLinks={crm:'CRM',billing:'Quotes and invoices',orders:'Orders',inventory:'Inventory',transactions:'Transactions'}

export function DeveloperTools({api,revision,action,busy}){
  const catalog=useRecord(api,'developer-tools/connections',revision)
  const work=useRecord(api,'developer-tools/links',revision)
  const runs=useRecord(api,'developer-tools/runs',revision)
  const [provider,setProvider]=useState('Devin')
  const [workspace,setWorkspace]=useState('')
  const [statuses,setStatuses]=useState({})
  const scopes=catalog.value?.workspaces ?? []
  const selected=workspace || scopes[0]?.id
  const canEdit=scopes.some(scope=>scope.id===selected && scope.editable)
  const save=(path,payload)=>action(()=>api('developer-tools/'+path,payload))
  return <section className="panel">
    <h2>AI agents and models</h2>
    <p className="empty">Connect provider credentials, attach agent runs to tasks, and keep Claude responses in MyDev.</p>
    {(catalog.error || work.error || runs.error) && <p className="error" role="alert">{catalog.error || work.error || runs.error}</p>}
    {scopes.length>1 && <label className="search app-picker">Workspace<select value={selected} onChange={event=>setWorkspace(event.target.value)}>
      {scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.name}</option>)}
    </select></label>}
    {providers.map(name=>{
      const connection=catalog.value?.connections.find(item=>item.provider===name && item.workspace_id===selected)
      return <article key={name} className="row">
        <div><strong>{name}</strong><small>{connection?.checked_at?'Connection verified':connection?'Credential test pending':'Not configured'}</small>
          {connection && canEdit && <small>Server environment variable <code>{connection.environmentKey}</code></small>}
        </div>
        {connection && canEdit && <div className="monitor-actions">
          <button disabled={busy} onClick={()=>save('connections/'+name+'/check',{workspace:selected})}>Test {name}</button>
          <button disabled={busy} onClick={()=>save('connections/'+name+'/disconnect',{workspace:selected})}>Disconnect {name}</button>
        </div>}
      </article>
    })}
    {canEdit && <details className="monitor-details"><summary>Configure an AI provider</summary>
      <form className="fields" onSubmit={event=>save('connections',{...form(event),provider,workspace:selected})}>
        <label>Provider<select value={provider} onChange={event=>setProvider(event.target.value)}>{providers.map(name=><option key={name}>{name}</option>)}</select></label>
        <label>Server credential reference<input name="secretRef" pattern="[A-Z][A-Z0-9_]{0,40}" defaultValue="PRIMARY" required /></label>
        {provider!=='Cursor' && <label>{provider==='Devin'?'Devin organization ID':'Claude model ID'}<input key={provider} name="scope" required /></label>}
        <button disabled={busy}>Save provider configuration</button>
      </form>
    </details>}
    {(work.value?.tasks.length??0)>0 && <>
      <details className="monitor-details"><summary>Link agent work to a task</summary>
        <form className="fields" onSubmit={event=>save('links',form(event))}>
          <TaskPicker tasks={work.value.tasks} />
          <label>Provider<select name="provider">{providers.map(name=><option key={name}>{name}</option>)}</select></label>
          <label>Work title<input name="title" maxLength="160" required /></label>
          <label>Provider session or agent URL<input name="url" type="url" required /></label>
          <button disabled={busy}>Save work link</button>
        </form>
      </details>
      <details className="monitor-details"><summary>Ask Claude from a MyDev task</summary>
        <form className="fields" onSubmit={event=>save('runs',form(event))}>
          <TaskPicker tasks={work.value.tasks} />
          <label>Prompt<textarea name="prompt" rows="4" maxLength="4000" required /></label>
          <button className="primary" disabled={busy}>Run Claude prompt</button>
        </form>
      </details>
    </>}
    {work.value?.links.map(link=><article className="row" key={link.id}>
      <div><strong>{link.provider} · {link.title}</strong><small><a href={'#tasks/'+link.task_id}>{link.task_title}</a>{statuses[link.id]?' · '+statuses[link.id]:''}</small>
        <a href={link.url} target="_blank" rel="noreferrer">Open provider work</a></div>
      <div className="monitor-actions">
        {link.provider!=='Claude' && <button disabled={busy} onClick={()=>action(async()=>{
          const result=await api('developer-tools/links/'+link.id+'/status')
          setStatuses(current=>({...current,[link.id]:result.status}))
        })}>Check status</button>}
        <button disabled={busy} onClick={()=>save('links/'+link.id+'/remove',{})}>Remove</button>
      </div>
    </article>)}
    {runs.value?.map(run=><details className="monitor-details" key={run.id}><summary>Claude · {run.task_title}</summary>
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
    <div className="monitor-actions">{Object.entries(sectionLinks).map(([key,label])=><a className="badge" href={'#'+key} key={key}>{label}</a>)}</div>
    {setup.value.scopes.length>1 && <label className="search app-picker">Workspace<select value={chosen} onChange={event=>setWorkspace(event.target.value)}>
      {setup.value.scopes.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    <div className="monitor-actions" aria-label="Accounts and ERP tools">
      {[['documents','Document generators'],['types','Billing service types'],['staff','HR and payroll']].map(([key,label])=><button key={key}
        aria-pressed={section===key} onClick={()=>setSection(key)}>{label}</button>)}
    </div>
    {section==='documents' && <>
      <div className="monitor-actions"><a href="#billing">Quotation generator</a><a href="#billing">Invoice generator</a></div>
      <DocumentForm setup={setup.value} save={save} busy={busy} />
      {documents.value?.map(item=><a href={'#erp/'+item.id} className="row ticket-link" key={item.id}>
        <div><strong>{item.title}</strong><small>{kinds[item.kind]} {item.number} · {item.recipient} · {date(item.issued_on)}</small></div>
      </a>)}
    </>}
    {section==='types' && <>
      <h2>Billing service types</h2>
      <p className="empty">Create reusable defaults for hosting, renewals, tracking, subscriptions, and additional services.</p>
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

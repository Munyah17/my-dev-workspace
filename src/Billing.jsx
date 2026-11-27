import { useRef, useState } from 'react'
import { useRecord } from './useRecord.js'

const iso = value => value?.slice(0,10) ?? ''
const now = () => new Date().toISOString().slice(0,10)
const money = (value,currency) => currency + ' ' + (Number(value)/100).toLocaleString(undefined,{ minimumFractionDigits:2,maximumFractionDigits:2 })
const form = event => {
  event.preventDefault()
  return Object.fromEntries(new FormData(event.currentTarget))
}
const minor = value => Math.round(Number(value)*100)
const actions = { collection:'Collect payment',supplier:'Pay supplier',domain:'Renew domain' }

function Workspace({ scopes,value,setValue }) {
  return scopes.length>1 && <label>Workspace<select value={value} onChange={event=>setValue(event.target.value)}>
    {scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.name}</option>)}
  </select></label>
}

function DocumentRow({ document }) {
  return <a className="row ticket-link" href={'#billing/' + document.id}>
    <div><strong>{document.kind==='quote'?'Quote':'Invoice'} {document.number} · {document.recipient}</strong><small>{document.status} · Due {iso(document.due_on)}</small></div>
    <span className="badge">{money(document.total_minor,document.currency)}</span>
  </a>
}

export function CRM({ api,revision,action,busy,recordId }) {
  const [selected,setSelected]=useState('')
  const [search,setSearch]=useState('')
  const [status,setStatus]=useState('')
  const [adding,setAdding]=useState(false)
  const summary=useRecord(api,'billing/summary',revision)
  const scopes=summary.value?.scopes ?? []
  const workspace=selected || scopes[0]?.id
  const params=workspace ? '?workspace='+encodeURIComponent(workspace) : ''
  const listing=useRecord(api,workspace && !recordId ? 'billing/clients'+params+'&q='+encodeURIComponent(search) : null,revision)
  const detail=useRecord(api,workspace && recordId ? 'billing/clients/'+encodeURIComponent(recordId)+params : null,revision)
  const error=summary.error || listing.error || detail.error
  if (error) return <p className="error" role="alert">{error}</p>
  const entry=detail.value
  if (recordId && !entry) return <p>Opening client…</p>
  const clientFields=(profile={})=><>
    <label>Email<input name="email" type="email" defaultValue={profile.email} /></label>
    <label>Phone<input name="phone" defaultValue={profile.phone} /></label>
    <label>Billing address<textarea name="address" defaultValue={profile.address} /></label>
    <label>Agency-only notes<textarea name="notes" defaultValue={profile.notes} /></label>
  </>
  if (entry) return <section className="panel">
    <a href="#crm">All clients</a><h2>{entry.name}</h2>
    <form className="fields" key={entry.id} onSubmit={event=>{const values=form(event); action(()=>api('billing/clients/'+entry.id+'/profile',{ ...values,workspace }))}}>
      {clientFields(entry.profile ?? {})}<label>Status<select name="status" defaultValue={entry.profile?.status ?? 'Active'}><option>Active</option><option>Inactive</option></select></label>
      <button disabled={busy}>Save client profile</button>
    </form>
    <details className="monitor-details" open><summary>Contacts</summary>
      {entry.contacts.map(contact=><p className="row" key={contact.id}>{contact.name} · {contact.email} {contact.phone}</p>)}
      <form className="fields" onSubmit={event=>{
        const element=event.currentTarget
        const values=form(event)
        action(async()=>{await api('billing/clients/'+entry.id+'/contact',{ ...values,workspace });element.reset()})
      }}><label>Contact name<input name="name" required /></label><label>Contact email<input type="email" name="email" required /></label><label>Contact phone<input name="phone" /></label><button disabled={busy}>Add contact</button></form>
    </details>
    <details className="monitor-details" open><summary>Client activity</summary>
      {entry.projects.map(project=><p key={project.id} className="row">{project.name} · App</p>)}
      {entry.tickets.map(ticket=><a key={ticket.id} className="row ticket-link" href={'#inbox/'+ticket.id}>{ticket.subject} · {ticket.state}</a>)}
      {entry.orders?.map(order=><a key={order.id} className="row ticket-link" href={'#orders/'+order.id}>
        <strong>Order {order.number} · {order.state}</strong><span>{money(order.total_minor,order.currency)}</span>
      </a>)}
      {entry.documents.map(document=><DocumentRow key={document.id} document={document} />)}
      {entry.services.map(service=><a key={service.id} className="row ticket-link" href={'#billing/service-'+service.id}>{service.name} · {iso(service.due_on)}</a>)}
    </details>
  </section>
  return <section className="panel">
    <div className="monitor-actions"><button className="primary" onClick={()=>setAdding(!adding)}>{adding?'Close form':'New client'}</button></div>
    <Workspace scopes={scopes} value={workspace} setValue={setSelected} />
    {adding && <form className="fields" onSubmit={event=>{ const values=form(event); action(async()=>{
      const entry=await api('billing/clients',{...values,workspace}); setAdding(false);window.location.hash='crm/'+entry.id
    })}}>
      <label>Organization name<input name="name" required /></label>{clientFields()}<button disabled={busy || !workspace}>Create client</button>
    </form>}
    <div className="crm-filters">
      <label className="crm-search">Search clients<span className="crm-search-control"><span className="crm-search-icon" aria-hidden="true" /><input type="search" placeholder="Search by organization name" value={search} onChange={event=>setSearch(event.target.value)} /></span></label>
      <label className="search app-picker">Status <select value={status} onChange={event=>setStatus(event.target.value)}><option value="">All</option><option>Active</option><option>Inactive</option></select></label>
    </div>
    {listing.value?.filter(item=>!status || item.status===status).map(item=><a className="row ticket-link" key={item.id} href={'#crm/'+item.id}>
      <div><strong>{item.name}</strong><small>{item.email || item.phone}</small></div><span className="badge">{item.status}</span>
    </a>)}
  </section>
}

function LineEditor({ initial,disabled }) {
  const [lines,setLines]=useState(initial?.length || 1)
  return <>
    {Array.from({length:lines},(_,i)=>{
      const line=initial?.[i]
      return <fieldset className="monitor-fields" key={i}><legend>Line item {i+1}</legend>
        <label>Description<input name={'description'+i} required defaultValue={line?.description} /></label>
        <label>Quantity<input name={'quantity'+i} type="number" min="1" defaultValue={line?.quantity ?? 1} required /></label>
        <label>Unit price<input name={'unit'+i} type="number" min="0" step=".01" defaultValue={line==null?'':Number(line.unit_minor)/100} required /></label>
        <label>Discount<input name={'discount'+i} type="number" min="0" step=".01" defaultValue={line==null?0:Number(line.discount_minor)/100} /></label>
        <label>Tax (%)<input name={'tax'+i} type="number" min="0" max="100" step=".01" defaultValue={line==null?0:line.tax_bps/100} /></label>
      </fieldset>
    })}
    <div className="monitor-actions"><button type="button" disabled={disabled || lines===30} onClick={()=>setLines(lines+1)}>Add line</button>
      <button type="button" disabled={disabled || lines===1} onClick={()=>setLines(lines-1)}>Remove last line</button></div>
  </>
}
const documentFields=(values)=>({
  currency:values.currency.toUpperCase(),due:values.due,
  items:Object.keys(values).filter(key=>key.startsWith('description')).map(key=>{
    const i=key.slice('description'.length)
    return { description:values[key],quantity:Number(values['quantity'+i]),unit:minor(values['unit'+i]),discount:minor(values['discount'+i]),tax:minor(values['tax'+i]) }
  }),
})

function Document({ api,recordId,revision,action,busy }) {
  const request=useRef(null)
  const result=useRecord(api,'billing/documents/'+recordId,revision)
  if (result.error) return <p className="error" role="alert">{result.error}</p>
  const doc=result.value
  if (!doc) return <p>Opening document…</p>
  const title=(doc.kind==='quote'?'Quotation':'Invoice')+' '+doc.number
  const post=(operation,data={})=>action(()=>api('billing/documents/'+doc.id+'/'+operation,data))
  const subtotal=doc.lines.reduce((sum,line)=>sum+line.quantity*Number(line.unit_minor),0)
  const discounts=doc.lines.reduce((sum,line)=>sum+Number(line.discount_minor),0)
  return <section className="panel billing-document">
    <a className="screen-only" href="#billing">All billing documents</a>
    <div className="thread-heading"><div><h2>{doc.issuer}</h2><p>{title} · {doc.status}</p></div><span className="badge">{money(doc.total_minor,doc.currency)}</span></div>
    <p>{doc.recipient}</p><p>{doc.recipient_address}</p><p>Issued {iso(doc.issued_on)||'—'} · Due {iso(doc.due_on)}</p>
    {doc.accepted_at && <p>Accepted {iso(doc.accepted_at)}</p>}
    {doc.lines.map(line=><div className="row" key={line.position}><div><strong>{line.description}</strong><small>{line.quantity} × {money(line.unit_minor,doc.currency)} · {line.tax_bps/100}% tax</small></div><span>{money(line.total_minor,doc.currency)}</span></div>)}
    <dl className="monitor-fields">
      <div><dt>Subtotal</dt><dd>{money(subtotal,doc.currency)}</dd></div>
      <div><dt>Discount</dt><dd>{money(discounts,doc.currency)}</dd></div>
      <div><dt>Tax</dt><dd>{money(Number(doc.total_minor)-subtotal+discounts,doc.currency)}</dd></div>
      {doc.kind==='invoice' && <div><dt>Balance due</dt><dd>{money(doc.balance,doc.currency)}</dd></div>}
    </dl>
    <div className="screen-only">
      <div className="monitor-actions">
        <button onClick={()=>window.print()}>Print or save as PDF</button>
        {doc.staff && doc.state==='draft' && <button disabled={busy} onClick={()=>post('issue')}>Issue {doc.kind}</button>}
        {doc.staff && ['draft','issued'].includes(doc.state) && Number(doc.paid_minor)===0 && <button disabled={busy} onClick={()=>post('void')}>Void document</button>}
        {doc.status==='sent' && <><button disabled={busy} onClick={()=>post('decision',{ decision:'accepted' })}>Accept quote</button>
          <button disabled={busy} onClick={()=>post('decision',{ decision:'declined' })}>Decline quote</button></>}
      </div>
      {doc.staff && doc.state==='draft' && <details className="monitor-details"><summary>Edit draft</summary>
        <form className="fields" onSubmit={event=>post('edit',documentFields(form(event)))}>
          <label>Currency<input name="currency" maxLength="3" required defaultValue={doc.currency} /></label>
          <label>Due date<input type="date" name="due" required defaultValue={iso(doc.due_on)} /></label>
          <LineEditor initial={doc.lines} disabled={busy} /><button disabled={busy}>Save draft</button>
        </form>
      </details>}
      {doc.staff && doc.kind==='quote' && doc.state==='accepted' && <button className="primary" disabled={busy} onClick={()=>action(async()=>{
        const order=await api('operations/orders',{ quote:doc.id })
        window.location.hash='orders/'+order.id
      })}>Convert to order</button>}
      {doc.staff && doc.kind==='quote' && doc.state==='accepted' && <form className="fields" onSubmit={event=>{
        const values=form(event)
        action(async()=>{const result=await api('billing/documents/'+doc.id+'/convert',{ due:values.due });window.location.hash='billing/'+result.id})
      }}>
        <label>Invoice due date<input type="date" name="due" required defaultValue={now()} /></label>
        <button className="primary" disabled={busy}>Convert to invoice</button>
      </form>}
      {doc.staff && doc.kind==='invoice' && doc.state==='issued' && doc.balance>0 && <details className="monitor-details"><summary>Record manual payment</summary>
        <form className="fields" onSubmit={event=>{
          const element=event.currentTarget
          const values=form(event)
          const fingerprint=JSON.stringify(values)
          if (request.current?.fingerprint!==fingerprint) request.current={ fingerprint,key:crypto.randomUUID() }
          const key=request.current.key
          action(async()=>{await api('billing/documents/'+doc.id+'/payment',{ ...values,request:key,currency:doc.currency,amount:minor(values.amount) });request.current=null;element.reset()})
        }}>
          <label>Amount ({doc.currency})<input type="number" name="amount" min=".01" max={doc.balance/100} step=".01" required /></label>
          <label>Received date<input type="date" defaultValue={now()} name="date" required /></label>
          <label>Payment method<input name="method" required /></label><label>Reference<input name="reference" /></label>
          <label>Private notes<textarea name="notes" /></label><button disabled={busy}>Record payment</button>
        </form>
      </details>}
      {doc.payments.map(payment=><div className="row" key={payment.id}><small>{iso(payment.received_on)} · {payment.method} · {payment.reference}</small>{money(payment.amount_minor,doc.currency)}</div>)}
    </div>
    <small className="billing-credit">Prepared with MyDev Workspace</small>
  </section>
}

export function Billing({ api,revision,action,busy,recordId }) {
  if (recordId?.startsWith('service-')) return <Services api={api} revision={revision} action={action} busy={busy} recordId={recordId.slice(8)} />
  if (recordId==='services') return <Services api={api} revision={revision} action={action} busy={busy} />
  if (recordId) return <Document key={recordId} api={api} revision={revision} action={action} busy={busy} recordId={recordId} />
  return <BillingOverview api={api} revision={revision} action={action} busy={busy} />
}

function BillingOverview({ api,revision,action,busy }) {
  const [workspace,setWorkspace]=useState('')
  const [adding,setAdding]=useState(false)
  const result=useRecord(api,'billing/summary'+(workspace?'?workspace='+encodeURIComponent(workspace):''),revision)
  if (result.error) return <p className="error" role="alert">{result.error}</p>
  if (!result.value) return <p>Opening billing…</p>
  const { documents,scopes,totals,organizations }=result.value
  const selected=workspace || scopes[0]?.id
  return <section className="panel">
    {selected && <div className="monitor-actions"><button className="primary" onClick={()=>setAdding(!adding)}>{adding?'Close form':'New billing document'}</button><a href="#billing/services">Services and renewals</a></div>}
    <Workspace scopes={scopes} value={selected} setValue={setWorkspace} />
    {adding && <form className="fields" onSubmit={event=>{const values=form(event);action(async()=>{
      const result=await api('billing/documents',{ ...documentFields(values),workspace:selected,organization:values.organization,kind:values.kind })
      window.location.hash='billing/'+result.id
    })}}>
      <label>Client<select name="organization" required defaultValue=""><option value="">Choose a client</option>{organizations.map(org=><option value={org.id} key={org.id}>{org.name}</option>)}</select></label>
      <label>Document type<select name="kind"><option value="quote">Quotation</option><option value="invoice">Invoice</option></select></label>
      <label>Currency<input name="currency" defaultValue="USD" maxLength="3" required /></label>
      <label>Due or expiry date<input name="due" type="date" required /></label>
      <LineEditor disabled={busy} /><button className="primary" disabled={busy}>Save draft</button>
    </form>}
    {Object.entries(totals).map(([currency,total])=><div className="row" key={currency}>
      <div><strong>{currency}</strong><small>Invoiced {money(total.invoiced,currency)} · Cash recorded {money(total.cash,currency)} · Outstanding {money(total.balance,currency)}</small></div>
    </div>)}
    {documents.length?documents.map(document=><DocumentRow key={document.id} document={document} />):<p className="empty">No billing documents yet.</p>}
  </section>
}

function Services({ api,revision,action,busy,recordId }) {
  const [adding,setAdding]=useState(false)
  const [choice,setChoice]=useState('')
  const [defaults,setDefaults]=useState(null)
  const setup=useRecord(api,'billing/summary'+(choice?'?workspace='+encodeURIComponent(choice):''),revision)
  const services=useRecord(api,'billing/services',revision)
  const list=services.value?.filter(item=>!recordId || recordId===item.id)
  const scopes=setup.value?.scopes ?? []
  const workspace=choice || scopes[0]?.id
  const templates=useRecord(api,workspace?'erp/service-types?workspace='+encodeURIComponent(workspace):null,revision)
  return <section className="panel"><a href="#billing">Billing documents</a><h2>Services and renewals</h2>
    <p className="empty">Reminders appear in the app. Email and push delivery are unconfigured.</p>
    {workspace && !recordId && <button className="primary" onClick={()=>setAdding(!adding)}>{adding?'Close form':'Add service or renewal'}</button>}
    {adding && <form className="fields" onSubmit={event=>{const values=form(event);action(async()=>{
      const result=await api('billing/services',{ ...values,workspace,serviceType:defaults?.id,currency:values.currency.toUpperCase(),amount:minor(values.amount),interval:Number(values.interval),reminder:Number(values.reminder) })
      window.location.hash='billing/service-'+result.id
    })}}>
      <Workspace scopes={scopes} value={workspace} setValue={setChoice} />
      {templates.value && <label>Billing service type<select name="serviceType" onChange={event=>{
        const value=event.target.value
        const type=templates.value.custom.find(item=>item.id===value)
        const preset=templates.value.defaults.find(([name])=>name===value)
        setDefaults(type??(preset?{name:preset[0],direction:preset[1],interval_months:preset[2],reminder_days:7}:null))
      }}><option value="">Custom service</option>
        <optgroup label="Saved types">{templates.value.custom.map(type=><option value={type.id} key={type.id}>{type.name}</option>)}</optgroup>
        <optgroup label="Starter types">{templates.value.defaults.map(([name])=><option value={name} key={name}>{name}</option>)}</optgroup>
      </select></label>}
      <label>Name<input name="name" key={defaults?.name} defaultValue={defaults?.name} required /></label>
      <label>Type<select name="kind" key={defaults?.direction} defaultValue={defaults?.direction??'collection'}>{Object.entries(actions).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
      <label>Client (optional)<select name="organization"><option value="">Agency-wide</option>{setup.value?.organizations.map(org=><option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
      <label>Supplier<input name="supplier" /></label><label>Domain<input name="domain" /></label>
      <label>Amount<input name="amount" min="0" step=".01" type="number" required /></label><label>Currency<input name="currency" defaultValue="USD" maxLength="3" required /></label>
      <label>Interval in months<input name="interval" key={defaults?.interval_months} defaultValue={defaults?.interval_months??1} min="1" max="120" type="number" required /></label>
      <label>Next due date<input name="due" type="date" required /></label><label>Remind days before<input name="reminder" key={defaults?.reminder_days} defaultValue={defaults?.reminder_days??7} min="0" max="365" type="number" required /></label>
      <label>Notes<textarea name="notes" /></label><button disabled={busy}>Save service</button>
    </form>}
    {services.error && <p className="error" role="alert">{services.error}</p>}
    {recordId && list?.length===0 && <p>Service not found.</p>}
    {list?.map(item=><div className="row" key={item.id}>
      <div><strong>{item.name}</strong><small>{money(item.amount_minor,item.currency)} · {iso(item.due_on)} · {actions[item.kind]}</small></div>
      {item.confirmed_at?<div className="monitor-actions"><span className="badge">Confirmed</span>
        <button disabled={busy} onClick={()=>action(()=>api('billing/services/'+item.id+'/advance',{ due:iso(item.due_on) }))}>Schedule next occurrence</button></div>:<button disabled={busy} onClick={()=>action(()=>api('billing/services/'+item.id+'/confirm',{}))}>Mark {item.kind==='domain'?'renewed':'confirmed'}</button>}
    </div>)}
  </section>
}

export function BillingAttention({ api,revision }) {
  const { value }=useRecord(api,'billing/services',revision)
  const summary=useRecord(api,'billing/summary',revision)
  const invoices=summary.value?.documents.filter(doc=>doc.kind==='invoice' && doc.state==='issued' && doc.balance>0 && doc.due_on<=now()) ?? []
  const reminders=value?.filter(item=>item.reminder_at && !item.confirmed_at) ?? []
  if (!reminders.length && !invoices.length) return null
  return <section className="panel"><h2>Billing and renewals</h2>{invoices.map(document=><DocumentRow key={document.id} document={document} />)}{reminders.map(item=><a className="row ticket-link" key={item.id} href={'#billing/service-'+item.id}>
    <div><strong>{item.name}</strong><small>{actions[item.kind]} · Due {iso(item.due_on)}</small></div>
  </a>)}</section>
}

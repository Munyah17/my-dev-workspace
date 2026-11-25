import { useRef,useState } from 'react'
import { useRecord } from './useRecord.js'

const today=()=>new Date().toISOString().slice(0,10)
const day=value=>value?.slice(0,10) ?? ''
const money=(minor,code)=>code+' '+(Number(minor)/100).toLocaleString(undefined,{ minimumFractionDigits:2,maximumFractionDigits:2 })
function fields(event) {
  event.preventDefault()
  return Object.fromEntries(new FormData(event.currentTarget))
}
const minor=value=>Math.round(Number(value)*100)
const statusChoices={ Draft:['Confirmed','Cancelled'],Confirmed:['In progress','Cancelled'],'In progress':['Cancelled'] }
const itemTypes={ product:'Physical product',service:'One-time service',recurring:'Recurring service' }

function pendingKey(ref,key) {
  if (ref.current?.key!==key) ref.current={ key,id:crypto.randomUUID() }
  return ref.current.id
}

function WorkspacePicker({ scopes,value,onChange }) {
  return scopes?.length>1 && <label>Workspace <select value={value} onChange={event=>onChange(event.target.value)}>
    {scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.name}</option>)}
  </select></label>
}

function OrderRow({ order }) {
  return <a className="row ticket-link" href={'#orders/'+order.id}>
    <div><strong>Order {order.number} · {order.recipient}</strong><small>{order.state} · {day(order.created_at)}{order.blocked ? ' · Awaiting stock' : ''}</small></div>
    <span className="badge">{money(order.total_minor,order.currency)}</span>
  </a>
}

export function Orders({ api,revision,action,busy,recordId }) {
  const [scope,setScope]=useState('')
  const listing=useRecord(api,recordId?null:'operations/overview'+(scope?'?workspace='+encodeURIComponent(scope):''),revision)
  const detail=useRecord(api,recordId?'operations/orders/'+recordId:null,revision)
  if (listing.error || detail.error) return <p className="error" role="alert">{listing.error || detail.error}</p>
  if (recordId) {
    if (!detail.value) return <p>Opening order…</p>
    return <OrderDetail key={recordId} data={detail.value} api={api} action={action} busy={busy} />
  }
  if (!listing.value) return <p>Opening orders…</p>
  const { scopes,orders,quotes }=listing.value
  return <section className="panel">
    <WorkspacePicker scopes={scopes} value={scope || scopes[0]?.id} onChange={setScope} />
    {quotes.length>0 && <form className="fields" onSubmit={event=>{const values=fields(event);action(async()=>{
      const order=await api('operations/orders',{ quote:values.quote })
      window.location.hash='orders/'+order.id
    })}}>
      <label>Accepted quote<select name="quote" required defaultValue=""><option value="">Select an accepted quote</option>{quotes.map(quote=>
        <option value={quote.id} key={quote.id}>Quote {quote.number} · {quote.recipient}</option>)}</select></label>
      <button className="primary" disabled={busy}>Create order from quote</button>
    </form>}
    {orders.map(order=><OrderRow key={order.id} order={order} />)}
    {!orders.length && <p className="empty">No orders to show.</p>}
  </section>
}

function OrderDetail({ data,api,action,busy }) {
  const { order,lines,staff,invoice,team,details,products,units,events }=data
  const post=(operation,body)=>action(()=>api('operations/orders/'+order.id+'/'+operation,body))
  return <section className="panel">
    <a href="#orders">All orders</a>
    <div className="thread-heading"><div><h2>Order {order.number} · {order.recipient}</h2><p>{order.state}</p></div><span className="badge">{money(order.total_minor,order.currency)}</span></div>
    {staff && <a href={'#billing/'+order.source_quote}>Source quotation</a>}
    {invoice && <p><a href={'#billing/'+invoice.id}>Invoice {invoice.number}</a></p>}
    {staff && <>
      <details className="monitor-details"><summary>Assignment and sharing</summary>
        <form className="fields" onSubmit={event=>{const values=fields(event);post('details',{ ...values,shared:values.shared==='on' })}}>
          <label>Assignee<select name="assignee" defaultValue={details?.assignee ?? ''}><option value="">Unassigned</option>{team.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Private order notes<textarea name="notes" defaultValue={details?.notes} /></label>
          <label className="checkbox"><input name="shared" type="checkbox" defaultChecked={order.shared} />Share order status with this client</label>
          <button disabled={busy}>Save order details</button>
        </form>
      </details>
      <div className="monitor-actions">{statusChoices[order.state]?.map(state=><button key={state} disabled={busy} onClick={()=>post('state',{ state })}>{state}</button>)}</div>
    </>}
    {lines.map(line=><article key={line.id} className="monitor-details">
      <div className="thread-heading"><div><strong>{line.description}</strong><small> · Quantity {line.quantity}</small></div><span>{money(line.total_minor,order.currency)}</span></div>
      {staff && <OrderLine line={line} products={products} units={units} post={post} busy={busy} fulfill={['Confirmed','In progress','Partially fulfilled','Fulfilled'].includes(order.state)} />}
    </article>)}
    {staff && events.length>0 && <details className="monitor-details"><summary>Order history</summary>{events.map(event=>
      <div className="row" key={event.id}>{event.detail}<small>{new Date(event.created_at).toLocaleString()} · {event.actor_id}</small></div>
    )}</details>}
  </section>
}

function OrderLine({ line,products,units,post,busy,fulfill }) {
  const [kind,setKind]=useState(line.kind ?? 'service')
  const assigned=units.filter(unit=>unit.line_id===line.id)
  const available=units.filter(unit=>unit.product_id===line.product_id && unit.state==='available')
  return <>
    <p>{line.kind?itemTypes[line.kind]:'Line type unassigned'}{line.fulfilled?' · Complete':''}</p>
    {!assigned.length && !line.fulfilled && <details className="monitor-details"><summary>Set line type</summary>
      <form className="fields" onSubmit={event=>{const values=fields(event);post('plan',{ line:line.id,kind,product:values.product })}}>
        <label>Type<select value={kind} onChange={event=>setKind(event.target.value)}>{Object.entries(itemTypes).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
        {kind==='product' && <label>Stock product<select name="product" required defaultValue={line.product_id ?? ''}><option value="">Choose a product</option>
          {products.map(product=><option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label>}
        <button disabled={busy}>Save line type</button>
      </form>
    </details>}
    {fulfill && line.kind==='product' && assigned.length<line.quantity && <>
      {available.length ? <form className="fields" onSubmit={event=>post('reserve',{ line:line.id,unit:fields(event).unit })}>
        <label>Stock to reserve<select name="unit">{available.map(unit=><option value={unit.id} key={unit.id}>{unit.serial || unit.id.slice(0,8)}</option>)}</select></label>
        <button disabled={busy}>Reserve stock</button>
      </form> : <p className="notice">Awaiting stock for this order line.</p>}
    </>}
    {assigned.map(unit=><div className="row" key={unit.id}><div><strong>{unit.serial || unit.id.slice(0,8)}</strong><small>{unit.state}</small></div>
      <div className="monitor-actions">
        {unit.state==='reserved' && <button disabled={busy} onClick={()=>post('allocate',{ line:line.id,unit:unit.id })}>Confirm delivery</button>}
        <details><summary>Return to stock</summary><form className="fields" onSubmit={event=>post('return',{ line:line.id,unit:unit.id,reason:fields(event).reason })}>
          <label>Reason<input name="reason" required /></label><button disabled={busy}>Return unit</button>
        </form></details>
      </div>
    </div>)}
    {line.kind==='recurring' && line.fulfilled && (line.recurring_service ? <a href={'#billing/service-'+line.recurring_service}>View recurring service</a>
      : <details className="monitor-details"><summary>Start recurring collection</summary>
        <form className="fields" onSubmit={event=>{const values=fields(event);post('start-recurring',{
          line:line.id,due:values.due,interval:Number(values.interval),reminder:Number(values.reminder),
        })}}>
          <label>First collection date<input name="due" type="date" required /></label>
          <label>Interval in months<input name="interval" type="number" min="1" max="120" defaultValue="1" required /></label>
          <label>Reminder days<input name="reminder" type="number" min="0" max="365" defaultValue="7" required /></label>
          <button disabled={busy}>Schedule collection</button>
        </form>
      </details>)}
    {fulfill && ['service','recurring'].includes(line.kind) && !line.fulfilled && <button disabled={busy} onClick={()=>post('complete-service',{ line:line.id })}>Complete service</button>}
  </>
}

export function Inventory({ api,revision,action,busy,recordId }) {
  const [scope,setScope]=useState('')
  const [adding,setAdding]=useState(false)
  const key=useRef(null)
  const overview=useRecord(api,'operations/overview',revision)
  const scopes=overview.value?.scopes ?? []
  const workspace=scope || scopes[0]?.id
  const path=workspace?'operations/inventory'+(recordId?'/'+recordId:'')+'?workspace='+encodeURIComponent(workspace):null
  const result=useRecord(api,path,revision)
  if (result.error) return <p className="error" role="alert">{result.error}</p>
  if (!workspace || !result.value) return <p>Opening inventory…</p>
  if (recordId) {
    const { product,units,movements }=result.value
    return <section className="panel"><a href="#inventory">All products</a><h2>{product.name} · {product.sku}</h2>
      <button disabled={busy} onClick={()=>action(()=>api('operations/inventory/'+product.id+'/active',{workspace,active:!product.active}))}>
        {product.active?'Deactivate product':'Activate product'}
      </button>
      {product.active && <details className="monitor-details"><summary>Receive stock</summary>
        <form className="fields" onSubmit={event=>{
          const element=event.currentTarget
          const values=fields(event)
          const request=pendingKey(key,JSON.stringify(values))
          action(async()=>{await api('operations/inventory/'+product.id+'/receive',{ ...values,workspace,request,
            quantity:Number(values.quantity),cost:minor(values.cost),serials:values.serials?.split(/\r?\n/).map(value=>value.trim()).filter(Boolean) })
            key.current=null;element.reset()
          })
        }}>
          <label>Supplier<input name="supplier" required /></label><label>Received date<input name="date" type="date" required defaultValue={today()} /></label>
          <label>Quantity<input name="quantity" type="number" min="1" max="100" required defaultValue="1" /></label>
          <label>Unit cost ({product.currency})<input name="cost" type="number" min="0" step=".01" required defaultValue={Number(product.cost_minor)/100} /></label>
          <label>Reference<input name="reference" /></label>
          {product.serialized && <label>Serials or IMEIs, one per line<textarea name="serials" required /></label>}
          <button className="primary" disabled={busy}>Record receipt</button>
        </form>
      </details>}
      {units.map(unit=><div className="row" key={unit.id}><div><strong>{unit.serial || unit.id.slice(0,8)}</strong><small>{unit.state} · {unit.supplier} · {day(unit.received_on)}</small></div>
        {['available','damaged'].includes(unit.state) && <details><summary>{unit.state==='available'?'Mark damaged':'Restore unit'}</summary>
          <form className="fields" onSubmit={event=>{const values=fields(event);action(()=>api('operations/inventory/'+product.id+'/adjust',{
            workspace,unit:unit.id,damaged:unit.state==='available',reason:values.reason,
          }))}}><label>Reason<input name="reason" required /></label><button disabled={busy}>Record adjustment</button></form>
        </details>}
      </div>)}
      {movements.length>0 && <details className="monitor-details"><summary>Stock movement history</summary>{movements.map(item=><div className="row" key={item.id}>
        <div>{item.serial} · {item.action}<small>{item.reason}</small></div><small>{new Date(item.created_at).toLocaleString()}</small>
      </div>)}</details>}
    </section>
  }
  return <section className="panel">
    <WorkspacePicker scopes={scopes} value={workspace} onChange={setScope} />
    <button className="primary" onClick={()=>setAdding(!adding)}>{adding?'Close form':'Add product'}</button>
    {adding && <form className="fields" onSubmit={event=>{const values=fields(event);action(async()=>{
      const product=await api('operations/inventory',{ ...values,workspace,currency:values.currency.toUpperCase(),cost:minor(values.cost),price:minor(values.price),reorder:Number(values.reorder),serialized:values.serialized==='on' })
      window.location.hash='inventory/'+product.id
    })}}>
      <label>Product name<input name="name" required /></label><label>SKU<input name="sku" required /></label>
      <label>Category<input name="category" required /></label><label>Unit<input name="unit" required defaultValue="each" /></label>
      <label>Currency<input name="currency" maxLength="3" required defaultValue="USD" /></label>
      <label>Purchase cost<input name="cost" type="number" step=".01" min="0" required /></label><label>Sale price<input name="price" type="number" step=".01" min="0" required /></label>
      <label>Reorder level<input name="reorder" type="number" min="0" required defaultValue="0" /></label>
      <label className="checkbox"><input type="checkbox" name="serialized" />Track serial or IMEI</label>
      <button disabled={busy}>Save product</button>
    </form>}
    {result.value.map(product=><a className="row ticket-link" key={product.id} href={'#inventory/'+product.id}>
      <div><strong>{product.name} · {product.sku}</strong><small>On hand {product.on_hand} · Reserved {product.reserved} · Available {product.available}</small></div>
      {product.available<product.reorder_level && <span className="badge status-warning">Below reorder level</span>}
    </a>)}
  </section>
}

async function attachment(file) {
  if (!file?.size) return undefined
  if (file.size>1024*1024) throw new Error('Receipts are limited to 1 MB.')
  const bytes=new Uint8Array(await file.arrayBuffer())
  let binary=''
  for (const byte of bytes) binary+=String.fromCharCode(byte)
  return { name:file.name,content:btoa(binary) }
}

export function Transactions({ api,revision,action,busy }) {
  const [scope,setScope]=useState('')
  const [adding,setAdding]=useState(false)
  const [filters,setFilters]=useState({})
  const key=useRef(null)
  const overview=useRecord(api,'operations/overview'+(scope?'?workspace='+encodeURIComponent(scope):''),revision)
  const scopes=overview.value?.scopes ?? []
  const workspace=scope || scopes[0]?.id
  const suffix=workspace?'?workspace='+encodeURIComponent(workspace):''
  const report=useRecord(api,workspace?'operations/report'+suffix:null,revision)
  const expenses=useRecord(api,workspace?'operations/expenses'+suffix+'&'+new URLSearchParams(filters):null,revision)
  if (overview.error || expenses.error || report.error) return <p className="error" role="alert">{overview.error || expenses.error || report.error}</p>
  if (!workspace) return <p>Opening transactions…</p>
  return <section className="panel">
    <WorkspacePicker scopes={scopes} value={workspace} onChange={setScope} />
    <h2>Recorded sales and cash</h2>
    {report.value?.map(row=><div className="row" key={row.currency}><div><strong>{row.currency}</strong>
      <small>Invoiced {money(row.invoiced,row.currency)} · Receivables {money(row.receivables,row.currency)} · Cash received {money(row.received,row.currency)} · Expenses {money(row.expenses,row.currency)} · Net recorded cash {money(row.net_cash,row.currency)}</small></div></div>)}
    <details className="monitor-details"><summary>Filter expenses</summary><form className="fields" onSubmit={event=>setFilters(Object.fromEntries(Object.entries(fields(event)).filter(([,value])=>value)))}>
      <label>Supplier or category<input name="q" /></label>
      <label>Project<select name="project"><option value="">All</option>{overview.value.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Currency<input name="currency" maxLength="3" /></label>
      <label>From<input type="date" name="from" /></label><label>To<input type="date" name="to" /></label>
      <label>Status<select name="paid"><option value="">All</option><option value="true">Paid</option><option value="false">Due</option></select></label>
      <button>Apply filters</button>
    </form></details>
    <div className="monitor-actions"><button className="primary" onClick={()=>setAdding(!adding)}>{adding?'Close form':'Record expense'}</button></div>
    {adding && <form className="fields" onSubmit={event=>{
      const values=fields(event)
      action(async()=>{
        const receipt=await attachment(values.receipt)
        const input={ ...values,workspace,currency:values.currency.toUpperCase(),amount:minor(values.amount),paid:values.paid==='on',receipt }
        await api('operations/expenses',{ ...input,request:pendingKey(key,JSON.stringify(input)) })
        key.current=null;setAdding(false)
      })
    }}>
      <label>Supplier<input name="supplier" required /></label><label>Category<input name="category" required /></label>
      <label>Date<input name="date" type="date" required defaultValue={today()} /></label>
      <label>Currency<input name="currency" maxLength="3" required defaultValue="USD" /></label><label>Amount<input name="amount" type="number" min=".01" step=".01" required /></label>
      <label>Project<select name="project"><option value="">Agency-wide</option>{overview.value.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Supplier subscription<select name="service"><option value="">None</option>{overview.value.services.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Payment method<input name="method" /></label><label>Reference<input name="reference" /></label>
      <label className="checkbox"><input name="paid" type="checkbox" />Payment already made</label><label>Receipt<input type="file" name="receipt" /></label>
      <button disabled={busy}>Save expense</button>
    </form>}
    {expenses.value?.map(item=><div key={item.id} className="row"><div><strong>{item.supplier} · {item.category}</strong><small>{day(item.expense_on)}{item.project?' · '+item.project:''} · {item.paid?'Paid':'Due'}</small>
      {item.receipt_name && <a href={'/api/operations/expenses/'+item.id+'/receipt'+suffix}>{item.receipt_name}</a>}</div>
      <div>{money(item.amount_minor,item.currency)}
        {!item.paid && <details><summary>Record supplier payment</summary><form className="fields" onSubmit={event=>{const values=fields(event);action(()=>api('operations/expenses/'+item.id+'/pay',{ workspace,...values }))}}>
          <label>Method<input name="method" required /></label><button disabled={busy}>Confirm payment</button>
        </form></details>}
      </div>
    </div>)}
  </section>
}

export function OperationsAttention({ api,revision }) {
  const overview=useRecord(api,'operations/overview',revision)
  const inventory=useRecord(api,'operations/inventory',revision)
  const expenses=useRecord(api,'operations/expenses?paid=false',revision)
  const orders=overview.value?.orders.filter(order=>['Confirmed','In progress','Partially fulfilled'].includes(order.state)) ?? []
  const low=inventory.value?.filter(product=>product.available<product.reorder_level) ?? []
  const due=expenses.value?.filter(expense=>day(expense.expense_on)<=today()) ?? []
  if (!orders.length && !low.length && !due.length) return null
  return <section className="panel"><h2>Orders, stock and expenses</h2>
    {orders.map(order=><OrderRow key={order.id} order={order} />)}
    {low.map(product=><a className="row ticket-link" key={product.id} href={'#inventory/'+product.id}>{product.name} · Below reorder level</a>)}
    {due.map(expense=><a className="row ticket-link" key={expense.id} href="#transactions">{expense.supplier} · Payment due {day(expense.expense_on)}</a>)}
  </section>
}

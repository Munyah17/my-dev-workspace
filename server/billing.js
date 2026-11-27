import { invoiceBalance, invoiceStatus } from './business.js'

const fail = (status,message) => Object.assign(new Error(message),{ status })
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const id = value => {
  if (!uuid.test(value ?? '')) throw fail(404,'Record not found.')
  return value
}
export function text(value,max=160,required=true) {
  if (!required && (value == null || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length>max) throw fail(400,'Check the text fields.')
  return value.trim()
}
export function integer(value,min,max) {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw fail(400,'Check amounts and quantities.')
  return value
}
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw fail(400,'Choose a valid date.')
  return value
}
export function currency(value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw fail(400,'Use a three-letter currency code.')
  return value
}
function items(values) {
  if (!Array.isArray(values) || !values.length || values.length>100) throw fail(400,'Provide one to 100 line items.')
  return values.map((item,index) => {
    const quantity=integer(item.quantity,1,10000)
    const unit=integer(item.unit,0,100000000)
    const discount=integer(item.discount ?? 0,0,quantity*unit)
    const tax=integer(item.tax ?? 0,0,10000)
    const net=quantity*unit-discount
    return [index+1,text(item.description,1500),quantity,unit,discount,tax,net+Math.round(net*tax/10000),text(item.unitLabel,40,false)]
  })
}
function documentDetails(value={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400,'Check the document details.')
  const limits={ title:160,reference:160,purchaseOrder:160,attention:160,scope:4000,terms:4000,paymentInstructions:2000 }
  return Object.fromEntries(Object.entries(limits)
    .map(([key,limit])=>[key,text(value[key],limit,false)]).filter(([,value])=>value))
}
const dateOnly=value=>value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10)
const today = () => new Date().toISOString().slice(0,10)

function view(row) {
  const invoice = { id:row.id,currency:row.currency,status:row.state,dueDate:dateOnly(row.due_on),totalMinor:Number(row.total_minor) }
  const allocations = [{ invoiceId:row.id,currency:row.currency,amountMinor:Number(row.paid_minor) }]
  const status = row.kind==='invoice' ? invoiceStatus(invoice,allocations,today()) :
    row.state==='issued' ? (invoice.dueDate<today() ? 'expired' : 'sent') : row.state
  return { ...row,accepted_by:undefined,status,balance:invoiceBalance(invoice,allocations),due_on:invoice.dueDate }
}

export async function billingRoute(tx,{ method,pathname,body,account,search }) {
  const [, , , resource,key,operation,extra] = pathname.split('/')
  const query = async (sql,args) => (await tx.query(sql,args)).rows
  if (extra) throw fail(404,'Record not found.')
  if (!(await query("SELECT to_regclass('workspace_private.billing_documents') IS NOT NULL AS ready"))[0].ready)
    throw fail(503,'Billing needs the Phase 4 database migration.')
  const saveLines = async (document,lines) => {
    for (const line of lines) await query(`INSERT INTO billing_items
      (document_id,position,description,quantity,unit_minor,discount_minor,tax_bps,total_minor,unit_label)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[document,...line])
  }
  const scopes = await query('SELECT * FROM billing_scopes()')
  const requireStaff = workspace => {
    if (!scopes.some(item => item.id===workspace)) throw fail(404,'Billing record not found.')
  }
  const audit = (workspace,action,record) => query('INSERT INTO billing_audit(workspace_id,actor_id,operation,record_id) VALUES($1,$2,$3,$4)',[workspace,account.id,action,record])
  const orgs = workspace => query('SELECT * FROM billing_organizations($1)',[workspace])
  const scope = key || search.get('workspace') || scopes[0]?.id
  if (resource==='clients') {
    const workspace = body?.workspace || search.get('workspace') || scopes[0]?.id
    requireStaff(workspace)
    if (method==='GET' && !key) return query(`SELECT o.id,o.name,p.email,p.phone,coalesce(p.status,'Active') AS status
      FROM billing_organizations($1) o LEFT JOIN billing_profiles p ON p.workspace_id=$1 AND p.organization_id=o.id
      WHERE o.name ILIKE '%'||$2||'%' ORDER BY o.name`,[workspace,(search.get('q') ?? '').slice(0,160)])
    if (method==='POST' && !key) {
      const name = text(body.name)
      const [created] = await query('SELECT billing_create_organization($1,$2) AS id',[workspace,name])
      await query('INSERT INTO billing_profiles(workspace_id,organization_id,email,phone,address,notes) VALUES($1,$2,$3,$4,$5,$6)',[
        workspace,created.id,text(body.email,254,false),text(body.phone,80,false),text(body.address,500,false),text(body.notes,4000,false),
      ])
      return created
    }
    const organization=(await orgs(workspace)).find(item=>item.id===key)
    if (!organization) throw fail(404,'Client not found.')
    if (method==='GET' && !operation) {
      const [profile] = await query('SELECT * FROM billing_profiles WHERE workspace_id=$1 AND organization_id=$2',[workspace,key])
      const contacts=await query('SELECT id,name,email,phone FROM billing_contacts WHERE workspace_id=$1 AND organization_id=$2 ORDER BY name',[workspace,key])
      const documents=(await query('SELECT * FROM billing_documents WHERE workspace_id=$1 AND organization_id=$2 ORDER BY created_at DESC',[workspace,key])).map(view)
      const services=await query('SELECT id,name,kind,due_on FROM billing_services WHERE workspace_id=$1 AND organization_id=$2 ORDER BY due_on',[workspace,key])
      const projects=await query('SELECT id,name FROM projects WHERE workspace_id=$1 AND organization_id=$2 ORDER BY name',[workspace,key])
      const tickets=await query(`SELECT t.id,t.subject,t.state FROM tickets t JOIN projects p ON p.id=t.project_id
        WHERE p.workspace_id=$1 AND p.organization_id=$2 ORDER BY t.created_at DESC LIMIT 25`,[workspace,key])
      const opsReady=(await query("SELECT to_regclass('workspace_private.ops_orders') IS NOT NULL AS ready"))[0].ready
      const orders=opsReady ? await query(`SELECT id,number,state,currency,total_minor FROM ops_orders
        WHERE workspace_id=$1 AND organization_id=$2 ORDER BY created_at DESC`,[workspace,key]) : []
      return { ...organization,profile,contacts,documents,services,projects,tickets,orders }
    }
    if (method==='POST' && operation==='profile') {
      const status=body.status==='Inactive' ? 'Inactive':'Active'
      await query(`INSERT INTO billing_profiles VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(workspace_id,organization_id) DO UPDATE SET email=excluded.email,phone=excluded.phone,address=excluded.address,notes=excluded.notes,status=excluded.status`,
      [workspace,key,text(body.email,254,false),text(body.phone,80,false),text(body.address,500,false),text(body.notes,4000,false),status])
      return { saved:true }
    }
    if (method==='POST' && operation==='contact') {
      return (await query('INSERT INTO billing_contacts(workspace_id,organization_id,name,email,phone) VALUES($1,$2,$3,$4,$5) RETURNING id',[
        workspace,key,text(body.name),text(body.email,254),text(body.phone,80,false),
      ]))[0]
    }
  }
  if (resource==='summary' && method==='GET') {
    const documents=(await query('SELECT * FROM billing_documents WHERE ($1::text IS NULL OR workspace_id=$1) ORDER BY created_at DESC',[search.get('workspace')])).map(view)
    const totals=new Map()
    const summaryDocuments = documents.filter(doc=>doc.kind==='invoice' && !['draft','void'].includes(doc.state))
    for (const doc of summaryDocuments) {
      const total=totals.get(doc.currency) ?? { invoiced:0,cash:0,balance:0 }
      total.invoiced+=Number(doc.total_minor)
      total.cash+=Number(doc.paid_minor)
      total.balance+=doc.balance
      totals.set(doc.currency,total)
    }
    return { scopes,documents,totals:Object.fromEntries(totals),organizations:scope && scopes.some(item=>item.id===scope) ? await orgs(scope) : [] }
  }
  if (resource==='documents' && !key && method==='POST') {
    requireStaff(body.workspace)
    if (!['quote','invoice'].includes(body.kind)) throw fail(400,'Choose a document type.')
    const organization=(await orgs(body.workspace)).find(item=>item.id===body.organization)
    if (!organization) throw fail(404,'Client not found.')
    const [profile]=await query('SELECT address FROM billing_profiles WHERE workspace_id=$1 AND organization_id=$2',[body.workspace,organization.id])
    const lines=items(body.items)
    const [document]=await query(`INSERT INTO billing_documents(workspace_id,organization_id,kind,currency,due_on,issuer,recipient,recipient_address,total_minor,document_details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[body.workspace,organization.id,body.kind,currency(body.currency),date(body.due),
      scopes.find(item=>item.id===body.workspace).name,organization.name,text(body.address,1000,false) || profile?.address || '',lines.reduce((sum,line)=>sum+line[6],0),JSON.stringify(documentDetails(body.details))])
    await saveLines(document.id,lines)
    await audit(body.workspace,'draft created',document.id)
    return document
  }
  if (resource==='documents' && key) {
    const [doc]=await query('SELECT * FROM billing_documents WHERE id=$1',[id(key)])
    if (!doc) throw fail(404,'Document not found.')
    const staff=scopes.some(item=>item.id===doc.workspace_id)
    if (method==='GET' && !operation) {
      const lines=await query('SELECT * FROM billing_items WHERE document_id=$1 ORDER BY position',[doc.id])
      const payments=staff ? await query('SELECT id,amount_minor,received_on,method,reference,notes FROM billing_payments WHERE invoice_id=$1 ORDER BY received_on',[doc.id]) : []
      return { ...view(doc),accepted_by:undefined,staff,lines,payments }
    }
    if (method==='POST' && operation==='decision') {
      const [decision]=await query('SELECT billing_accept($1,$2) AS saved',[doc.id,body.decision])
      if (!decision.saved) throw fail(409,'This quotation can no longer be accepted or declined.')
      return decision
    }
    requireStaff(doc.workspace_id)
    if (method==='POST') {
      const [locked]=await query('SELECT * FROM billing_documents WHERE id=$1 FOR UPDATE',[doc.id])
      if (operation==='edit' && locked.state==='draft') {
        const lines=items(body.items)
        await query('DELETE FROM billing_items WHERE document_id=$1',[doc.id])
        await saveLines(doc.id,lines)
        await query('UPDATE billing_documents SET currency=$2,due_on=$3,total_minor=$4,document_details=$5,recipient_address=$6 WHERE id=$1',[
          doc.id,currency(body.currency),date(body.due),lines.reduce((sum,line)=>sum+line[6],0),
          JSON.stringify(body.details===undefined ? locked.document_details : documentDetails(body.details)),
          body.address===undefined ? locked.recipient_address : text(body.address,1000,false),
        ])
      } else if (operation==='issue' && locked.state==='draft') {
        if (dateOnly(locked.due_on)<today()) throw fail(400,'Due date must be today or later.')
        await query("UPDATE billing_documents SET state='issued',issued_on=current_date WHERE id=$1",[doc.id])
      } else if (operation==='void' && ['issued','draft'].includes(locked.state) && Number(locked.paid_minor)===0) {
        await query("UPDATE billing_documents SET state='void' WHERE id=$1",[doc.id])
      } else if (operation==='convert' && locked.kind==='quote' && locked.state==='accepted') {
        const [existing]=await query('SELECT id FROM billing_documents WHERE source_quote=$1',[doc.id])
        if (existing) return existing
        const [invoice]=await query(`INSERT INTO billing_documents(workspace_id,organization_id,kind,currency,due_on,issuer,recipient,recipient_address,source_quote,total_minor,document_details)
          VALUES($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [doc.workspace_id,doc.organization_id,doc.currency,date(body.due),doc.issuer,doc.recipient,doc.recipient_address,doc.id,doc.total_minor,JSON.stringify(doc.document_details)])
        await query(`INSERT INTO billing_items
          (document_id,position,description,quantity,unit_minor,discount_minor,tax_bps,total_minor,unit_label)
          SELECT $1,position,description,quantity,unit_minor,discount_minor,tax_bps,total_minor,unit_label
          FROM billing_items WHERE document_id=$2`,[invoice.id,doc.id])
        await audit(doc.workspace_id,'quote converted',invoice.id)
        return invoice
      } else if (operation==='payment' && locked.kind==='invoice' && locked.state==='issued') {
        const request=id(body.request)
        const amount=integer(body.amount,1,Number.MAX_SAFE_INTEGER)
        const received=date(body.date)
        const method=text(body.method,80)
        const reference=text(body.reference,160,false)
        const notes=text(body.notes,2000,false)
        const [existing]=await query('SELECT id,amount_minor,received_on,method,reference,notes FROM billing_payments WHERE invoice_id=$1 AND request_key=$2',[doc.id,request])
        if (existing) {
          if (Number(existing.amount_minor)!==amount || body.currency!==doc.currency || dateOnly(existing.received_on)!==received ||
            existing.method!==method || existing.reference!==reference || existing.notes!==notes) throw fail(409,'That payment request already has a different amount.')
          return { id:existing.id }
        }
        if (currency(body.currency)!==doc.currency || amount>Number(locked.total_minor)-Number(locked.paid_minor)) throw fail(409,'Payment exceeds the balance or uses a different currency.')
        const [payment]=await query(`INSERT INTO billing_payments(invoice_id,request_key,amount_minor,received_on,method,reference,notes,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[doc.id,request,amount,received,method,reference,notes,account.id])
        await query('UPDATE billing_documents SET paid_minor=paid_minor+$2 WHERE id=$1',[doc.id,amount])
        await audit(doc.workspace_id,'payment recorded',payment.id)
        return payment
      } else throw fail(409,'That action is unavailable for this document.')
      await audit(doc.workspace_id,operation,doc.id)
      return { saved:true }
    }
  }
  if (resource==='services') {
    if (method==='GET' && !key) {
      await query(`INSERT INTO billing_reminders(service_id,due_on)
        SELECT id,due_on FROM billing_services WHERE confirmed_at IS NULL AND due_on-reminder_days<=current_date ON CONFLICT DO NOTHING`)
      return query(`SELECT s.*,r.created_at AS reminder_at FROM billing_services s
        LEFT JOIN billing_reminders r ON r.service_id=s.id AND r.due_on=s.due_on ORDER BY s.due_on,s.name`)
    }
    if (method==='POST' && !key) {
      requireStaff(body.workspace)
      if (!['collection','supplier','domain'].includes(body.kind)) throw fail(400,'Choose a renewal type.')
      if (body.organization && !(await orgs(body.workspace)).some(org=>org.id===body.organization)) throw fail(404,'Client not found.')
      const [service]=(await query(`INSERT INTO billing_services(workspace_id,organization_id,name,supplier,domain,kind,currency,amount_minor,interval_months,due_on,reminder_days,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[body.workspace,body.organization || null,text(body.name),
        text(body.supplier,160,false),text(body.domain,253,false),body.kind,currency(body.currency),integer(body.amount,0,100000000000),
        integer(body.interval,1,120),date(body.due),integer(body.reminder,0,365),text(body.notes,2000,false)]))
      if(body.serviceType){
        const [type]=await query('SELECT id FROM erp_service_types WHERE id=$1 AND workspace_id=$2',[id(body.serviceType),body.workspace])
        if(!type) throw fail(404,'Billing service type not found.')
        await query('UPDATE billing_services SET service_type=$2 WHERE id=$1',[service.id,type.id])
      }
      return service
    }
    if (method==='POST' && key && operation==='advance') {
      const [service]=await query(`UPDATE billing_services SET last_confirmed_at=confirmed_at,confirmed_at=NULL,
        due_on=(due_on+make_interval(months=>interval_months))::date
        WHERE id=$1 AND confirmed_at IS NOT NULL AND due_on=$2 RETURNING id,workspace_id`,[id(key),date(body.due)])
      if (service) await audit(service.workspace_id,'next renewal scheduled',service.id)
      return { saved:true }
    }
    if (method==='POST' && key && operation==='confirm') {
      const [service]=await query(`UPDATE billing_services SET confirmed_at=now() WHERE id=$1 AND confirmed_at IS NULL
        RETURNING id,workspace_id`,[id(key)])
      if (service) await audit(service.workspace_id,'renewal confirmed',service.id)
      return { saved:true }
    }
  }
  throw fail(404,'Billing record not found.')
}

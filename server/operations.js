import { createHash } from 'node:crypto'
import { currency,date,integer,text } from './billing.js'

const fail=(status,message)=>Object.assign(new Error(message),{status})
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const id=value=>{
  if (!uuid.test(value ?? '')) throw fail(404,'Record not found.')
  return value
}
const fingerprint=values=>createHash('sha256').update(JSON.stringify(values)).digest('hex')

export async function operationsRoute(tx,{ method,pathname,body,account,search }) {
  const [, , ,resource,key,operation,extra]=pathname.split('/')
  if (extra) throw fail(404,'Record not found.')
  const query=async(sql,args)=>(await tx.query(sql,args)).rows
  if (!(await query("SELECT to_regclass('workspace_private.ops_orders') IS NOT NULL AS ready"))[0].ready)
    throw fail(503,'Operations needs the Phase 5 database migration.')
  const scopes=await query('SELECT * FROM billing_scopes()')
  const staff=workspace=>scopes.some(scope=>scope.id===workspace)
  const requireStaff=workspace=>{if (!staff(workspace)) throw fail(404,'Record not found.')}
  const workspace=body?.workspace || search.get('workspace') || scopes[0]?.id
  const event=(order,detail)=>query('INSERT INTO ops_order_events(order_id,actor_id,detail) VALUES($1,$2,$3)',[order,account.id,detail])
  const stockReason=reason=>query("SELECT set_config('workspace.stock_reason',$1,true)",[text(reason,500)])
  const audit=(workspace,record,detail)=>query('INSERT INTO billing_audit(workspace_id,actor_id,operation,record_id) VALUES($1,$2,$3,$4)',[workspace,account.id,detail,record])
  if (resource==='overview' && method==='GET') {
    const orders=await query(`SELECT o.*,d.recipient,
      CASE WHEN billing_staff(o.workspace_id) THEN EXISTS(SELECT 1 FROM ops_order_lines l JOIN ops_line_plans plan ON plan.line_id=l.id
        WHERE l.order_id=o.id AND plan.kind='product'
        AND l.quantity>(SELECT count(*) FROM ops_stock_units u WHERE u.line_id=l.id)
          +(SELECT count(*) FROM ops_stock_units u WHERE u.product_id=plan.product_id AND u.state='available'))
        ELSE false END AS blocked
      FROM ops_orders o JOIN billing_documents d ON d.id=o.source_quote
      WHERE ($1::text IS NULL OR o.workspace_id=$1) ORDER BY o.created_at DESC LIMIT 150`,[search.get('workspace')])
    const quotes=staff(workspace) ? await query(`SELECT d.id,d.number,d.recipient,d.currency,d.total_minor FROM billing_documents d
      WHERE d.workspace_id=$1 AND d.kind='quote' AND d.state='accepted' AND NOT EXISTS(SELECT 1 FROM ops_orders o WHERE o.source_quote=d.id)
      ORDER BY d.created_at DESC`,[workspace]) : []
    const projects=staff(workspace) ? await query('SELECT id,name FROM projects WHERE workspace_id=$1 ORDER BY name',[workspace]) : []
    const services=staff(workspace) ? await query("SELECT id,name FROM billing_services WHERE workspace_id=$1 AND kind='supplier' ORDER BY name",[workspace]) : []
    return { scopes,orders,quotes,projects,services }
  }
  if (resource==='orders' && !key && method==='POST') {
    const [quote]=await query("SELECT * FROM billing_documents WHERE id=$1 AND kind='quote' AND state='accepted' FOR UPDATE",[id(body.quote)])
    if (!quote) throw fail(404,'Accepted quote not found.')
    requireStaff(quote.workspace_id)
    const [old]=await query('SELECT id FROM ops_orders WHERE source_quote=$1',[quote.id])
    if (old) return old
    const [order]=await query(`INSERT INTO ops_orders(workspace_id,organization_id,source_quote,currency,total_minor)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[quote.workspace_id,quote.organization_id,quote.id,quote.currency,quote.total_minor])
    await query(`INSERT INTO ops_order_lines(order_id,position,description,quantity,unit_minor,discount_minor,tax_bps,total_minor)
      SELECT $1,position,description,quantity,unit_minor,discount_minor,tax_bps,total_minor FROM billing_items WHERE document_id=$2`,[order.id,quote.id])
    await event(order.id,'Converted accepted quote')
    return order
  }
  if (resource==='orders' && key) {
    const [order]=await query(`SELECT o.*,d.recipient FROM ops_orders o JOIN billing_documents d ON d.id=o.source_quote
      WHERE o.id=$1 ${method==='POST'?'FOR UPDATE OF o':''}`,[id(key)])
    if (!order) throw fail(404,'Order not found.')
    const lines=await query(`SELECT l.*,p.kind,p.product_id,p.fulfilled,p.recurring_service FROM ops_order_lines l LEFT JOIN ops_line_plans p ON p.line_id=l.id
      WHERE l.order_id=$1 ORDER BY l.position`,[order.id])
    if (method==='GET' && !operation) {
      const invoice=(await query('SELECT id,number FROM billing_documents WHERE source_quote=$1',[order.source_quote]))[0]
      if (!staff(order.workspace_id)) return { order,lines,invoice,staff:false }
      const products=await query('SELECT id,name,sku FROM ops_products WHERE workspace_id=$1 AND active ORDER BY name',[order.workspace_id])
      const units=await query(`SELECT u.id,u.product_id,u.line_id,u.serial,u.state FROM ops_stock_units u
        WHERE u.workspace_id=$1 AND (u.state='available' OR u.line_id IN (SELECT id FROM ops_order_lines WHERE order_id=$2))
        AND u.product_id IN (SELECT product_id FROM ops_line_plans WHERE line_id IN (SELECT id FROM ops_order_lines WHERE order_id=$2))
        ORDER BY u.serial NULLS LAST,u.id LIMIT 300`,[order.workspace_id,order.id])
      const events=await query('SELECT id,actor_id,detail,created_at FROM ops_order_events WHERE order_id=$1 ORDER BY created_at DESC',[order.id])
      const [details]=await query('SELECT notes,assignee FROM ops_order_details WHERE order_id=$1',[order.id])
      const team=await query('SELECT * FROM maintenance_team($1)',[order.workspace_id])
      return { order,lines,units,products,events,details,team,invoice,staff:true }
    }
    requireStaff(order.workspace_id)
    if (method==='POST') {
      if (operation==='details') {
        if (body.assignee && !(await query('SELECT id FROM maintenance_team($1) WHERE id=$2',[order.workspace_id,body.assignee])).length) throw fail(404,'Assignee not found.')
        await query(`INSERT INTO ops_order_details VALUES($1,$2,$3)
          ON CONFLICT(order_id) DO UPDATE SET notes=excluded.notes,assignee=excluded.assignee`,[order.id,text(body.notes,4000,false),body.assignee || null])
        await query('UPDATE ops_orders SET shared=$2 WHERE id=$1',[order.id,body.shared===true])
        await event(order.id,'Order details and sharing updated')
        return { saved:true }
      }
      if (operation==='state') {
        if (body.state===order.state) return { saved:true }
        const allowed={ Draft:['Confirmed','Cancelled'],Confirmed:['In progress','Cancelled'],'In progress':['Cancelled'],'Partially fulfilled':[] }
        if (!allowed[order.state]?.includes(body.state)) throw fail(409,'That order transition is unavailable.')
        if (body.state==='Cancelled' && (await query('SELECT id FROM ops_stock_units WHERE line_id IN (SELECT id FROM ops_order_lines WHERE order_id=$1) LIMIT 1',[order.id])).length)
          throw fail(409,'Return reserved stock before cancelling.')
        await query('UPDATE ops_orders SET state=$2 WHERE id=$1',[order.id,body.state])
        await event(order.id,body.state)
        return { saved:true }
      }
      const line=lines.find(line=>line.id===id(body.line))
      if (!line || order.state==='Cancelled') throw fail(404,'Order line not found.')
      if (operation==='plan') {
        if (!['product','service','recurring'].includes(body.kind)) throw fail(400,'Choose a line type.')
        if (line.fulfilled || (await query('SELECT id FROM ops_stock_units WHERE line_id=$1 LIMIT 1',[line.id])).length)
          throw fail(409,'A line with fulfillment activity cannot be changed.')
        let product=null
        if (body.kind==='product') {
          product=id(body.product)
          if (!(await query('SELECT id FROM ops_products WHERE id=$1 AND workspace_id=$2 AND active',[product,order.workspace_id])).length) throw fail(404,'Product not found.')
        }
        await query(`INSERT INTO ops_line_plans(line_id,kind,product_id) VALUES($1,$2,$3)
          ON CONFLICT(line_id) DO UPDATE SET kind=excluded.kind,product_id=excluded.product_id`,[line.id,body.kind,product])
        await event(order.id,'Classified line '+line.position+' as '+body.kind)
        return { saved:true }
      }
      if (!['Confirmed','In progress','Partially fulfilled','Fulfilled'].includes(order.state))
        throw fail(409,'Confirm the order before fulfillment.')
      if (operation==='start-recurring') {
        if (line.kind!=='recurring' || !line.fulfilled) throw fail(409,'Complete this recurring service line first.')
        if (line.recurring_service) return { id:line.recurring_service }
        const [service]=await query(`INSERT INTO billing_services(workspace_id,organization_id,name,kind,currency,amount_minor,
          interval_months,due_on,reminder_days) VALUES($1,$2,$3,'collection',$4,$5,$6,$7,$8) RETURNING id`,[
          order.workspace_id,order.organization_id,line.description.slice(0,160),order.currency,line.total_minor,
          integer(body.interval,1,120),date(body.due),integer(body.reminder,0,365),
        ])
        await query('UPDATE ops_line_plans SET recurring_service=$2 WHERE line_id=$1',[line.id,service.id])
        await event(order.id,'Scheduled recurring collection for line '+line.position)
        return service
      }
      if (operation==='complete-service') {
        if (!['service','recurring'].includes(line.kind)) throw fail(409,'Select a service line.')
        if (line.fulfilled) return { saved:true }
        await query('UPDATE ops_line_plans SET fulfilled=true WHERE line_id=$1',[line.id])
        await event(order.id,'Fulfilled service line '+line.position)
      } else if (['reserve','allocate','return'].includes(operation)) {
        if (line.kind!=='product') throw fail(409,'Select a physical product line.')
        const [unit]=await query('SELECT * FROM ops_stock_units WHERE id=$1 AND workspace_id=$2 AND product_id=$3 FOR UPDATE',
          [id(body.unit),order.workspace_id,line.product_id])
        if (!unit) throw fail(404,'Stock unit not found.')
        if (operation==='reserve') {
          if (unit.line_id===line.id && ['reserved','allocated'].includes(unit.state)) return { saved:true }
          const [count]=await query('SELECT count(*)::int AS amount FROM ops_stock_units WHERE line_id=$1',[line.id])
          if (unit.state!=='available' || count.amount>=line.quantity) throw fail(409,'This unit is unavailable or the line is already covered.')
          await query("UPDATE ops_stock_units SET state='reserved',line_id=$2 WHERE id=$1",[unit.id,line.id])
        } else if (operation==='allocate') {
          if (unit.state==='allocated' && unit.line_id===line.id) return { saved:true }
          if (unit.state!=='reserved' || unit.line_id!==line.id) throw fail(409,'Reserve this unit for the order first.')
          await query("UPDATE ops_stock_units SET state='allocated' WHERE id=$1",[unit.id])
        } else {
          if (unit.state==='available' && !unit.line_id) return { saved:true }
          if (!['reserved','allocated'].includes(unit.state) || unit.line_id!==line.id) throw fail(409,'This unit is assigned elsewhere.')
          await stockReason(body.reason)
          await query("UPDATE ops_stock_units SET state='available',line_id=NULL WHERE id=$1",[unit.id])
        }
        await event(order.id,operation+' for line '+line.position)
      } else throw fail(404,'Order action not found.')
      const [progress]=await query(`SELECT count(*)::int AS lines,
        count(*) FILTER(WHERE p.fulfilled OR (p.kind='product' AND l.quantity=(SELECT count(*) FROM ops_stock_units u WHERE u.line_id=l.id AND u.state='allocated')))::int AS done
        FROM ops_order_lines l LEFT JOIN ops_line_plans p ON p.line_id=l.id WHERE l.order_id=$1`,[order.id])
      const computed=progress.done===progress.lines?'Fulfilled':progress.done?'Partially fulfilled':'In progress'
      if (computed!==order.state) {
        await query('UPDATE ops_orders SET state=$2 WHERE id=$1',[order.id,computed])
        await event(order.id,computed)
      }
      return { saved:true }
    }
  }
  if (resource==='inventory') {
    requireStaff(workspace)
    if (method==='GET' && !key) return query(`SELECT p.*,count(u.id) FILTER(WHERE u.state IN ('available','reserved'))::int AS on_hand,
      count(u.id) FILTER(WHERE u.state='reserved')::int AS reserved,count(u.id) FILTER(WHERE u.state='available')::int AS available
      FROM ops_products p LEFT JOIN ops_stock_units u ON u.product_id=p.id WHERE p.workspace_id=$1 GROUP BY p.id ORDER BY p.name`,[workspace])
    if (method==='POST' && !key) {
      const [product]=await query(`INSERT INTO ops_products(workspace_id,name,sku,category,unit,currency,cost_minor,price_minor,reorder_level,serialized)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[workspace,text(body.name),text(body.sku,80),
        text(body.category,80),text(body.unit,30),currency(body.currency),integer(body.cost,0,100000000000),integer(body.price,0,100000000000),
        integer(body.reorder,0,100000),body.serialized===true])
      if (!product) throw fail(409,'This SKU is already in use.')
      await audit(workspace,product.id,'inventory product created')
      return product
    }
    const [product]=await query('SELECT * FROM ops_products WHERE id=$1 AND workspace_id=$2',[id(key),workspace])
    if (!product) throw fail(404,'Product not found.')
    if (method==='GET' && !operation) {
      const units=await query(`SELECT u.id,u.serial,u.state,u.line_id,r.supplier,r.received_on,r.cost_minor,r.reference
        FROM ops_stock_units u JOIN ops_stock_receipts r ON r.id=u.receipt_id WHERE u.product_id=$1 ORDER BY r.received_on DESC,u.id LIMIT 200`,[product.id])
      const movements=await query(`SELECT m.id,u.serial,m.action,m.reason,m.actor_id,m.created_at FROM ops_stock_movements m
        JOIN ops_stock_units u ON u.id=m.unit_id WHERE u.product_id=$1 ORDER BY m.created_at DESC LIMIT 80`,[product.id])
      return { product,units,movements }
    }
    if (method==='POST' && operation==='active') {
      if (product.active===body.active) return { saved:true }
      await query('UPDATE ops_products SET active=$2 WHERE id=$1',[product.id,body.active===true])
      await audit(workspace,product.id,body.active===true?'inventory product activated':'inventory product deactivated')
      return { saved:true }
    }
    if (method==='POST' && operation==='receive') {
      if (!product.active) throw fail(409,'Activate the product before receiving stock.')
      const count=integer(body.quantity,1,100)
      const serials=product.serialized && Array.isArray(body.serials) ? body.serials.map(value=>text(value,100)) : Array(count).fill(null)
      if (product.serialized && (serials.length!==count || serials.some(value=>!value) || new Set(serials).size!==count)) throw fail(400,'Provide one distinct serial for every unit.')
      const values=[product.id,text(body.supplier),date(body.date),integer(body.cost,0,100000000000),text(body.reference,160,false),serials]
      const digest=fingerprint(values)
      const request=id(body.request)
      const [receipt]=await query(`INSERT INTO ops_stock_receipts(workspace_id,request_key,product_id,supplier,received_on,cost_minor,reference,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[workspace,request,...values.slice(0,5),digest])
      if (!receipt) {
        const [prior]=await query('SELECT id,fingerprint FROM ops_stock_receipts WHERE workspace_id=$1 AND request_key=$2',[workspace,request])
        if (prior?.fingerprint!==digest) throw fail(409,'This receipt request already contains different information.')
        return { id:prior.id }
      }
      for (const serial of serials) {
        const [unit]=await query(`INSERT INTO ops_stock_units(workspace_id,product_id,receipt_id,serial) VALUES($1,$2,$3,$4)
          ON CONFLICT DO NOTHING RETURNING id`,[workspace,product.id,receipt.id,serial])
        if (!unit) throw fail(409,'This serial already exists. The receipt was rolled back.')
      }
      return receipt
    }
    if (method==='POST' && operation==='adjust') {
      const [unit]=await query('SELECT id,state FROM ops_stock_units WHERE id=$1 AND product_id=$2 FOR UPDATE',[id(body.unit),product.id])
      if (!unit) throw fail(404,'Stock unit not found.')
      const target=body.damaged===true?'damaged':'available'
      if (unit.state===target) return { saved:true }
      if (!['damaged','available'].includes(unit.state)) throw fail(409,'Return the unit from its order before adjusting it.')
      await stockReason(body.reason)
      await query('UPDATE ops_stock_units SET state=$2 WHERE id=$1',[unit.id,target])
      return { saved:true }
    }
  }
  if (resource==='expenses') {
    requireStaff(workspace)
    if (method==='GET' && !key) return query(`SELECT e.id,e.supplier,e.category,e.currency,e.amount_minor,e.expense_on,e.paid,
      e.payment_method,e.reference,e.project_id,e.receipt_name,p.name AS project
      FROM ops_expenses e LEFT JOIN projects p ON p.id=e.project_id WHERE e.workspace_id=$1
      AND ($2::text IS NULL OR e.project_id=$2) AND ($3::text IS NULL OR e.currency=$3)
      AND ($4::date IS NULL OR e.expense_on >= $4) AND ($5::date IS NULL OR e.expense_on <= $5)
      AND ($6::text IS NULL OR e.supplier ILIKE '%'||$6||'%' OR e.category ILIKE '%'||$6||'%')
      AND ($7::boolean IS NULL OR e.paid=$7) ORDER BY e.expense_on DESC`,[
      workspace,search.get('project'),search.get('currency'),search.get('from')?date(search.get('from')):null,
      search.get('to')?date(search.get('to')):null,(search.get('q') ?? '').slice(0,100),search.has('paid')?search.get('paid')==='true':null,
    ])
    if (method==='GET' && key && operation==='receipt') {
      const [file]=await query('SELECT receipt_name AS name,receipt_content AS content FROM ops_expenses WHERE id=$1 AND workspace_id=$2 AND receipt_content IS NOT NULL',[id(key),workspace])
      if (!file) throw fail(404,'Receipt not found.')
      return { file }
    }
    if (method==='POST' && key && operation==='pay') {
      const [expense]=await query('UPDATE ops_expenses SET paid=true,payment_method=$3 WHERE id=$1 AND workspace_id=$2 AND NOT paid RETURNING id',
        [id(key),workspace,text(body.method,80)])
      if (expense) await audit(workspace,expense.id,'supplier payment recorded')
      return { saved:true }
    }
    if (method==='POST' && !key) {
      const project=body.project || null
      const service=body.service ? id(body.service) : null
      if (project && !(await query('SELECT id FROM projects WHERE id=$1 AND workspace_id=$2',[project,workspace])).length) throw fail(404,'Project not found.')
      if (service && !(await query("SELECT id FROM billing_services WHERE id=$1 AND workspace_id=$2 AND kind='supplier'",[service,workspace])).length) throw fail(404,'Supplier service not found.')
      const receipt=body.receipt
      if (receipt && (typeof receipt.content!=='string' || receipt.content.length>1398104 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(receipt.content))) throw fail(400,'Invalid receipt attachment.')
      const values=[text(body.supplier),text(body.category,100),currency(body.currency),integer(body.amount,1,100000000000),
        date(body.date),body.paid===true,text(body.method,80,body.paid===true),text(body.reference,160,false),project,service,
        receipt?text(receipt.name,160):null,receipt?.content ?? null]
      const digest=fingerprint(values)
      const request=id(body.request)
      const [expense]=await query(`INSERT INTO ops_expenses(workspace_id,request_key,supplier,category,currency,amount_minor,expense_on,paid,
        payment_method,reference,project_id,service_id,receipt_name,receipt_content,created_by,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING id`,
        [workspace,request,...values,account.id,digest])
      if (expense) {
        await audit(workspace,expense.id,'expense recorded')
        return expense
      }
      const [prior]=await query('SELECT id,fingerprint FROM ops_expenses WHERE workspace_id=$1 AND request_key=$2',[workspace,request])
      if (prior?.fingerprint!==digest) throw fail(409,'This expense request already contains different information.')
      return { id:prior.id }
    }
  }
  if (resource==='project-costs' && key && method==='GET') {
    const [project]=await query('SELECT id,workspace_id FROM projects WHERE id=$1',[decodeURIComponent(key)])
    if (!project || !staff(project.workspace_id)) throw fail(404,'Project not found.')
    return query(`SELECT currency,sum(amount_minor) AS recorded,coalesce(sum(amount_minor) FILTER(WHERE paid),0) AS paid
      FROM ops_expenses WHERE project_id=$1 AND workspace_id=$2 GROUP BY currency ORDER BY currency`,[project.id,project.workspace_id])
  }
  if (resource==='report' && method==='GET') {
    requireStaff(workspace)
    return query(`WITH invoices AS (
      SELECT currency,sum(total_minor) AS invoiced,sum(total_minor-paid_minor) AS receivables FROM billing_documents
      WHERE workspace_id=$1 AND state='issued' AND kind='invoice' GROUP BY currency
    ), cash AS (
      SELECT d.currency,sum(p.amount_minor) AS received FROM billing_payments p
      JOIN billing_documents d ON d.id=p.invoice_id WHERE d.workspace_id=$1 GROUP BY d.currency
    ), expenses AS (
      SELECT currency,sum(amount_minor) AS expenses,coalesce(sum(amount_minor) FILTER(WHERE paid),0) AS paid
      FROM ops_expenses WHERE workspace_id=$1 GROUP BY currency
    ), codes AS (SELECT currency FROM invoices UNION SELECT currency FROM expenses UNION SELECT currency FROM cash)
    SELECT currency,coalesce(invoiced,0) AS invoiced,coalesce(receivables,0) AS receivables,coalesce(received,0) AS received,
      coalesce(expenses.expenses,0) AS expenses,coalesce(paid,0) AS paid,coalesce(received,0)-coalesce(paid,0) AS net_cash
    FROM codes LEFT JOIN invoices USING(currency) LEFT JOIN cash USING(currency) LEFT JOIN expenses USING(currency) ORDER BY currency`,[workspace])
  }
  throw fail(404,'Record not found.')
}

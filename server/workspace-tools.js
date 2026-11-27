import { checkDeveloperConnection,developerStatus,providerSecretName,runClaude } from './developer-providers.js'
import { currency,date,integer,text } from './billing.js'

const fail=(status,message)=>Object.assign(Error(message),{status})
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
function id(value){
  if(!uuid.test(value??'')) throw fail(404,'Record not found.')
  return value
}
const hosts={
  Devin:['app.devin.ai','devin.ai'],
  Cursor:['cursor.com','www.cursor.com','agents.cursor.com'],
  Claude:['claude.ai','www.claude.ai'],
}
const kinds=['credit-note','debit-note','notice','claim','proposal','boq','bom']
const types=[
  ['Hosting','collection',1],['Domain renewal','domain',12],['Vehicle tracking','collection',1],
  ['Monthly service','collection',1],['Starlink subscription','collection',1],['Services tendered','collection',1],
]
const readDate=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10)

export async function workspaceToolsRoute(tx,{method,pathname,body,account,search}){
  const [,,area,resource,key,operation,extra]=pathname.split('/')
  if(extra) throw fail(404,'Record not found.')
  const query=async(sql,args)=>(await tx.query(sql,args)).rows
  const [ready]=await query("SELECT to_regclass('workspace_private.erp_service_types') IS NOT NULL AS ready")
  if(!ready.ready) throw fail(503,'Workspace tools need their database migration.')
  if(area==='platform'){
    const [access]=await query('SELECT platform_allowed() AS allowed')
    if(resource==='access' && method==='GET' && !key) return access
    if(!access.allowed) throw fail(404,'Platform administration not found.')
    if(resource==='workspaces' && method==='GET' && !key) return query('SELECT * FROM platform_workspace_overview()')
    if(resource==='workspaces' && method==='POST' && key && !operation){
      if(!['pilot','starter','agency','enterprise'].includes(body.plan) || !['trial','active','paused','closed'].includes(body.lifecycle))
        throw fail(400,'Choose a platform plan and lifecycle.')
      const [updated]=await query('SELECT platform_update_workspace($1,$2,$3) AS saved',[decodeURIComponent(key),body.plan,body.lifecycle])
      if(!updated.saved) throw fail(404,'Workspace not found.')
      return updated
    }
    throw fail(404,'Platform record not found.')
  }
  if(area==='developer-tools'){
    if(!account.agency) throw fail(404,'Developer tools not found.')
    if(resource==='connections'){
      if(method==='GET' && !key){
        const workspaces=await query('SELECT w.*,developer_workspace_owner(w.id) AS editable FROM maintenance_workspaces() w')
        const connections=(await query('SELECT * FROM developer_connections ORDER BY provider')).map(connection=>({
          ...connection,environmentKey:providerSecretName(connection),
        }))
        return {workspaces,connections}
      }
      if(method==='POST' && !key){
        const workspace=text(body.workspace,120)
        if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed)
          throw fail(404,'Workspace not found.')
        if(!Object.hasOwn(hosts,body.provider) || !/^[A-Z][A-Z0-9_]{0,40}$/.test(body.secretRef??''))
          throw fail(400,'Choose a provider and a valid server credential reference.')
        const scope=body.provider==='Cursor'?'Cloud Agents':text(body.scope,100)
        if(body.provider!=='Cursor' && !/^[a-zA-Z0-9_-]{3,100}$/.test(scope)) throw fail(400,'Enter a valid organization or model ID.')
        const [connection]=await query(`INSERT INTO developer_connections(workspace_id,provider,secret_ref,external_scope)
          VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,provider) DO UPDATE SET secret_ref=excluded.secret_ref,
          external_scope=excluded.external_scope,checked_at=NULL RETURNING *`,[workspace,body.provider,body.secretRef,scope])
        return {environmentKey:providerSecretName(connection)}
      }
      if(method==='POST' && key && operation==='check'){
        const [connection]=await query('SELECT * FROM developer_connections WHERE workspace_id=$1 AND provider=$2',[text(body.workspace,120),key])
        if(!connection || !(await query('SELECT developer_workspace_owner($1) AS allowed',[connection.workspace_id]))[0].allowed) throw fail(404,'Connection not found.')
        await checkDeveloperConnection(connection)
        await query('UPDATE developer_connections SET checked_at=now() WHERE workspace_id=$1 AND provider=$2',[connection.workspace_id,key])
        return {checked:true}
      }
      if(method==='POST' && key && operation==='disconnect'){
        const workspace=text(body.workspace,120)
        if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed) throw fail(404,'Connection not found.')
        await query('DELETE FROM developer_connections WHERE workspace_id=$1 AND provider=$2',[workspace,key])
        return {saved:true}
      }
    }
    if(resource==='runs'){
      if(method==='GET' && !key) return query(`SELECT r.*,t.title AS task_title FROM developer_model_runs r
        JOIN maintenance_tasks t ON t.id=r.task_id ORDER BY r.created_at DESC LIMIT 40`)
      if(method==='POST' && !key){
        const [task]=await query('SELECT id,workspace_id,title FROM maintenance_tasks WHERE id=$1',[id(body.task)])
        if(!task) throw fail(404,'Task not found.')
        const [connection]=await query("SELECT * FROM developer_connections WHERE workspace_id=$1 AND provider='Claude' AND checked_at IS NOT NULL",[task.workspace_id])
        if(!connection) throw fail(409,'Configure and test Claude for this task’s workspace first.')
        const prompt=text(body.prompt,4000)
        const response=await runClaude(connection,'Task: '+task.title+'\n\n'+prompt)
        return (await query('INSERT INTO developer_model_runs(task_id,actor_id,model,prompt,response) VALUES($1,$2,$3,$4,$5) RETURNING id',[
          task.id,account.id,connection.external_scope,prompt,response,
        ]))[0]
      }
    }
    if(resource==='links' && key && operation==='status' && method==='GET'){
      const [link]=await query('SELECT l.*,t.workspace_id FROM developer_work_links l JOIN maintenance_tasks t ON t.id=l.task_id WHERE l.id=$1',[id(key)])
      if(!link || !['Devin','Cursor'].includes(link.provider)) throw fail(404,'Remote agent link not found.')
      const [connection]=await query('SELECT * FROM developer_connections WHERE workspace_id=$1 AND provider=$2 AND checked_at IS NOT NULL',[link.workspace_id,link.provider])
      if(!connection) throw fail(409,'Configure and test the provider first.')
      return developerStatus(connection,link)
    }
    if(resource==='links' && method==='GET' && !key){
      const tasks=await query("SELECT id,title FROM maintenance_tasks WHERE state<>'Done' ORDER BY title")
      const links=await query(`SELECT l.*,t.title AS task_title,t.state FROM developer_work_links l
        JOIN maintenance_tasks t ON t.id=l.task_id ORDER BY l.created_at DESC`)
      return {tasks,links}
    }
    if(resource==='links' && method==='POST' && !key){
      const task=id(body.task)
      if(!(await query('SELECT id FROM maintenance_tasks WHERE id=$1',[task])).length) throw fail(404,'Task not found.')
      const provider=body.provider
      let link
      try {link=new URL(body.url)} catch {throw fail(400,'Enter a valid provider link.')}
      if(link.protocol!=='https:' || link.username || link.password || link.port || !Object.hasOwn(hosts,provider) || !hosts[provider].includes(link.hostname))
        throw fail(400,'Use an HTTPS link from the chosen provider.')
      const [saved]=await query(`INSERT INTO developer_work_links(task_id,provider,title,url,created_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[task,provider,text(body.title,160),link.href,account.id])
      return saved??{saved:true}
    }
    if(resource==='links' && key && operation==='remove' && method==='POST'){
      await query('DELETE FROM developer_work_links WHERE id=$1',[id(key)])
      return {saved:true}
    }
    throw fail(404,'Developer tools not found.')
  }
  const scopes=await query('SELECT * FROM billing_scopes()')
  const workspace=body?.workspace || search.get('workspace') || scopes[0]?.id
  const scope=scopes.find(item=>item.id===workspace)
  if(!scope) throw fail(404,'Accounting record not found.')
  if(resource==='setup' && method==='GET'){
    const organizations=await query('SELECT * FROM billing_organizations($1)',[workspace])
    const invoices=await query("SELECT id,number,organization_id,recipient FROM billing_documents WHERE workspace_id=$1 AND kind='invoice' AND state='issued' ORDER BY number DESC LIMIT 200",[workspace])
    return {scopes,organizations,invoices}
  }
  if(resource==='service-types' && !key){
    if(method==='GET') return { defaults:types,custom:await query('SELECT * FROM erp_service_types WHERE workspace_id=$1 ORDER BY name',[workspace]) }
    if(method==='POST'){
      if(!['collection','supplier','domain'].includes(body.direction)) throw fail(400,'Choose a billing direction.')
      return (await query(`INSERT INTO erp_service_types(workspace_id,name,direction,interval_months,reminder_days)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,name) DO UPDATE SET direction=excluded.direction,
        interval_months=excluded.interval_months,reminder_days=excluded.reminder_days RETURNING id`,[
        workspace,text(body.name),body.direction,integer(body.interval,1,120),integer(body.reminder,0,365),
      ]))[0]
    }
  }
  if(resource==='documents'){
    if(method==='GET' && !key) return query('SELECT id,number,kind,title,recipient,issued_on,total_minor,currency FROM erp_documents WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[workspace])
    if(method==='GET' && key){
      const [doc]=await query('SELECT * FROM erp_documents WHERE id=$1 AND workspace_id=$2',[id(key),workspace])
      if(!doc) throw fail(404,'Document not found.')
      return doc
    }
    if(method==='POST' && !key){
      if(!kinds.includes(body.kind)) throw fail(400,'Choose a document type.')
      const org=body.organization ? (await query('SELECT * FROM billing_organizations($1) WHERE id=$2',[workspace,body.organization]))[0] : null
      if(body.organization && !org) throw fail(404,'Client not found.')
      const invoice=body.invoice ? (await query("SELECT id FROM billing_documents WHERE id=$1 AND workspace_id=$2 AND organization_id=$3 AND kind='invoice' AND state='issued'",[id(body.invoice),workspace,org?.id]))[0] : null
      if(body.invoice && !invoice) throw fail(404,'Invoice not found for this client.')
      const lines=body.lines ?? []
      if(!Array.isArray(lines)||lines.length>50) throw fail(400,'Use up to 50 line items.')
      const clean=lines.map(line=>({
        description:text(line.description,500),unit:text(line.unit,40,false),
        quantity:integer(line.quantity,1,1000000),unitMinor:integer(line.unitMinor,0,100000000),
      }))
      if(['credit-note','debit-note','boq','bom'].includes(body.kind) && !clean.length) throw fail(400,'Add at least one line item.')
      return (await query(`INSERT INTO erp_documents(workspace_id,organization_id,invoice_id,kind,title,issued_on,issuer,recipient,body,currency,lines,total_minor,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[
        workspace,org?.id??null,invoice?.id??null,body.kind,text(body.title),date(body.date),scope.name,org?.name??text(body.recipient,160,false),
        text(body.body,12000,false),currency(body.currency),JSON.stringify(clean),clean.reduce((sum,line)=>sum+line.quantity*line.unitMinor,0),account.id,
      ]))[0]
    }
  }
  if(resource==='staff' && !key){
    if(method==='GET'){
      const employees=await query('SELECT * FROM erp_employees WHERE workspace_id=$1 ORDER BY active DESC,name',[workspace])
      const entries=await query(`SELECT e.*,p.name FROM erp_personnel_entries e JOIN erp_employees p ON p.id=e.employee_id
        WHERE e.workspace_id=$1 ORDER BY e.start_on DESC LIMIT 150`,[workspace])
      const payroll=await query('SELECT * FROM erp_payroll WHERE workspace_id=$1 ORDER BY end_on DESC LIMIT 120',[workspace])
      return {employees,entries,payroll}
    }
    if(method==='POST') return (await query(`INSERT INTO erp_employees(workspace_id,name,email,job_title,start_on)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[workspace,text(body.name),text(body.email,254,false),text(body.job,160),date(body.start)]))[0]
  }
  if(resource==='staff' && key && method==='POST'){
    const [employee]=await query('SELECT id,name,active FROM erp_employees WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id(key),workspace])
    if(!employee) throw fail(404,'Employee not found.')
    if(operation==='edit'){
      await query('UPDATE erp_employees SET name=$2,email=$3,job_title=$4,active=$5 WHERE id=$1',[employee.id,text(body.name),text(body.email,254,false),text(body.job,160),body.active===true])
      return {saved:true}
    }
    if(!employee.active) throw fail(409,'Activate the employee first.')
    const start=date(body.start),end=date(body.end)
    if(end<start) throw fail(400,'The end date precedes the start date.')
    if(operation==='entry'){
      if(!['leave','hours','bonus'].includes(body.kind)) throw fail(400,'Choose a staff record type.')
      if(body.kind!=='leave' && start!==end) throw fail(400,'Hours and bonuses must use one date.')
      const minutes=body.kind==='hours'?integer(body.minutes,1,1440):null
      const amount=body.kind==='bonus'?integer(body.amount,0,100000000000):null
      return (await query(`INSERT INTO erp_personnel_entries(workspace_id,employee_id,kind,start_on,end_on,description,minutes,amount_minor,currency,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[workspace,employee.id,body.kind,start,end,text(body.description,1000),
        minutes,amount,body.kind==='bonus'?currency(body.currency):null,account.id]))[0]
    }
    if(operation==='payroll'){
      const code=currency(body.currency)
      const base=integer(body.base,0,100000000000)
      const deductions=integer(body.deductions,0,100000000000)
      const [existing]=await query('SELECT * FROM erp_payroll WHERE employee_id=$1 AND start_on<=$3 AND end_on>=$2',[employee.id,start,end])
      if(existing){
        if(readDate(existing.start_on)===start && readDate(existing.end_on)===end && existing.currency===code &&
          Number(existing.base_minor)===base && Number(existing.deduction_minor)===deductions) return {id:existing.id}
        throw fail(409,'This employee already has an overlapping payroll record.')
      }
      const [approved]=await query(`SELECT coalesce(sum(amount_minor) FILTER(WHERE kind='bonus' AND currency=$4),0) AS bonuses,
        coalesce(sum(minutes) FILTER(WHERE kind='hours'),0) AS minutes,
        count(*) FILTER(WHERE kind='bonus' AND currency<>$4)::int AS other_currency
        FROM erp_personnel_entries WHERE employee_id=$1 AND status='approved' AND start_on BETWEEN $2 AND $3`,[employee.id,start,end,code])
      if(approved.other_currency) throw fail(409,'The period has approved bonuses in another currency.')
      if(deductions>base+Number(approved.bonuses)) throw fail(400,'Deductions exceed gross pay.')
      return (await query(`INSERT INTO erp_payroll(workspace_id,employee_id,employee_name,issuer,start_on,end_on,currency,base_minor,bonus_minor,deduction_minor,paid_minutes,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[
        workspace,employee.id,employee.name,scope.name,start,end,code,base,approved.bonuses,deductions,approved.minutes,text(body.notes,2000,false),account.id,
      ]))[0]
    }
  }
  if(resource==='entries' && key && method==='POST' && operation==='review'){
    if(!['approved','declined'].includes(body.status)) throw fail(400,'Choose an approval decision.')
    const [entry]=await query(`UPDATE erp_personnel_entries SET status=$3,reviewed_by=$4,reviewed_at=now()
      WHERE id=$1 AND workspace_id=$2 AND status='pending' RETURNING id`,[id(key),workspace,body.status,account.id])
    if(!entry) throw fail(409,'Staff entry is unavailable or has already been reviewed.')
    return entry
  }
  throw fail(404,'Accounting record not found.')
}

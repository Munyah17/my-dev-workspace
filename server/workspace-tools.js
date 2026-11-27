import { sealProviderKey } from './provider-secrets.js'
import { checkDeveloperConnection,dispatchStack,developerStatus,hostingResources,sentryIssues,stripeCollections,providerSecretName,promptProviders,runDeveloperModel,validateProviderScope } from './developer-providers.js'
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
  Codex:['chatgpt.com'],
  ChatGPT:['chatgpt.com'],
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
    const connectionSql=`SELECT c.*,s.ciphertext FROM developer_connections c LEFT JOIN developer_connection_secrets s
      ON s.workspace_id=c.workspace_id AND s.provider=c.provider WHERE c.workspace_id=$1 AND c.provider=$2`
    if(resource==='connections'){
      const provider=key==='GitHub%20Actions'?'GitHub Actions':key
      if(method==='GET' && !key){
        const workspaces=await query('SELECT w.*,developer_workspace_owner(w.id) AS editable FROM maintenance_workspaces() w')
        const connections=(await query(`SELECT c.*,EXISTS(SELECT 1 FROM developer_connection_secrets s
          WHERE s.workspace_id=c.workspace_id AND s.provider=c.provider) AS credential_stored
          FROM developer_connections c ORDER BY provider`)).map(connection=>({
          ...connection,environmentKey:providerSecretName(connection),
        }))
        return {workspaces,connections}
      }
      if(method==='POST' && !key){
        const workspace=text(body.workspace,120)
        if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed)
          throw fail(404,'Workspace not found.')
        const scope=body.provider==='Cursor'?'Cloud Agents':text(body.scope,180)
        const secretRef=body.apiKey?'PRIMARY':body.secretRef
        if(!validateProviderScope(body.provider,scope) || !/^[A-Z][A-Z0-9_]{0,40}$/.test(secretRef??''))
          throw fail(400,'Choose a provider, resource identifier, and valid server credential reference.')
        const [connection]=await query(`INSERT INTO developer_connections(workspace_id,provider,secret_ref,external_scope)
          VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,provider) DO UPDATE SET secret_ref=excluded.secret_ref,
          external_scope=excluded.external_scope,checked_at=NULL,verified_details=NULL RETURNING *`,[workspace,body.provider,secretRef,scope])
        if(body.apiKey){
          const sealed=sealProviderKey(connection,body.apiKey)
          await query(`INSERT INTO developer_connection_secrets VALUES($1,$2,$3)
            ON CONFLICT(workspace_id,provider) DO UPDATE SET ciphertext=excluded.ciphertext`,[workspace,body.provider,sealed])
        }else await query('DELETE FROM developer_connection_secrets WHERE workspace_id=$1 AND provider=$2',[workspace,body.provider])
        return {environmentKey:providerSecretName(connection),credentialStored:Boolean(body.apiKey)}
      }
      if(method==='POST' && key && operation==='check'){
        const [connection]=await query(connectionSql+' FOR UPDATE OF c',[text(body.workspace,120),provider])
        if(!connection || !(await query('SELECT developer_workspace_owner($1) AS allowed',[connection.workspace_id]))[0].allowed) throw fail(404,'Connection not found.')
        const details=await checkDeveloperConnection(connection)
        await query('UPDATE developer_connections SET checked_at=now(),verified_details=$3 WHERE workspace_id=$1 AND provider=$2',[connection.workspace_id,provider,details])
        return {checked:true}
      }
      if(method==='POST' && key && operation==='disconnect'){
        const workspace=text(body.workspace,120)
        if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed) throw fail(404,'Connection not found.')
        await query('DELETE FROM developer_connections WHERE workspace_id=$1 AND provider=$2',[workspace,provider])
        return {saved:true}
      }
    }
    if(resource==='stack-deploy' && !key && !operation){
      const workspace=text(body?.workspace??search.get('workspace'),120)
      if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed)
        throw fail(404,'Workspace not found.')
      if(method==='GET') return query(`SELECT request_id,scope,revision,state,created_at FROM stack_dispatches
        WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20`,[workspace])
      if(method==='POST'){
        const revision=body.revision
        if(typeof revision!=='string' || !/^[0-9a-f]{40}$/.test(revision)) throw fail(400,'Enter a full Git commit SHA.')
        const requestId=id(body.requestId)
        const [connection]=await query(connectionSql+" AND c.checked_at IS NOT NULL FOR SHARE OF c",[workspace,'GitHub Actions'])
        if(!connection || connection.external_scope!==body.scope) throw fail(409,'Verify the GitHub Actions release target and try again.')
        const [created]=await query(`INSERT INTO stack_dispatches(workspace_id,request_id,scope,revision,requested_by,state)
          VALUES($1,$2,$3,$4,$5,'uncertain') ON CONFLICT(workspace_id,scope,revision) DO NOTHING RETURNING request_id`,
        [workspace,requestId,connection.external_scope,revision,account.id])
        if(!created){
          const [existing]=await query('SELECT state FROM stack_dispatches WHERE workspace_id=$1 AND scope=$2 AND revision=$3',
            [workspace,connection.external_scope,revision])
          return existing
        }
        // The intent commits before dispatch. An interrupted or ambiguous send is never retried automatically.
        return async scopedAction=>{
          const state=await dispatchStack(connection,revision,requestId)
          await scopedAction(tx=>tx.query('UPDATE stack_dispatches SET state=$3 WHERE workspace_id=$1 AND request_id=$2',[workspace,requestId,state]))
          return {state}
        }
      }
    }
    if(['collections','hosting','sentry'].includes(resource)){
      const workspace=text(body?.workspace??search.get('workspace'),120)
      if(!(await query('SELECT developer_workspace_owner($1) AS allowed',[workspace]))[0].allowed)
        throw fail(404,'Workspace not found.')
      const verified=async provider=>{
        const [connection]=await query('SELECT c.*,s.ciphertext FROM developer_connections c LEFT JOIN developer_connection_secrets s ON s.workspace_id=c.workspace_id AND s.provider=c.provider WHERE c.workspace_id=$1 AND c.provider=$2 AND c.checked_at IS NOT NULL FOR SHARE OF c',[workspace,provider])
        return connection
      }
      if(resource==='hosting' && method==='GET' && !operation && ['WHM','cPanel'].includes(key)){
        const connection=await verified(key)
        if(!connection) throw fail(409,'Test the hosting connection in Workspace settings first.')
        return hostingResources(connection)
      }
      if(resource==='sentry' && !operation){
        const connection=await verified('Sentry')
        if(!connection) throw fail(409,'Test the Sentry connection in Workspace settings first.')
        if(method==='GET' && !key) return sentryIssues(connection)
        if(method==='POST' && key && /^\d{1,32}$/.test(key)){
          await query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[workspace,'sentry:'+connection.external_scope+':'+key])
          const [existing]=await query('SELECT task_id AS id FROM sentry_tasks WHERE workspace_id=$1 AND external_scope=$2 AND issue_id=$3',[workspace,connection.external_scope,key])
          if(existing) return existing
          const issue=(await sentryIssues(connection)).find(issue=>issue.id===key)
          if(!issue) throw fail(404,'Issue is no longer in the current Sentry list.')
          const [task]=await query('INSERT INTO maintenance_tasks(workspace_id,title,assigned_to,created_by) VALUES($1,$2,$3,$3) RETURNING id',[
            workspace,('Sentry '+issue.key+' · '+issue.title).slice(0,160),account.id,
          ])
          await query('INSERT INTO sentry_tasks VALUES ($1,$2,$3,$4)',[workspace,connection.external_scope,key,task.id])
          return task
        }
      }
      if(resource==='collections' && !operation){
        if(method==='POST' && key==='paynow'){
          const reference=text(body.reference,120)
          const values=[workspace,reference,date(body.date),currency(body.currency),integer(body.gross,1,1000000000000),integer(body.refund??0,0,body.gross),text(body.app,120,false)]
          if(!['USD','ZWG','ZWL','ZAR'].includes(values[3])) throw fail(400,'Choose a supported Paynow currency.')
          const [inserted]=await query('INSERT INTO paynow_collections VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING reference',[...values,account.id])
          if(!inserted){
            const [same]=await query('SELECT reference FROM paynow_collections WHERE workspace_id=$1 AND reference=$2 AND received_on=$3 AND currency=$4 AND gross=$5 AND refund=$6 AND app=$7',values)
            if(!same) throw fail(409,'That Paynow reference already has different details.')
          }
          return {reference}
        }
        if(method==='GET' && !key){
          const start=date(search.get('start')),end=date(search.get('end'))
          const span=Date.parse(end)-Date.parse(start)
          if(span<0 || span>366*86400000) throw fail(400,'Choose a date range of up to one year.')
          const app=text(search.get('app'),120,false)
          const filter=search.get('provider')??'all'
          if(!['all','stripe','paynow'].includes(filter)) throw fail(400,'Choose a collections provider.')
          const stripe=filter==='paynow'?null:await verified('Stripe')
          const stripeReport=stripe?await stripeCollections(stripe,Date.parse(start)/1000,Date.parse(end)/1000+86400,app):null
          const paynowGroups=filter==='stripe'?[]:await query(`SELECT app,lower(currency) AS currency,sum(gross) AS gross,sum(refund) AS refund
            FROM paynow_collections WHERE workspace_id=$1 AND received_on BETWEEN $2 AND $3 AND ($4='' OR app=$4) GROUP BY app,currency`,[workspace,start,end,app])
          const paynow=new Map()
          const byApp=new Map()
          const add=(totals,key,group,properties)=>{
            const gross=Number(group.gross)+(totals.get(key)?.gross??0)
            const refund=Number(group.refund)+(totals.get(key)?.refund??0)
            if(!Number.isSafeInteger(gross) || !Number.isSafeInteger(refund)) throw fail(422,'Collection totals exceed supported precision.')
            totals.set(key,{...properties,gross,refund})
          }
          for(const group of paynowGroups) add(paynow,group.currency,group,{currency:group.currency})
          for(const {app,currency,gross,refund} of [...(stripeReport?.byApp??[]),...paynowGroups])
            add(byApp,JSON.stringify([app,currency]),{gross,refund},{app,currency})
          return {stripe:stripeReport?.totals??null,paynow:[...paynow.values()],byApp:[...byApp.values()]
            .sort((a,b)=>a.app.localeCompare(b.app)||a.currency.localeCompare(b.currency))}
        }
      }
      throw fail(404,'Integration operation not found.')
    }
    if(resource==='runs'){
      if(method==='GET' && !key) return query(`SELECT r.*,t.title AS task_title FROM developer_model_runs r
        JOIN maintenance_tasks t ON t.id=r.task_id ORDER BY r.created_at DESC LIMIT 40`)
      if(method==='POST' && !key){
        const [task]=await query('SELECT id,workspace_id,title FROM maintenance_tasks WHERE id=$1',[id(body.task)])
        if(!task) throw fail(404,'Task not found.')
        const provider=body.provider ?? 'Claude'
        if(!promptProviders.includes(provider)) throw fail(400,'Choose a model provider.')
        const [connection]=await query(connectionSql+' AND c.checked_at IS NOT NULL',[task.workspace_id,provider])
        if(!connection) throw fail(409,'Configure and test '+provider+' for this task’s workspace first.')
        const prompt=text(body.prompt,4000)
        const response=await runDeveloperModel(connection,'Task: '+task.title+'\n\n'+prompt)
        return (await query('INSERT INTO developer_model_runs(task_id,actor_id,model,prompt,response,provider) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[
          task.id,account.id,connection.external_scope,prompt,response,provider,
        ]))[0]
      }
    }
    if(resource==='links' && key && operation==='status' && method==='GET'){
      const [link]=await query('SELECT l.*,t.workspace_id FROM developer_work_links l JOIN maintenance_tasks t ON t.id=l.task_id WHERE l.id=$1',[id(key)])
      if(!link || !['Devin','Cursor'].includes(link.provider)) throw fail(404,'Remote agent link not found.')
      const [connection]=await query(connectionSql+' AND c.checked_at IS NOT NULL',[link.workspace_id,link.provider])
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

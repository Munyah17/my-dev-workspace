import { integer,text } from './billing.js'

const fail=(status,message)=>Object.assign(new Error(message),{status})
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export async function vpsRoute(tx,{method,pathname,body,search}){
  const query=async(sql,args)=>(await tx.query(sql,args)).rows
  const [ready]=await query("SELECT to_regclass('workspace_private.vps_wallets') IS NOT NULL AS ready")
  if(!ready.ready) throw fail(503,'VPS wallet setup is pending.')
  const rate=Number(process.env.VPS_BASE_HOURLY_MICRO_USD)
  const enabled=process.env.VPS_PROVISIONING_ENABLED==='true' && Number.isSafeInteger(rate) && rate>=1 && rate<=1000000000
  const permitted=workspace=>enabled && (process.env.VPS_ENABLED_WORKSPACES??'').split(',').includes(workspace)
  const [, , , operation]=pathname.split('/')
  if(method==='GET' && !operation){
    const workspaces=await query('SELECT * FROM maintenance_workspaces() w WHERE developer_workspace_owner(w.id)')
    const workspace=search.get('workspace')||workspaces[0]?.id
    if(!workspaces.some(item=>item.id===workspace)) throw fail(404,'VPS workspace not found.')
    const [wallet]=await query('SELECT available FROM vps_wallets WHERE workspace_id=$1',[workspace])
    const rentals=await query('SELECT id,label,state,minutes,base_rate,reserved,host,started_at,ends_at,charged FROM vps_rentals WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50',[workspace])
    const ledger=await query('SELECT id,kind,amount,created_at FROM vps_ledger WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50',[workspace])
    return {workspaces,workspace,balance:wallet?.available??0,rentals,ledger,enabled:permitted(workspace),rate:permitted(workspace)?rate:null}
  }
  if(method==='POST' && operation==='credit'){
    const [result]=await query('SELECT vps_credit($1,$2,$3) AS ok',[text(body.workspace,120),text(body.reference,120),integer(body.amount,1,10000000)])
    if(!result.ok) throw fail(409,'Check platform access, workspace, and settlement reference.')
    return {saved:true}
  }
  if(method==='POST' && ['reserve','end'].includes(operation)){
    if(!uuid.test(body.id??'')) throw fail(400,'Invalid VPS request ID.')
    if(operation==='reserve'){
      if(!permitted(body.workspace)) throw fail(503,'VPS provisioning is unconfigured.')
      const sshKey=text(body.sshKey,120)
      if(!/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/.test(sshKey))
        throw fail(400,'Enter an Ed25519 SSH public key without its trailing comment.')
      const [result]=await query('SELECT vps_reserve($1,$2,$3,$4,$5,$6) AS ok',[text(body.workspace,120),body.id,text(body.label,100),sshKey,integer(body.minutes,15,1440),rate])
      if(!result.ok) throw fail(409,'Check access, wallet funds, request details, and whether this workspace already has a rental.')
    }else{
      const [result]=await query('SELECT vps_end($1) AS ok',[body.id])
      if(!result.ok) throw fail(409,'This VPS cannot be ended in its current state.')
    }
    return {saved:true}
  }
  throw fail(404,'VPS operation not found.')
}

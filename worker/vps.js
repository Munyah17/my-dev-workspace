import { setTimeout as sleep } from 'node:timers/promises'
import { openDatabase,scopedTransaction } from '../server/database.js'

function flyClient(app,token){
  return async(path='',method='GET',body)=>{
    const response=await fetch('https://api.machines.dev/v1/apps/'+app+'/machines'+path,{
      method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000),redirect:'error',
    })
    if(method==='DELETE' && response.status===404) return
    if(!response.ok) throw Error('Fly API HTTP '+response.status)
    if(method!=='DELETE') return response.json()
  }
}

async function processRental(db,workspace,target,image,region){
  const fly=flyClient(target.app,target.token)
  const job=await scopedTransaction(db,async tx=>{
    const {rows:[row]}=await tx.query(`SELECT * FROM vps_rentals WHERE workspace_id=$1
      AND (state IN ('queued','ending') OR (state='running' AND ends_at<=now())
        OR (state='provisioning' AND started_at<now()-interval '1 minute'))
      ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[workspace])
    if(!row) return null
    if(row.state==='queued'){
      await tx.query("UPDATE vps_rentals SET state='provisioning',started_at=now(),ends_at=now()+minutes*interval '1 minute' WHERE id=$1",[row.id])
      return {...row,create:true}
    }
    await tx.query("UPDATE vps_rentals SET state='ending' WHERE id=$1",[row.id])
    return row
  })
  if(!job) return
  const name='mydev-'+job.id
  if(job.create){
    // A create is sent only once. The next pass reconciles ambiguous responses by name.
    const machine=await fly('','POST',{name,region,config:{
      image,auto_destroy:true,restart:{policy:'no'},guest:{cpu_kind:'shared',cpus:1,memory_mb:256},
      env:{VPS_SSH_PUBLIC_KEY:job.ssh_key,VPS_LIFETIME_SECONDS:String(job.minutes*60)},
      services:[{protocol:'tcp',internal_port:22,ports:[{port:22}]}],
    }})
    if(!/^[a-z0-9]+$/.test(machine.id)) throw Error('Invalid Fly Machine identity')
    await scopedTransaction(db,tx=>tx.query("UPDATE vps_rentals SET state='running',provider_id=$2,host=$3 WHERE id=$1 AND state='provisioning'",[job.id,machine.id,target.host]))
    return
  }
  const ids=job.provider_id?[job.provider_id]:(await fly())
    .filter(machine=>machine.name===name && /^[a-z0-9]+$/.test(machine.id)).map(machine=>machine.id)
  for(const id of ids) await fly('/'+id+'?force=true','DELETE')
  await scopedTransaction(db,async tx=>{
    const {rows:[row]}=await tx.query("SELECT * FROM vps_rentals WHERE id=$1 AND state='ending' FOR UPDATE",[job.id])
    if(!row) return
    // If provisioning was uncertain, retain the reservation for review.
    if(row.started_at && !row.provider_id){
      await tx.query("UPDATE vps_rentals SET state='needs_review' WHERE id=$1",[job.id])
      return
    }
    const elapsed=row.started_at?Math.min(row.minutes,Math.ceil((Date.now()-new Date(row.started_at))/60000)):0
    const charged=Math.min(Number(row.reserved),Math.ceil(elapsed*row.base_rate*130/60000000))
    const refund=Number(row.reserved)-charged
    if(refund>0){
      await tx.query("INSERT INTO vps_ledger(workspace_id,kind,reference,amount) VALUES($1,'refund',$2,$3)",[workspace,job.id,refund])
      await tx.query('UPDATE vps_wallets SET available=available+$2 WHERE workspace_id=$1',[workspace,refund])
    }
    await tx.query("UPDATE vps_rentals SET state='ended',charged=$2 WHERE id=$1",[job.id,charged])
  })
}

export async function vpsLane(url,stop){
  if(!url) return
  const targets=JSON.parse(process.env.VPS_FLY_TARGETS??'{}')
  const image=process.env.VPS_GUEST_IMAGE
  const region=process.env.VPS_FLY_REGION
  if(!image || !region || !Object.values(targets).every(target=>/^[a-z0-9-]+$/.test(target.app) && target.token && /^[a-z0-9.-]+$/i.test(target.host)))
    throw Error('Configure approved VPS guest image, region and isolated workspace targets.')
  const db=await openDatabase({url})
  try {
    while(!stop.aborted){
      for(const [workspace,target] of Object.entries(targets)){
        try{await processRental(db,workspace,target,image,region)}
        catch(error){console.error('VPS worker retry:',error.code??error.name)}
      }
      await sleep(5000,undefined,{signal:stop}).catch(()=>{})
    }
  } finally{await db.close()}
}

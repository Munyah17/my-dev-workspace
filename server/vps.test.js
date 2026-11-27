import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { vpsRoute } from './vps.js'
import { initialize } from './api.js'
import { openDatabase,scopedTransaction } from './database.js'

test('only settled credits fund a workspace and reservations cannot double-spend',async()=>{
  const db=await openDatabase()
  const config={VPS_BASE_HOURLY_MICRO_USD:'100000',VPS_RETAIL_HOURLY_MICRO_USD:'130000',VPS_PROVISIONING_ENABLED:'true',VPS_ENABLED_WORKSPACES:'demo'}
  const previous=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]))
  Object.assign(process.env,config)
  try{
    await initialize(db,true)
    const asActor=(actor,run)=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor',$1,true)",[actor])
      return run(tx)
    })
    const request=(actor,sql,args)=>asActor(actor,async tx=>(await tx.query(sql,args)).rows)
    const api=(pathname,body)=>asActor('agency',tx=>vpsRoute(tx,{method:body?'POST':'GET',pathname,body,search:new URLSearchParams()}))
    const credit='SELECT vps_credit($1,$2,$3) AS ok'
    const reserve='SELECT vps_reserve($1,$2,$3,$4,$5,$6) AS ok'
    const args=['demo',randomUUID(),'Pilot','ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI'+'A'.repeat(43),60,100000]
    assert.deepEqual(await request('agency',reserve,args),[{ok:false}])
    assert.deepEqual(await request('agency',credit,['demo','payment-1',13]),[{ok:false}])
    await scopedTransaction(db,tx=>tx.query("INSERT INTO platform_administrators(account_id) VALUES('agency')"))
    assert.deepEqual(await request('agency',credit,['demo','payment-1',13]),[{ok:true}])
    assert.deepEqual(await request('agency',credit,['demo','payment-1',13]),[{ok:true}])
    assert.deepEqual(await request('agency',credit,['demo','payment-1',99]),[{ok:false}])
    assert.deepEqual(await request('gents',reserve,args),[{ok:false}])
    const payload={workspace:'demo',id:args[1],label:args[2],sshKey:args[3],minutes:60,hourlyPriceMicros:130000}
    await assert.rejects(api('/api/vps/reserve',{...payload,hourlyPriceMicros:129999}),{status:409})
    process.env.VPS_RETAIL_HOURLY_MICRO_USD='120000'
    await assert.rejects(api('/api/vps/reserve',{...payload,hourlyPriceMicros:120000}),{status:503})
    process.env.VPS_RETAIL_HOURLY_MICRO_USD=config.VPS_RETAIL_HOURLY_MICRO_USD
    assert.deepEqual(await api('/api/vps/reserve',payload),{saved:true})
    const view=await api('/api/vps')
    assert.equal(view.hourlyPriceMicros,130000)
    assert.equal(view.rate,undefined)
    assert.equal(view.rentals[0].base_rate,undefined)
    assert.deepEqual(await request('agency',reserve,args),[{ok:true}])
    assert.deepEqual(await request('agency','SELECT available::int FROM vps_wallets'),[{available:0}])
    assert.deepEqual(await request('gents','SELECT * FROM vps_rentals'),[])
    assert.deepEqual(await request('gents','SELECT vps_end($1) AS ok',[args[1]]),[{ok:false}])
    assert.deepEqual(await request('agency','SELECT vps_end($1) AS ok',[args[1]]),[{ok:true}])
  }finally{
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined) delete process.env[key]
      else process.env[key]=value
    }
    await db.close()
  }
})

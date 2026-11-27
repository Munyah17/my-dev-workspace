import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { initialize } from './api.js'
import { openDatabase,scopedTransaction } from './database.js'

test('only settled credits fund a workspace and reservations cannot double-spend',async()=>{
  const db=await openDatabase()
  try{
    await initialize(db,true)
    const request=(actor,sql,args)=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor',$1,true)",[actor])
      return (await tx.query(sql,args)).rows
    })
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
    assert.deepEqual(await request('agency',reserve,args),[{ok:true}])
    assert.deepEqual(await request('agency',reserve,args),[{ok:true}])
    assert.deepEqual(await request('agency','SELECT available::int FROM vps_wallets'),[{available:0}])
    assert.deepEqual(await request('gents','SELECT * FROM vps_rentals'),[])
    assert.deepEqual(await request('gents','SELECT vps_end($1) AS ok',[args[1]]),[{ok:false}])
    assert.deepEqual(await request('agency','SELECT vps_end($1) AS ok',[args[1]]),[{ok:true}])
  }finally{await db.close()}
})

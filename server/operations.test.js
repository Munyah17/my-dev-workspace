import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { initialize } from './api.js'
import { billingRoute } from './billing.js'
import { operationsRoute } from './operations.js'
import { openDatabase,scopedTransaction } from './database.js'

test('one accepted quote yields one order and a serialized unit has one allocation',async()=>{
  const db=await openDatabase()
  try {
    await initialize(db,true)
    const call=(area,path,body,actor='agency')=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor',$1,true)",[actor])
      const url=new URL('/api/'+area+'/'+path,'https://example.test')
      return (area==='billing'?billingRoute:operationsRoute)(tx,{
        method:body?'POST':'GET',pathname:url.pathname,body,account:{ id:actor },search:url.searchParams,
      })
    })
    const billing=(path,body,actor)=>call('billing',path,body,actor)
    const ops=(path,body,actor)=>call('operations',path,body,actor)
    const future=new Date(Date.now()+86400000*10).toISOString().slice(0,10)
    const today=new Date().toISOString().slice(0,10)
    const workspace='demo'
    const quoteData={ workspace,organization:'gents',kind:'quote',currency:'USD',due:future,
      items:[{ description:'Tracker installation',quantity:1,unit:10000,tax:1000,discount:1000 }] }
    const accept=async input=>{
      const quote=await billing('documents',input)
      await billing('documents/'+quote.id+'/issue',{})
      await billing('documents/'+quote.id+'/decision',{ decision:'accepted' })
      return quote
    }
    const quote=await accept(quoteData)
    const original=await billing('documents/'+quote.id)
    const order=await ops('orders',{ quote:quote.id })
    assert.deepEqual(await ops('orders',{ quote:quote.id }),order)
    const path='orders/'+order.id
    const detail=await ops(path)
    const line=detail.lines[0]
    assert.equal(Number(detail.order.total_minor),Number(original.total_minor))
    for (const field of ['position','description','quantity','unit_minor','discount_minor','tax_bps','total_minor'])
      assert.equal(line[field],original.lines[0][field])
    const product=await ops('inventory',{ workspace,name:'AeroTrack GPS',sku:'GPS-01',category:'Trackers',unit:'each',
      currency:'USD',cost:5000,price:10000,reorder:1,serialized:true })
    const receipt={ workspace,request:randomUUID(),quantity:1,serials:['TRK-010'],supplier:'Tracker supplier',date:today,cost:5000 }
    const receive='inventory/'+product.id+'/receive'
    assert.deepEqual(await ops(receive,receipt),await ops(receive,receipt))
    await assert.rejects(ops(receive,{ ...receipt,request:randomUUID() }),{ status:409 })
    const unit=(await ops('inventory/'+product.id)).units[0]
    await ops(path+'/plan',{ line:line.id,kind:'product',product:product.id })
    await ops(path+'/state',{ state:'Confirmed' })
    await ops(path+'/reserve',{ line:line.id,unit:unit.id })
    const reserved=(await ops('inventory'))[0]
    assert.deepEqual([reserved.on_hand,reserved.reserved,reserved.available],[1,1,0])
    const rival=await accept({ ...quoteData,organization:'harbor' })
    const second=await ops('orders',{ quote:rival.id })
    const secondPath='orders/'+second.id
    const secondLine=(await ops(secondPath)).lines[0]
    await ops(secondPath+'/plan',{ line:secondLine.id,kind:'product',product:product.id })
    await ops(secondPath+'/state',{ state:'Confirmed' })
    await assert.rejects(ops(secondPath+'/reserve',{ line:secondLine.id,unit:unit.id }),{ status:409 })
    await ops(path+'/allocate',{ line:line.id,unit:unit.id })
    await ops(path+'/allocate',{ line:line.id,unit:unit.id })
    assert.equal((await ops(path)).order.state,'Fulfilled')
    assert.equal((await ops(path)).units[0].serial,'TRK-010')
    const inventory=await ops('inventory/'+product.id)
    assert.deepEqual(inventory.movements.map(item=>item.action).sort(),['allocation','purchase','reservation'])
    assert.equal((await ops('inventory'))[0].on_hand,0)

    const serviceQ=await accept({ ...quoteData,items:[{ description:'Maintenance',quantity:1,unit:3500 }] })
    const service=await ops('orders',{ quote:serviceQ.id })
    const servicePath='orders/'+service.id
    const serviceLine=(await ops(servicePath)).lines[0]
    await ops(servicePath+'/plan',{ line:serviceLine.id,kind:'service' })
    await ops(servicePath+'/state',{ state:'Confirmed' })
    await ops(servicePath+'/complete-service',{ line:serviceLine.id })
    assert.equal((await ops(servicePath)).order.state,'Fulfilled')
    assert.equal((await ops('inventory/'+product.id)).movements.length,3)

    await assert.rejects(ops(path,undefined,'gents'),{ status:404 })
    await ops(path+'/details',{ notes:'Staff only note',assignee:'agency',shared:true })
    const shared=await ops(path,undefined,'gents')
    assert.equal(shared.order.state,'Fulfilled')
    assert.equal(shared.details,undefined)
    assert.equal(shared.units,undefined)
    await assert.rejects(ops(path,undefined,'other'),{ status:404 })
    await assert.rejects(ops('inventory',undefined,'gents'),{ status:404 })
    const invoice=await billing('documents/'+quote.id+'/convert',{ due:future })
    await billing('documents/'+invoice.id+'/issue',{})
    await billing('documents/'+invoice.id+'/payment',{ request:randomUUID(),amount:3500,currency:'USD',date:today,method:'Transfer' })
    const usdExpense={ workspace,request:randomUUID(),supplier:'Tracker supplier',category:'Hardware',currency:'USD',
      amount:5000,date:today,paid:true,method:'Transfer',project:'gents-staff',receipt:{ name:'test.txt',content:'dGVzdA==' } }
    const expense=await ops('expenses',usdExpense)
    assert.deepEqual(await ops('expenses',usdExpense),expense)
    assert.equal((await ops('expenses?project=gents-staff'))[0].project,'The Gents Staff Portal')
    assert.equal((await ops('expenses/'+expense.id+'/receipt')).file.content,'dGVzdA==')
    await assert.rejects(ops('expenses/'+expense.id+'/receipt',undefined,'gents'),{ status:404 })
    await ops('expenses',{ ...usdExpense,request:randomUUID(),currency:'EUR',amount:2000,paid:false })
    const report=await ops('report')
    const usd=report.find(row=>row.currency==='USD')
    const eur=report.find(row=>row.currency==='EUR')
    assert.equal(Number(usd.invoiced),9900)
    assert.equal(Number(usd.received),3500)
    assert.equal(Number(usd.receivables),6400)
    assert.equal(Number(usd.net_cash),-1500)
    assert.equal(Number(eur.expenses),2000)
    assert.equal(Number(eur.net_cash),0)
  } finally {
    await db.close()
  }
})

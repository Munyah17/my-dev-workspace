import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { initialize } from './api.js'
import { openDatabase,scopedTransaction } from './database.js'
import { billingRoute } from './billing.js'

test('billing preserves issued lines, isolates clients, and records cash and reminders exactly once', async()=>{
  const db=await openDatabase()
  try {
    await initialize(db,true)
    const request=(path,body,who='agency')=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor',$1,true)",[who])
      const url=new URL('/api/billing/'+path,'https://example.test')
      return billingRoute(tx,{ method:body?'POST':'GET',pathname:url.pathname,body,account:{ id:who },search:url.searchParams })
    })
    const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10)
    const workspace='demo'
    const client=await request('clients',{ workspace,name:'Pilot client',notes:'Private CRM note' })
    await request('clients/'+client.id+'/contact',{ workspace,name:'Billing contact',email:'billing@example.test' })
    assert.equal((await request('clients/'+client.id)).contacts.length,1)
    await assert.rejects(request('clients/'+client.id,undefined,'gents'),{ status:404 })
    const draft={ workspace,organization:'gents',kind:'quote',currency:'USD',due:day(30),address:'Office 4\nMain Street',details:{scope:'Configure hosting\nVerify backups',purchaseOrder:'PO-14'},items:[{
      description:'Hosting\nDaily backups',unitLabel:'month',quantity:2,unit:5000,discount:1000,tax:1000,
    }] }
    const longDraft=await request('documents',{...draft,items:Array.from({length:100},()=>draft.items[0])})
    assert.equal((await request('documents/'+longDraft.id)).lines.length,100)
    await request('documents/'+longDraft.id+'/edit',{...draft,details:{terms:'Updated draft terms'}})
    assert.deepEqual((await request('documents/'+longDraft.id)).document_details,{terms:'Updated draft terms'})
    const quote=await request('documents',draft)
    await assert.rejects(request('documents/'+quote.id,undefined,'gents'),{ status:404 })
    await request('documents/'+quote.id+'/issue',{})
    await assert.rejects(request('documents/'+quote.id,undefined,'other'),{ status:404 })
    assert.equal(Number((await request('documents/'+quote.id,undefined,'gents')).total_minor),9900)
    await request('documents/'+quote.id+'/decision',{ decision:'accepted' },'gents')
    await assert.rejects(request('documents/'+quote.id+'/edit',draft),{ status:409 })
    const invoice=await request('documents/'+quote.id+'/convert',{ due:day(15) })
    assert.deepEqual(await request('documents/'+quote.id+'/convert',{ due:day(20) }),invoice)
    const original=await request('documents/'+quote.id)
    const copied=await request('documents/'+invoice.id)
    assert.deepEqual(copied.document_details,draft.details)
    assert.equal(copied.recipient_address,draft.address)
    assert.equal(copied.lines[0].unit_label,'month')
    assert.equal(copied.lines[0].description,draft.items[0].description)
    assert.deepEqual(copied.lines.map(({document_id:_documentId,...line})=>line),original.lines.map(({document_id:_documentId,...line})=>line))
    await request('documents/'+invoice.id+'/issue',{})
    const payment={ request:randomUUID(),amount:4000,currency:'USD',date:day(0),method:'Transfer',notes:'Private money note' }
    const first=await request('documents/'+invoice.id+'/payment',payment)
    assert.deepEqual(await request('documents/'+invoice.id+'/payment',payment),first)
    assert.equal((await request('documents/'+invoice.id)).status,'partially paid')
    assert.equal((await request('documents/'+invoice.id)).balance,5900)
    await assert.rejects(request('documents/'+invoice.id+'/payment',{ ...payment,amount:6500,request:randomUUID() }),{ status:409 })
    const renewal=await request('services',{ workspace,organization:'gents',name:'Domain',kind:'domain',currency:'USD',amount:1000,interval:12,due:day(10),reminder:7 })
    const devin=await request('services',{ workspace,name:'Devin',kind:'supplier',currency:'USD',amount:2000,interval:1,due:day(7),reminder:7 })
    await request('documents/'+invoice.id+'/payment',{ ...payment,amount:5900,request:randomUUID() })
    const visible=await request('documents/'+invoice.id,undefined,'gents')
    assert.equal(visible.status,'paid')
    assert.equal(visible.balance,0)
    assert.deepEqual(visible.payments,[])
    await assert.rejects(request('documents/'+invoice.id,undefined,'other'),{ status:404 })
    assert.equal((await request('services')).find(service=>service.id===renewal.id).confirmed_at,null)
    const trigger=(await request('services')).find(service=>service.id===devin.id).reminder_at
    assert.ok(trigger)
    assert.deepEqual((await request('services')).find(service=>service.id===devin.id).reminder_at,trigger)
    assert.deepEqual(await request('services',undefined,'gents'),[])
    const eur=await request('documents',{ ...draft,kind:'invoice',currency:'EUR' })
    await request('documents/'+eur.id+'/issue',{})
    assert.deepEqual((await request('summary')).totals,{
      USD:{ invoiced:9900,cash:9900,balance:0 },EUR:{ invoiced:9900,cash:0,balance:9900 },
    })
  } finally {
    await db.close()
  }
})

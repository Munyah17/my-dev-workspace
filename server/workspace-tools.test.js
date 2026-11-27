import assert from 'node:assert/strict'
import test from 'node:test'
import { initialize } from './api.js'
import { openDatabase,scopedTransaction } from './database.js'
import { workspaceToolsRoute } from './workspace-tools.js'
import { maintenanceRoute } from './maintenance.js'
import { billingRoute } from './billing.js'

test('workspace tools preserve document totals, payroll scope, provider boundaries and separate platform grants',async()=>{
  const db=await openDatabase()
  const providerKey='MYDEV_64656D6F_ANTHROPIC_PRIMARY'
  const previous=process.env[providerKey]
  const realFetch=globalThis.fetch
  try{
    await initialize(db,true)
    const call=(area,path,body,who='agency')=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor',$1,true)",[who])
      const url=new URL('/api/'+area+'/'+path,'https://example.test')
      return ({maintenance:maintenanceRoute,billing:billingRoute}[area]??workspaceToolsRoute)(tx,{
        method:body?'POST':'GET',pathname:url.pathname,body,account:{id:who,agency:who==='agency'},search:url.searchParams,
      })
    })
    const workspace='demo',day='2026-11-27'
    const erp=(path,body,who)=>call('erp',path,body,who)
    const type=await erp('service-types',{workspace,name:'Vehicle tracking',direction:'collection',interval:1,reminder:7})
    const service=await call('billing','services',{workspace,organization:'gents',name:'AeroTrack',kind:'collection',currency:'USD',amount:1500,interval:1,due:day,reminder:7,serviceType:type.id})
    assert.equal((await call('billing','services')).find(item=>item.id===service.id).service_type,type.id)
    const document=await erp('documents',{workspace,kind:'boq',organization:'gents',title:'Installation quantities',date:day,currency:'USD',lines:[{description:'Trackers',unit:'each',quantity:2,unitMinor:3300}]})
    assert.equal(Number((await erp('documents/'+document.id)).total_minor),6600)
    await assert.rejects(erp('documents/'+document.id,undefined,'gents'),{status:404})
    const employee=await erp('staff',{workspace,name:'Test employee',email:'staff@example.test',job:'Engineer',start:day})
    const entry=await erp('staff/'+employee.id+'/entry',{workspace,kind:'bonus',start:day,end:day,description:'Pilot bonus',amount:5000,currency:'USD'})
    await erp('entries/'+entry.id+'/review',{workspace,status:'approved'})
    const payroll=await erp('staff/'+employee.id+'/payroll',{workspace,start:day,end:day,currency:'USD',base:25000,deductions:1000})
    assert.deepEqual(await erp('staff/'+employee.id+'/payroll',{workspace,start:day,end:day,currency:'USD',base:25000,deductions:1000}),payroll)
    assert.equal(Number((await erp('staff')).payroll[0].bonus_minor),5000)
    await assert.rejects(erp('staff',undefined,'gents'),{status:404})

    const task=await call('maintenance','tasks',{workspace,title:'Review project notes',assignee:'agency'})
    const tools=(path,body,who)=>call('developer-tools',path,body,who)
    await tools('connections',{workspace,provider:'Claude',secretRef:'PRIMARY',scope:'claude-sonnet-example'})
    await assert.rejects(tools('connections/Claude/check',{workspace}),{status:409})
    process.env[providerKey]='fixture-provider-token'
    globalThis.fetch=async(url,options)=>{
      assert.equal(new URL(url).hostname,'api.anthropic.com')
      assert.equal(options.headers['x-api-key'],'fixture-provider-token')
      return Response.json(options.method==='POST'?{content:[{type:'text',text:'Review completed.'}]}:{id:'claude-sonnet-example'})
    }
    await tools('connections/Claude/check',{workspace})
    await tools('runs',{task:task.id,prompt:'Summarize this task.'})
    assert.equal((await tools('runs'))[0].response,'Review completed.')
    await assert.rejects(tools('runs',undefined,'gents'),{status:404})
    await assert.rejects(tools('links',{task:task.id,provider:'Claude',title:'Invalid',url:'https://claude.ai.example.test/'}),{status:400})
    const link=await tools('links',{task:task.id,provider:'Cursor',title:'Review agent',url:'https://cursor.com/agents/bc-fixture'})
    assert.equal((await tools('links')).links[0].id,link.id)
    assert.deepEqual(await call('platform','access'),{allowed:false})
    await assert.rejects(call('platform','workspaces'),{status:404})
    await scopedTransaction(db,tx=>tx.query("INSERT INTO platform_administrators(account_id) VALUES('agency')"))
    assert.deepEqual(await call('platform','access'),{allowed:true})
    await call('platform','workspaces/demo',{plan:'agency',lifecycle:'active'})
    assert.equal((await call('platform','workspaces'))[0].plan,'agency')
    await assert.rejects(call('platform','workspaces',undefined,'other'),{status:404})
  }finally{
    globalThis.fetch=realFetch
    if(previous===undefined) delete process.env[providerKey]
    else process.env[providerKey]=previous
    await db.close()
  }
})

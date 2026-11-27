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
  const previousEncryptionKey=process.env.WORKSPACE_CREDENTIALS_KEY
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
    const extra=[
      ['Codex','codex-pilot','CODEX','api.openai.com','/v1/models/codex-pilot',{id:'codex-pilot'}],
      ['ChatGPT','gpt-pilot','OPENAI','api.openai.com','/v1/models/gpt-pilot',{id:'gpt-pilot'}],
      ['Vercel','prj_example/team_example','VERCEL','api.vercel.com','/v9/projects/prj_example?teamId=team_example',{id:'prj_example',name:'Vercel pilot'}],
      ['Supabase','projectref','SUPABASE','api.supabase.com','/v1/projects/projectref',{id:'projectref',name:'Supabase pilot'}],
      ['Cloudflare','zonefixture','CLOUDFLARE','api.cloudflare.com','/client/v4/zones/zonefixture',{success:true,result:{id:'zonefixture',name:'example.test'}}],
      ['Firebase','firebase-pilot','FIREBASE','firebase.googleapis.com','/v1beta1/projects/firebase-pilot',{projectId:'firebase-pilot'}],
      ['Netlify','netlify-pilot','NETLIFY','api.netlify.com','/api/v1/sites/netlify-pilot',{id:'netlify-pilot',name:'Netlify pilot'}],
    ]
    for (const [provider,scope,env,host,path,result] of extra){
      const secret='MYDEV_64656D6F_'+env+'_FIXTURE'
      const original=process.env[secret]
      process.env[secret]='fixture-token'
      try{
        globalThis.fetch=async(url,options)=>{
          const target=new URL(url)
          assert.equal(target.host,host)
          assert.equal(options.headers.Authorization,'Bearer fixture-token')
          if(options.method==='POST'){
            assert.equal(target.pathname,'/v1/responses')
            assert.equal(JSON.parse(options.body).store,false)
            return Response.json({output:[{content:[{type:'output_text',text:'Task response.'}]}]})
          }
          assert.equal(target.pathname+target.search,path)
          return Response.json(result)
        }
        await tools('connections',{workspace,provider,secretRef:'FIXTURE',scope})
        await tools('connections/'+provider+'/check',{workspace})
        const connection=(await tools('connections')).connections.find(item=>item.provider===provider)
        assert.ok(connection.verified_details.name)
        assert.equal(Object.values(connection).includes('fixture-token'),false)
        if(provider==='Codex'||provider==='ChatGPT'){
          await tools('runs',{task:task.id,provider,prompt:'Summarize this task.'})
          assert.ok((await tools('runs')).some(item=>item.provider===provider && item.response==='Task response.'))
        }
      }finally{ if(original===undefined) delete process.env[secret];else process.env[secret]=original }
    }
    process.env.WORKSPACE_CREDENTIALS_KEY='fixture-encryption-material-long-enough'
    const pastedKey='fixture-pasted-provider-token'
    const configuration={workspace,provider:'Cloudflare',scope:'zonefixture',apiKey:pastedKey}
    await assert.rejects(tools('connections',configuration,'gents'),{status:404})
    assert.equal((await tools('connections',configuration)).credentialStored,true)
    const saved=(await tools('connections')).connections.find(item=>item.provider==='Cloudflare')
    assert.equal(saved.credential_stored,true)
    assert.equal(saved.ciphertext,undefined)
    assert.equal(JSON.stringify(saved).includes(pastedKey),false)
    const {rows:[stored]}=await scopedTransaction(db,tx=>tx.query("SELECT ciphertext FROM developer_connection_secrets WHERE provider='Cloudflare'"))
    assert.ok(stored.ciphertext)
    assert.equal(stored.ciphertext.includes(pastedKey),false)
    globalThis.fetch=async(_url,options)=>{
      assert.equal(options.headers.Authorization,'Bearer '+pastedKey)
      return Response.json({success:true,result:{id:'zonefixture',name:'example.test'}})
    }
    await tools('connections/Cloudflare/check',{workspace})
    await tools('connections/Cloudflare/disconnect',{workspace})
    assert.equal((await scopedTransaction(db,tx=>tx.query('SELECT * FROM developer_connection_secrets'))).rows.length,0)
    const reportPath='collections?workspace=demo&start=2026-11-01&end=2026-11-30&app=AeroTrack'
    const paynow={workspace,reference:'fixture-payment',date:day,gross:2100,refund:100,currency:'USD',app:'AeroTrack'}
    await tools('collections/paynow',paynow)
    await tools('collections/paynow',paynow)
    await assert.rejects(tools('collections/paynow',{...paynow,gross:2200}),{status:409})
    await assert.rejects(tools(reportPath,undefined,'gents'),{status:404})
    const stripeKey='rk_live_fixture-collections'
    await tools('connections',{workspace,provider:'Stripe',scope:'acct_fixture',apiKey:stripeKey})
    globalThis.fetch=async(url,options)=>{
      assert.equal(options.headers.Authorization,'Bearer '+stripeKey)
      const path=new URL(url)
      if(path.pathname==='/v1/account') return Response.json({id:'acct_fixture'})
      const charge={id:'ch_1',status:'succeeded',paid:true,captured:true,currency:'usd',amount_captured:3500,amount_refunded:500,metadata:{app:'AeroTrack'}}
      return Response.json({data:path.searchParams.has('starting_after')?[{...charge,metadata:{app:'Other'}}]:[charge],
        has_more:path.searchParams.get('limit')==='100'&&!path.searchParams.has('starting_after')})
    }
    await tools('connections/Stripe/check',{workspace})
    const report=await tools(reportPath)
    assert.deepEqual(report.stripe,{usd:{gross:3500,refund:500}})
    assert.equal(Number(report.paynow[0].gross),2100)
    assert.deepEqual(report.byApp,[{app:'AeroTrack',currency:'usd',gross:5600,refund:600}])
    await tools('collections/paynow',{...paynow,reference:'fixture-untagged',currency:'ZWG',app:''})
    const all=await tools(reportPath.replace('&app=AeroTrack',''))
    assert.deepEqual(all.byApp,[
      {app:'',currency:'zwg',gross:2100,refund:100},
      {app:'AeroTrack',currency:'usd',gross:5600,refund:600},
      {app:'Other',currency:'usd',gross:3500,refund:500},
    ])
    const paynowOnly=await tools(reportPath+'&provider=paynow')
    assert.deepEqual(paynowOnly.byApp,[{app:'AeroTrack',currency:'usd',gross:2100,refund:100}])
    await tools('connections',{workspace,provider:'Sentry',scope:'fixture/project',apiKey:'fixture-sentry-token'})
    globalThis.fetch=async url=>{
      assert.equal(new URL(url).pathname,'/api/0/projects/fixture/project/issues/')
      return Response.json([{id:'12345',shortId:'PROJECT-1',title:'Persistence error'}])
    }
    await tools('connections/Sentry/check',{workspace})
    assert.equal((await tools('sentry?workspace=demo'))[0].id,'12345')
    const sentryTask=await tools('sentry/12345',{workspace})
    assert.deepEqual(await tools('sentry/12345',{workspace}),sentryTask)
    assert.equal((await call('maintenance','tasks/'+sentryTask.id)).title,'Sentry PROJECT-1 · Persistence error')
    const scope='fixture/site/main'
    await tools('connections',{workspace,provider:'GitHub Actions',scope,apiKey:'fixture-actions-token'})
    let sends=0
    const stackPath='/repos/fixture/site/actions/workflows/mydev-release.yml'
    const intent={workspace,scope,revision:'a'.repeat(40),requestId:'550e8400-e29b-41d4-a716-446655440000'}
    globalThis.fetch=async(url,options)=>{
      assert.equal(options.headers.Authorization,'Bearer fixture-actions-token')
      const path=new URL(url).pathname
      if(path===stackPath) return Response.json({state:'active'})
      if(path===stackPath+'/runs') return Response.json({workflow_runs:[
        {id:99,display_title:'Another release'},
        {id:42,display_title:'MyDev release '+intent.requestId,status:'completed',conclusion:'failure'},
      ]})
      if(path==='/repos/fixture/site/actions/runs/42/jobs') return Response.json({jobs:[
        {id:1,name:'Deploy Vercel',status:'completed',conclusion:'success'},
        {id:2,name:'Deploy Cloudflare Workers',status:'completed',conclusion:'failure'},
      ]})
      assert.equal(path,stackPath+'/dispatches')
      assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{revision:intent.revision,request_id:intent.requestId}})
      sends++
      return new Response(null,{status:204})
    }
    await tools('connections/GitHub Actions/check',{workspace})
    await assert.rejects(tools('stack-deploy',intent,'gents'),{status:404})
    await assert.rejects(tools('stack-deploy',{...intent,scope:'fixture/other/main'}),{status:409})
    const effect=await tools('stack-deploy',intent)
    assert.equal((await tools('stack-deploy?workspace=demo'))[0].state,'uncertain')
    assert.deepEqual(await tools('stack-deploy',intent),{state:'uncertain'})
    await effect(work=>scopedTransaction(db,async tx=>{
      await tx.exec('SET LOCAL ROLE workspace_app')
      await tx.query("SELECT set_config('workspace.actor','agency',true)")
      return work(tx)
    }))
    assert.deepEqual(await tools('stack-deploy',intent),{state:'accepted'})
    assert.equal(sends,1)
    const statusPath='stack-deploy/'+intent.requestId+'?workspace=demo'
    await assert.rejects(tools(statusPath,undefined,'gents'),{status:404})
    const status=await tools(statusPath)
    assert.equal(status.url,'https://github.com/fixture/site/actions/runs/42')
    assert.deepEqual(status.jobs.map(job=>job.conclusion),['success','failure'])
    await tools('connections',{workspace,provider:'Grok',scope:'grok-fixture',apiKey:'fixture-xai-token'})
    globalThis.fetch=async(url,options)=>{
      assert.equal(new URL(url).hostname,'api.x.ai')
      assert.equal(options.headers.Authorization,'Bearer fixture-xai-token')
      if(options.method==='GET'){
        assert.equal(new URL(url).pathname,'/v1/models')
        return Response.json({data:[{id:'grok-fixture'}]})
      }
      assert.equal(new URL(url).pathname,'/v1/chat/completions')
      assert.equal(JSON.parse(options.body).model,'grok-fixture')
      return Response.json({choices:[{message:{content:'xAI fixture response'}}]})
    }
    await tools('connections/Grok/check',{workspace})
    await tools('runs',{task:task.id,provider:'Grok',prompt:'Summarize this task.'})
    assert.ok((await tools('runs')).some(item=>item.provider==='Grok' && item.response==='xAI fixture response'))
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
    if(previousEncryptionKey===undefined) delete process.env.WORKSPACE_CREDENTIALS_KEY
    else process.env.WORKSPACE_CREDENTIALS_KEY=previousEncryptionKey
    globalThis.fetch=realFetch
    if(previous===undefined) delete process.env[providerKey]
    else process.env[providerKey]=previous
    await db.close()
  }
})

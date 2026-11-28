import assert from 'node:assert/strict'
import test from 'node:test'
import { initialize } from './api.js'
import { openDatabase, scopedTransaction } from './database.js'
import { maintenanceRoute } from './maintenance.js'
import { monitoringRoute } from './monitoring.js'

test('maintenance links tasks, fences job retries, and gates exact revision approval and release',async () => {
  const db = await openDatabase()
  try {
    await initialize(db,true)
    const as = (role,who,work) => scopedTransaction(db,async tx => {
      if (role) await tx.exec('SET LOCAL ROLE ' + role)
      if (who) await tx.query("SELECT set_config('workspace.actor',$1,true)",[who])
      return work(tx)
    })
    const owner = { id:'agency',agency:true }
    const client = { id:'gents',agency:false }
    const outsider = { id:'other',agency:false }
    const query = (sql,args) => as(null,null,async tx => (await tx.query(sql,args)).rows)
    const request = (path,body,account=owner) => as('workspace_app',account.id,tx =>
      maintenanceRoute(tx,{ method:body ? 'POST' : 'GET',pathname:'/api/maintenance/' + path,body,account }))
    const monitor = (path,body) => as('workspace_app',owner.id,tx =>
      monitoringRoute(tx,{ method:'POST',pathname:'/api/monitoring/' + path,body,account:owner }))
    const worker = (sql,args) => as('workspace_maintenance_worker',null,async tx => (await tx.query(sql,args)).rows[0])
    const claim = async () => (await worker('SELECT maintenance_claim() AS payload')).payload
    const finish = async (payload,result) => (await worker('SELECT maintenance_finish($1,$2,$3) AS completed',
      [payload.job.id,payload.job.lease,result])).completed
    const base = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    const [ticket] = await query("INSERT INTO tickets(project_id,author_id,subject) VALUES('gents-staff','gents','Barber disappears') RETURNING id")
    const [another] = await query("INSERT INTO tickets(project_id,author_id,subject) VALUES('gents-staff','gents','Same report') RETURNING id")
    const [wrong] = await query("INSERT INTO tickets(project_id,author_id,subject) VALUES('harbor-site','other','Another client') RETURNING id")
    const standalone = await request('tasks',{ workspace:'demo',assignee:'agency',title:'Renew this domain Friday',due:'2026-11-27' })
    assert.equal((await request('tasks/' + standalone.id)).project_id,null)
    assert.equal((await request('tasks/' + standalone.id)).tickets.length,0)
    const task = await request('tickets/' + ticket.id + '/assign',{ assignee:'agency',title:'Restore staff persistence' })
    await request('tickets/' + another.id + '/assign',{ existing:task.id })
    await assert.rejects(request('tickets/' + wrong.id + '/assign',{ existing:task.id }),{ status:404 })
    assert.equal((await request('tasks/' + task.id)).tickets.length,2)

    const workflow = await monitor('workflows',{ project:'gents-staff',name:'Staff',writes:true,
      steps:[{ action:'fresh',label:'Fresh session' },{ action:'assert',label:'Staff',selector:'#staff-list',value:'MyDev Test Barber' }] })
    const stagingMonitor = await monitor('monitors',{ project:'gents-staff',environment:'Staging',name:'Staff',
      kind:'workflow',url:'https://stage.example.test',workflow:workflow.id })
    const productionMonitor = await monitor('monitors',{ project:'gents-staff',environment:'Production',name:'Public page',
      kind:'availability',url:'https://live.example.test' })
    const connection = (provider,configuration,environment,project='gents-staff') =>
      request('connections',{ provider,project,environment,account:'pilot',secretRef:'PILOT',configuration })
    await connection('github',{ repository:'agency/gents',branch:'main',installation:'1234',paths:'index.php' })
    await connection('agent',{ model:'approved-model' })
    const cpanelConfig = { panel:'https://panel.example.test:2083',root:'/home/pilot/html',repositoryRoot:'/home/pilot/git',
      baseline:base,failureStep:'Staff',exclusions:'Uploaded media and runtime configuration' }
    await assert.rejects(connection('cpanel',{ ...cpanelConfig,site:'https://stage.example.test',monitor:stagingMonitor.id },'Staging','harbor-site'),{ status:400 })
    await connection('cpanel',{ ...cpanelConfig,site:'https://stage.example.test',monitor:stagingMonitor.id },'Staging')
    const target = await connection('cpanel',{ ...cpanelConfig,site:'https://live.example.test',monitor:productionMonitor.id },'Production')
    for (let index=0;index<4;index++) {
      const job = await claim()
      assert.equal(job.job.kind,'test')
      assert.equal(await finish(job,{ capabilities:[{ capability:'Fixture connection',state:'verified',detail:'Test transport' }] }),true)
    }
    const run = await request('tickets/' + ticket.id + '/investigate',{ task:task.id,prompt:'Reproduce on scoped staging.' })
    const interrupted = await claim()
    assert.equal(interrupted.monitor.id,stagingMonitor.id)
    await query("UPDATE maintenance_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[interrupted.job.id])
    const resumed = await claim()
    assert.equal(resumed.job.id,interrupted.job.id)
    assert.equal(await finish(interrupted,{ state:'blocked' }),false)
    assert.equal(await finish(resumed,{ state:'awaiting_staging',base,sha:candidate,pull:17,evidence:{ files:[{ path:'index.php',diff:'Private diff' }] } }),true)
    assert.equal(await finish(resumed,{ state:'blocked' }),false)
    await assert.rejects(request('runs/' + run.id,undefined,client),{ status:404 })
    await assert.rejects(request('runs/' + run.id,undefined,outsider),{ status:404 })
    await assert.rejects(request('runs/' + run.id + '/approve',{ target:target.id,sha:candidate }),{ status:409 })
    await request('runs/' + run.id + '/staging',{})
    const staged = await claim()
    assert.equal(staged.job.kind,'staging')
    assert.equal(await finish(staged,{ state:'ready',sha:candidate,evidence:{ outcome:'pass' } }),true)
    await assert.rejects(request('runs/' + run.id + '/approve',{ target:target.id,sha:base }),{ status:409 })
    const release = await request('runs/' + run.id + '/approve',{ target:target.id,sha:candidate })
    assert.deepEqual(await request('runs/' + run.id + '/approve',{ target:target.id,sha:candidate }),release)
    await request('releases/' + release.id + '/deploy',{})
    assert.deepEqual(await request('releases/' + release.id + '/deploy',{}),{ saved:true })
    const preflight = await claim()
    assert.equal(preflight.job.kind,'preflight')
    assert.equal(await finish(preflight,{ state:'awaiting_manual',sha:base }),true)
    await request('releases/' + release.id + '/verify',{})
    await request('releases/' + release.id + '/verify',{})
    const verifying = await claim()
    assert.equal(verifying.monitor.id,productionMonitor.id)
    assert.equal(await finish(verifying,{ state:'verification_failed',sha:candidate,verification:'Read-only check failed' }),true)
    assert.equal((await request('releases/' + release.id)).published_sha,candidate)
    assert.equal((await request('attention')).some(item => item.id===release.id),true)
    assert.equal((await request('tasks/' + task.id)).state,'Open')
    assert.equal((await request('releases/' + release.id)).history.length,2)
    assert.equal(await claim(),null)
    await assert.rejects(request('releases/' + release.id,undefined,client),{ status:404 })
  } finally {
    await db.close()
  }
})

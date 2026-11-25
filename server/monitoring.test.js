import assert from 'node:assert/strict'
import test from 'node:test'
import { initialize } from './api.js'
import { openDatabase, scopedTransaction } from './database.js'
import { monitoringRoute } from './monitoring.js'

test('monitor jobs recover leases, classify incidents, deduplicate alerts and preserve organization boundaries', async () => {
  const db = await openDatabase()
  try {
    await initialize(db, true)
    const first = (sql, values) => scopedTransaction(db, async tx => (await tx.query(sql, values)).rows[0])
    const as = (role, actor, work) => scopedTransaction(db, async tx => {
      await tx.exec('SET LOCAL ROLE ' + role)
      if (actor) await tx.query("SELECT set_config('workspace.actor',$1,true)", [actor])
      return work(tx)
    })
    const request = (account, pathname, body) => as('workspace_app', account.id, tx =>
      monitoringRoute(tx, { method: body ? 'POST' : 'GET', pathname: '/api/monitoring' + pathname, body, account }))
    const owner = { id: 'agency', agency: true }
    const gents = { id: 'gents', agency: false }
    const outsider = { id: 'other', agency: false }
    const worker = (sql, values) => as('workspace_monitor_worker', null, async tx => (await tx.query(sql, values)).rows[0])
    const claim = async kind => (await worker('SELECT claim_monitor($1) AS job', [kind])).job
    const finish = async (job, outcome, step) => (await worker('SELECT finish_monitor($1,$2,$3) AS saved', [
      job.run,job.lease,{ outcome,step,expected:'Staff record is visible',actual:'Fixture observation',duration:55 },
    ])).saved
    const eventCount = async kind => (await first('SELECT count(*)::integer AS count FROM monitoring_events WHERE kind=$1', [kind])).count
    const fixture = { project: 'gents-staff', environment: 'Staging', url: 'https://gents-fixture.example.test' }
    const { id: workflow } = await request(owner, '/workflows', {
      project: fixture.project, name: 'Add a barber', writes: true,
      steps: [{ action: 'fresh', label: 'Fresh session' }, { action: 'assert', label: 'Staff record missing after reload', selector: '#staff-list', value: 'MyDev Test Barber' }],
    })
    await assert.rejects(request(owner, '/monitors', { ...fixture, environment: 'Production', kind: 'workflow', name: 'Unsafe production', workflow }), { status: 400 })
    const { id: availability } = await request(owner, '/monitors', { ...fixture, kind: 'availability', name: 'Homepage' })
    const { id: staff } = await request(owner, '/monitors', { ...fixture, kind: 'workflow', name: 'Staff persistence', workflow })
    await worker('SELECT monitor_heartbeat($1)', ['availability'])
    await worker('SELECT monitor_heartbeat($1)', ['workflow'])
    const homepage = await claim('availability')
    assert.equal(homepage.monitor.id, availability)
    assert.equal(await finish(homepage,'pass'), true)
    assert.equal(await claim('availability'), null)
    const original = await claim('workflow')
    assert.equal(original.monitor.id, staff)
    await first("UPDATE check_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [original.run])
    const abandoned = await claim('workflow')
    assert.equal(abandoned.run, original.run)
    assert.notEqual(abandoned.lease, original.lease)
    assert.equal(await finish(original,'failure'), false)
    assert.equal(await finish(abandoned,'failure','Staff record missing after reload'), true)
    assert.equal(await finish(abandoned,'failure'), false)
    assert.equal(await eventCount('incident'), 0)

    const schedule = async () => {
      await first("UPDATE monitors SET next_due=clock_timestamp() WHERE id=$1", [staff])
      return claim('workflow')
    }
    const second = await schedule()
    assert.equal(await finish(second,'failure','Staff record missing after reload'), true)
    const dashboard = await request(owner, '')
    assert.equal(dashboard.monitors.find(item => item.id === availability).health, 'healthy')
    assert.equal(dashboard.incidents.length, 1)
    const incident = dashboard.incidents[0].id
    const retried = (await request(owner, '/incident/' + incident)).history.find(item => item.id === original.run)
    assert.equal(retried.attempts, 2)
    assert.deepEqual(retried.retry_history.map(item => item.state), ['abandoned','complete'])
    await assert.rejects(request(gents, '/incident/' + incident), { status: 404 })
    await assert.rejects(request(outsider, '/incident/' + incident), { status: 404 })
    await assert.rejects(request(outsider, '/monitor/' + staff), { status: 404 })
    await assert.rejects(as('workspace_monitor_worker', null, tx => tx.query('SELECT * FROM tickets')), { code: '42501' })
    await assert.rejects(request(owner, '/incident/' + incident, { operation: 'assign', account: 'other' }), { status: 404 })
    await request(owner, '/incident/' + incident, { operation: 'assign', account: 'agency' })
    await request(owner, '/incident/' + incident, { operation: 'acknowledge' })
    const ticket = async project => (await first("INSERT INTO tickets(project_id,author_id,subject) VALUES($1,'agency','Pilot ticket') RETURNING id", [project])).id
    const otherTicket = await ticket('harbor-site')
    await assert.rejects(request(owner, '/incident/' + incident, { operation: 'link', ticket: otherTicket }), { status: 404 })
    const gentsTicket = await ticket('gents-staff')
    await request(owner, '/incident/' + incident, { operation: 'link', ticket: gentsTicket })
    assert.equal((await request(owner, '/incident/' + incident)).ticket_id, gentsTicket)
    assert.equal((await request(owner, '/incident/' + incident)).assigned_to, 'agency')

    assert.equal(await finish(await schedule(),'failure'), true)
    assert.equal((await request(owner, '/incident/' + incident)).failure_count, 3)
    assert.equal(await eventCount('incident'), 1)
    for (const account of ['gents','other']) {
      const hidden = await as('workspace_app', account, async tx => (await tx.query(
        'SELECT (SELECT count(*) FROM monitoring_events)::integer AS events,(SELECT count(*) FROM check_attempts)::integer AS attempts',
      )).rows[0])
      assert.deepEqual(hidden, { events:0,attempts:0 })
    }
    assert.equal(await finish(await schedule(),'pass'), true)
    assert.ok((await request(owner, '/incident/' + incident)).recovered_at)
    assert.equal((await request(owner, '')).incidents.length, 0)
    assert.equal(await eventCount('recovery'), 1)
    assert.equal(await finish(await schedule(),'monitor_error','Expired test credentials'), true)
    assert.equal(await finish(await schedule(),'monitor_error','Expired test credentials'), true)
    assert.equal(await eventCount('monitor_error'), 1)
    const broken = (await request(owner, '')).monitors.find(item => item.id === staff)
    assert.equal(broken.health, 'healthy')
    assert.equal(broken.needs_attention, true)
    assert.equal(broken.run_state, 'inconclusive')

    await first("UPDATE worker_status SET observed_at=now()-interval '4 minutes' WHERE kind='workflow'")
    await first("UPDATE monitors SET created_at=now()-interval '1 day' WHERE id=$1", [staff])
    const stale = (await request(owner, '')).monitors.find(item => item.id === staff)
    assert.equal(stale.stale, true)
    assert.ok(stale.observed < stale.expected_samples)
    await request(owner, '/monitor/' + staff, {
      operation: 'maintenance', start: new Date(Date.now()-60_000).toISOString(),
      end: new Date(Date.now()+120_000).toISOString(), suppress: true,
    })
    assert.equal(await finish(await schedule(),'failure'), true)
    assert.equal(await finish(await schedule(),'failure'), true)
    assert.equal(await eventCount('incident'), 1)
    assert.equal((await request(owner, '/monitor/' + staff)).history[0].planned, true)
    assert.equal(await finish(await schedule(),'pass'), true)
    assert.equal(await eventCount('recovery'), 1)
    await request(owner, '/monitor/' + staff, { operation: 'run' })
    await request(owner, '/monitor/' + staff, { operation: 'run' })
    assert.equal((await request(owner, '/monitor/' + staff)).history.filter(run => run.state === 'queued').length, 1)
    assert.equal((await claim('workflow')).monitor.id, staff)
  } finally {
    await db.close()
  }
})

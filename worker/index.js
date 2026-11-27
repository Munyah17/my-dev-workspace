import { vpsLane } from './vps.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { openDatabase, scopedTransaction } from '../server/database.js'
import { browserCheck } from './browser.js'
import { httpsObservation } from './network.js'
import { billingLane } from './billing.js'
import { maintenanceLane } from './maintenance.js'

export async function execute(job) {
  const { monitor, workflow } = job
  const start = Date.now()
  let result
  try {
    if (monitor.kind === 'workflow') result = await browserCheck(monitor, workflow)
    else {
      const observation = await httpsObservation(monitor.url, {
        signal: AbortSignal.timeout(monitor.timeout_seconds * 1000), phrase: monitor.phrase,
      })
      const pass = observation.status === monitor.expected_status && (!monitor.phrase || observation.phraseFound)
      result = {
        outcome: pass ? 'pass' : 'failure',
        expected: 'HTTP ' + monitor.expected_status + (monitor.phrase ? ' and expected page text' : ''),
        actual: 'HTTP ' + observation.status + (monitor.phrase && !observation.phraseFound ? '; expected text missing' : ''),
      }
    }
  } catch (error) {
    const failed = error.name === 'TimeoutError' || error.name === 'AbortError' ||
      ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENOTFOUND'].includes(error.code)
    result = { outcome: failed ? 'failure' : 'monitor_error', actual: failed ? 'The endpoint could not be reached in time.' : 'The check destination or runner configuration is invalid.' }
  }
  return { ...result, duration: Date.now() - start }
}

const databaseUrl = process.env.MONITOR_DATABASE_URL
if (!databaseUrl) throw new Error('Set MONITOR_DATABASE_URL to the scoped worker connection.')
const db = await openDatabase({ url: databaseUrl })
const stop = new AbortController()
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => stop.abort())
const query = (sql, values) => scopedTransaction(db, tx => tx.query(sql, values))

async function lane(kind) {
  while (!stop.signal.aborted) {
    try {
      await query('SELECT monitor_heartbeat($1)', [kind])
      const { rows: [{ job }] } = await query('SELECT claim_monitor($1) AS job', [kind])
      if (job) {
        const result = await execute(job)
        await query('SELECT finish_monitor($1,$2,$3)', [job.run,job.lease,result])
        continue
      }
    } catch (error) {
      console.error('Monitoring lane retry:', kind, error.code ?? error.name)
    }
    await sleep(5000, undefined, { signal: stop.signal }).catch(() => {})
  }
}

try {
  await Promise.all([lane('availability'), lane('workflow'), maintenanceLane(process.env.MAINTENANCE_DATABASE_URL,stop.signal),billingLane(process.env.BILLING_DATABASE_URL,stop.signal),vpsLane(process.env.VPS_DATABASE_URL,stop.signal).catch(error=>console.error('VPS lane stopped:',error.code??error.name))])
} finally {
  await db.close()
}

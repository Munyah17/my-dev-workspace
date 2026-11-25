import { setTimeout as sleep } from 'node:timers/promises'
import { openDatabase,scopedTransaction } from '../server/database.js'

export async function billingLane(url,stop) {
  if (!url) return
  const db=await openDatabase({ url })
  try {
    while (!stop.aborted) {
      try { await scopedTransaction(db,tx=>tx.query('SELECT billing_generate_reminders()')) }
      catch (error) { console.error('Billing reminder retry:',error.code ?? error.name) }
      await sleep(60000,undefined,{ signal:stop }).catch(()=>{})
    }
  } finally {
    await db.close()
  }
}

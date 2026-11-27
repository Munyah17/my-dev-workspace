import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { openDatabase, scopedTransaction } from './database.js'

export async function migrateMonitoring(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042002)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.monitors') AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./monitoring.sql', import.meta.url), 'utf8'))
}

export async function migrateMaintenance(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042003)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.maintenance_connections') AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./maintenance.sql', import.meta.url), 'utf8'))
}

export async function migrateBilling(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042004)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.billing_documents') AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./billing.sql', import.meta.url), 'utf8'))
}

export async function migrateOperations(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042005)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.ops_orders') AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./operations.sql', import.meta.url), 'utf8'))
}

export async function migrateWorkspaceTools(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042006)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.erp_service_types') IS NOT NULL AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./workspace-tools.sql', import.meta.url), 'utf8'))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const url = process.env.SUPABASE_ADMIN_DATABASE_URL
  if (!url) throw new Error('Set SUPABASE_ADMIN_DATABASE_URL for migrations.')
  const db = await openDatabase({ url })
  try {
    await scopedTransaction(db, async tx => {
      if (process.argv.includes('--workspace-tools')) return migrateWorkspaceTools(tx)
      if (process.argv.includes('--operations')) return migrateOperations(tx)
      if (process.argv.includes('--billing')) return migrateBilling(tx)
      await migrateMonitoring(tx)
      if (process.argv.includes('--maintenance')) await migrateMaintenance(tx)
    })
    if (process.argv.includes('--workspace-tools')) console.log('Workspace tools schema ready.')
    else if (process.argv.includes('--operations')) console.log('Orders, inventory, and expense schemas ready.')
    else if (process.argv.includes('--billing')) console.log('Billing schema ready.')
    else console.log(process.argv.includes('--maintenance') ? 'Monitoring and maintenance schemas ready.' : 'Monitoring schema ready.')
  } finally {
    await db.close()
  }
}

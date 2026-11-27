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

export async function migrateIntegrationCatalog(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042007)')
  const { rows } = await tx.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='workspace_private' AND table_name='developer_connections' AND column_name='verified_details') AS installed`)
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./integration-catalog.sql', import.meta.url), 'utf8'))
}

export async function migrateIntegrationCredentials(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042008)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.developer_connection_secrets') IS NOT NULL AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./integration-credentials.sql', import.meta.url), 'utf8'))
}

export async function migrateBillingEditor(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042009)')
  const { rows } = await tx.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='workspace_private' AND table_name='billing_documents' AND column_name='document_details') AS installed`)
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./billing-editor.sql', import.meta.url), 'utf8'))
}

export async function migrateAgencyIntegrations(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042010)')
  const { rows } = await tx.query("SELECT to_regclass('workspace_private.paynow_collections') IS NOT NULL AS installed")
  if (!rows[0].installed) await tx.exec(await readFile(new URL('./agency-integrations.sql', import.meta.url), 'utf8'))
}

export async function migrateVps(tx) {
  await tx.query('SELECT pg_advisory_xact_lock(231042011)')
  const {rows}=await tx.query("SELECT to_regclass('workspace_private.vps_wallets') IS NOT NULL AS installed")
  if(!rows[0].installed) await tx.exec(await readFile(new URL('./vps.sql',import.meta.url),'utf8'))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const url = process.env.SUPABASE_ADMIN_DATABASE_URL
  if (!url) throw new Error('Set SUPABASE_ADMIN_DATABASE_URL for migrations.')
  const db = await openDatabase({ url })
  try {
    await scopedTransaction(db, async tx => {
      if (process.argv.includes('--vps')) return migrateVps(tx)
      if (process.argv.includes('--workspace-tools')) {
        await migrateWorkspaceTools(tx)
        await migrateIntegrationCatalog(tx)
        await migrateIntegrationCredentials(tx)
        return migrateAgencyIntegrations(tx)
      }
      if (process.argv.includes('--operations')) return migrateOperations(tx)
      if (process.argv.includes('--billing')) {
        await migrateBilling(tx)
        return migrateBillingEditor(tx)
      }
      await migrateMonitoring(tx)
      if (process.argv.includes('--maintenance')) await migrateMaintenance(tx)
    })
    if (process.argv.includes('--vps')) console.log('VPS wallet schema ready.')
    else if (process.argv.includes('--workspace-tools')) console.log('Workspace tools schema ready.')
    else if (process.argv.includes('--operations')) console.log('Orders, inventory, and expense schemas ready.')
    else if (process.argv.includes('--billing')) console.log('Billing schema ready.')
    else console.log(process.argv.includes('--maintenance') ? 'Monitoring and maintenance schemas ready.' : 'Monitoring schema ready.')
  } finally {
    await db.close()
  }
}

import { initialize } from './api.js'
import { openDatabase, scopedTransaction } from './database.js'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())
const url = process.env.SUPABASE_ADMIN_DATABASE_URL
if (!url) throw new Error('Set SUPABASE_ADMIN_DATABASE_URL for provisioning.')
const db = await openDatabase({ url })
try {
  await initialize(db, false)
  await scopedTransaction(db, async tx => {
    const workspace = input.workspace
    await tx.query('INSERT INTO workspaces VALUES ($1,$2)', [workspace.id, workspace.name])
    for (const organization of input.organizations) {
      await tx.query('INSERT INTO organizations VALUES ($1,$2,$3)', [organization.id, workspace.id, organization.name])
    }
    for (const project of input.projects) {
      await tx.query('INSERT INTO projects VALUES ($1,$2,$3,$4)', [project.id, workspace.id, project.organization ?? null, project.name])
    }
    for (const account of input.accounts) {
      await tx.query('INSERT INTO accounts (id,email,name,auth_user_id) VALUES ($1,$2,$3,$4)', [
        account.id, account.email.trim().toLowerCase(), account.name, account.authUserId,
      ])
      await tx.query('INSERT INTO memberships VALUES ($1,$2,$3,$4)', [account.id, workspace.id, account.organization ?? null, account.role])
      for (const project of account.projects ?? []) {
        await tx.query('INSERT INTO project_access VALUES ($1,$2)', [account.id, project])
      }
    }
  })
  console.log('Workspace provisioned.')
} finally {
  await db.close()
}

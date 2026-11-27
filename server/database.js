import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { postgresConnectionOptions } from './supabase-tls.js'

export async function openDatabase({ dataDir, url } = {}) {
  if (!url) {
    if (dataDir) await mkdir(dataDir, { recursive: true, mode: 0o700 })
    return PGlite.create(dataDir)
  }
  const serverless = Boolean(process.env.VERCEL)
  const pool = new pg.Pool({
    ...postgresConnectionOptions(url, { serverless }),
    max: serverless ? 1 : 5,
    idleTimeoutMillis: serverless ? 1000 : 10000,
    connectionTimeoutMillis: 8000,
  })
  pool.on('error', error => console.error('Idle database connection failed:', error.code ?? error.name))
  return {
    async transaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({ query: client.query.bind(client), exec: client.query.bind(client) })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

export function scopedTransaction(db, work) {
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL search_path TO workspace_private, public')
    return work(tx)
  })
}

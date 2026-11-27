import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

export async function openDatabase({ dataDir, url } = {}) {
  if (!url) {
    if (dataDir) await mkdir(dataDir, { recursive: true, mode: 0o700 })
    return PGlite.create(dataDir)
  }
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 8000 })
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

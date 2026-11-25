export function appConfig() {
  if (process.env.WORKSPACE_DEMO === '1' && !['preview', 'production'].includes(process.env.VERCEL_ENV)) {
    return { demo: true, dataDir: process.env.WORKSPACE_DATA_DIR || '.data/demo' }
  }
  const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_DATABASE_URL: databaseUrl } = process.env
  if (!url || !key || !databaseUrl) throw new Error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_DATABASE_URL, or run npm run demo.')
  return { supabase: { url, key, databaseUrl } }
}

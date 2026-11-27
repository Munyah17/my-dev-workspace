ALTER TABLE developer_connections DROP CONSTRAINT developer_connections_provider_check;
ALTER TABLE developer_connections ADD CONSTRAINT developer_connections_provider_check
  CHECK(provider IN ('Devin','Cursor','Claude','Codex','ChatGPT','Vercel','Supabase','Cloudflare','Firebase','Netlify'));
ALTER TABLE developer_connections ADD COLUMN verified_details jsonb;
ALTER TABLE developer_model_runs ADD COLUMN provider text NOT NULL DEFAULT 'Claude'
  CHECK(provider IN ('Claude','Codex','ChatGPT'));
ALTER TABLE developer_work_links DROP CONSTRAINT developer_work_links_provider_check;
ALTER TABLE developer_work_links ADD CONSTRAINT developer_work_links_provider_check
  CHECK(provider IN ('Devin','Cursor','Claude','Codex','ChatGPT'));

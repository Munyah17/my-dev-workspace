ALTER TABLE developer_connections DROP CONSTRAINT developer_connections_provider_check;
ALTER TABLE developer_connections ADD CONSTRAINT developer_connections_provider_check
  CHECK(provider IN ('Devin','Cursor','Claude','Codex','ChatGPT','Grok','Vercel','Supabase','Cloudflare','Firebase','Netlify','WHM','cPanel','Stripe','Sentry','GitHub Actions'));
ALTER TABLE developer_model_runs DROP CONSTRAINT developer_model_runs_provider_check;
ALTER TABLE developer_model_runs ADD CONSTRAINT developer_model_runs_provider_check
  CHECK(provider IN ('Claude','Codex','ChatGPT','Grok'));

ALTER TABLE developer_connections DROP CONSTRAINT developer_connections_provider_check;
ALTER TABLE developer_connections ADD CONSTRAINT developer_connections_provider_check
  CHECK(provider IN ('Devin','Cursor','Claude','Codex','ChatGPT','Vercel','Supabase','Cloudflare','Firebase','Netlify','WHM','cPanel','Stripe','Sentry','GitHub Actions'));

CREATE TABLE stack_dispatches (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  request_id uuid NOT NULL,
  scope text NOT NULL,
  revision text NOT NULL,
  requested_by text NOT NULL REFERENCES accounts(id),
  state text NOT NULL CHECK(state IN ('accepted','rejected','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,request_id),
  UNIQUE(workspace_id,scope,revision)
);
ALTER TABLE stack_dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY stack_dispatch_owner ON stack_dispatches USING(developer_workspace_owner(workspace_id))
  WITH CHECK(developer_workspace_owner(workspace_id));
GRANT SELECT,INSERT ON stack_dispatches TO workspace_app;
GRANT UPDATE(state) ON stack_dispatches TO workspace_app;

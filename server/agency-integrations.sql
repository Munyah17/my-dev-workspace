ALTER TABLE developer_connections DROP CONSTRAINT developer_connections_provider_check;
ALTER TABLE developer_connections ADD CONSTRAINT developer_connections_provider_check
  CHECK(provider IN ('Devin','Cursor','Claude','Codex','ChatGPT','Vercel','Supabase','Cloudflare','Firebase','Netlify','WHM','cPanel','Stripe','Sentry'));

CREATE TABLE sentry_tasks (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  external_scope text NOT NULL,
  issue_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,external_scope,issue_id)
);
ALTER TABLE sentry_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY sentry_tasks_owner ON sentry_tasks USING(developer_workspace_owner(workspace_id))
  WITH CHECK(developer_workspace_owner(workspace_id));
GRANT SELECT,INSERT ON sentry_tasks TO workspace_app;

CREATE TABLE paynow_collections (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  reference text NOT NULL,
  received_on date NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD','ZWG','ZWL','ZAR')),
  gross bigint NOT NULL CHECK (gross>0),
  refund bigint NOT NULL CHECK (refund BETWEEN 0 AND gross),
  app text NOT NULL DEFAULT '',
  imported_by text NOT NULL REFERENCES accounts(id),
  PRIMARY KEY(workspace_id,reference)
);
ALTER TABLE paynow_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY paynow_collections_owner ON paynow_collections USING(developer_workspace_owner(workspace_id))
  WITH CHECK(developer_workspace_owner(workspace_id));
GRANT SELECT,INSERT ON paynow_collections TO workspace_app;

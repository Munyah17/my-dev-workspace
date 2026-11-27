CREATE TABLE developer_connection_secrets (
  workspace_id text NOT NULL, provider text NOT NULL, ciphertext text NOT NULL,
  PRIMARY KEY(workspace_id,provider),
  FOREIGN KEY(workspace_id,provider) REFERENCES developer_connections(workspace_id,provider) ON DELETE CASCADE
);
ALTER TABLE developer_connection_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY developer_secrets_read ON developer_connection_secrets FOR SELECT
  USING(EXISTS(SELECT 1 FROM maintenance_workspaces() w WHERE w.id=workspace_id));
CREATE POLICY developer_secrets_create ON developer_connection_secrets FOR INSERT
  WITH CHECK(developer_workspace_owner(workspace_id));
CREATE POLICY developer_secrets_edit ON developer_connection_secrets FOR UPDATE
  USING(developer_workspace_owner(workspace_id)) WITH CHECK(developer_workspace_owner(workspace_id));
CREATE POLICY developer_secrets_remove ON developer_connection_secrets FOR DELETE
  USING(developer_workspace_owner(workspace_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON developer_connection_secrets TO workspace_app;

CREATE SCHEMA workspace_private;
REVOKE ALL ON SCHEMA workspace_private FROM PUBLIC;
SET LOCAL search_path TO workspace_private, public;
CREATE ROLE workspace_app NOLOGIN;
CREATE ROLE workspace_gateway NOLOGIN NOINHERIT;
GRANT workspace_app TO workspace_gateway;
GRANT USAGE ON SCHEMA workspace_private TO workspace_app,workspace_gateway;
CREATE TABLE workspaces (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE organizations (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces, name text NOT NULL, UNIQUE(workspace_id,id));
CREATE TABLE accounts (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password text, auth_user_id uuid UNIQUE, CHECK ((password IS NULL) <> (auth_user_id IS NULL)));
CREATE TABLE memberships (account_id text REFERENCES accounts, workspace_id text REFERENCES workspaces, organization_id text, role text NOT NULL CHECK (role IN ('owner','support','finance','client_manager','client_member','assistant')), PRIMARY KEY(account_id,workspace_id), FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id), CHECK ((role IN ('client_manager','client_member')) = (organization_id IS NOT NULL)));
CREATE TABLE projects (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces, organization_id text, name text NOT NULL, FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id));
CREATE TABLE project_access (account_id text REFERENCES accounts, project_id text REFERENCES projects, PRIMARY KEY(account_id,project_id));
CREATE TABLE sessions (token_hash text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts, expires_at timestamptz NOT NULL);
CREATE TABLE tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id text NOT NULL REFERENCES projects, author_id text NOT NULL REFERENCES accounts, subject text NOT NULL, state text NOT NULL DEFAULT 'New' CHECK (state IN ('New','In progress','Awaiting agency','Awaiting client','Resolved','Reopened')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL REFERENCES tickets, author_id text NOT NULL REFERENCES accounts, body text NOT NULL, internal boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL REFERENCES messages, name text NOT NULL, content text NOT NULL);
CREATE TABLE notification_reads (account_id text REFERENCES accounts, message_id uuid REFERENCES messages, PRIMARY KEY(account_id,message_id));
CREATE FUNCTION actor() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('workspace.actor',true),'') $$;
CREATE FUNCTION project_allowed(project text, agency boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE p.id=project AND m.account_id=actor() AND (
      m.role='owner' OR
      (m.role='support' AND EXISTS (SELECT 1 FROM project_access a WHERE a.account_id=m.account_id AND a.project_id=p.id)) OR
      (NOT agency AND m.role IN ('client_manager','client_member') AND m.organization_id=p.organization_id
        AND EXISTS (SELECT 1 FROM project_access a WHERE a.account_id=m.account_id AND a.project_id=p.id))
    )
  )
$$;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_read ON projects FOR SELECT USING (project_allowed(id));
CREATE POLICY ticket_read ON tickets FOR SELECT USING (project_allowed(project_id));
CREATE POLICY ticket_create ON tickets FOR INSERT WITH CHECK (project_allowed(project_id) AND author_id=actor() AND state='New');
CREATE POLICY ticket_update ON tickets FOR UPDATE USING (project_allowed(project_id,true)) WITH CHECK (project_allowed(project_id,true));
CREATE POLICY message_read ON messages FOR SELECT USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id=ticket_id AND (NOT internal OR project_allowed(t.project_id,true))));
CREATE POLICY message_create ON messages FOR INSERT WITH CHECK (author_id=actor() AND EXISTS (SELECT 1 FROM tickets t WHERE t.id=ticket_id AND (NOT internal OR project_allowed(t.project_id,true))));
CREATE POLICY attachment_read ON attachments FOR SELECT USING (EXISTS (SELECT 1 FROM messages m WHERE m.id=message_id));
CREATE POLICY attachment_create ON attachments FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM messages m WHERE m.id=message_id AND m.author_id=actor()));
CREATE POLICY notification_read ON notification_reads FOR ALL USING (account_id=actor() AND EXISTS (SELECT 1 FROM messages m WHERE m.id=message_id)) WITH CHECK (account_id=actor() AND EXISTS (SELECT 1 FROM messages m WHERE m.id=message_id));
GRANT SELECT ON projects,tickets,messages,attachments TO workspace_app;
GRANT INSERT ON tickets,messages,attachments,notification_reads TO workspace_app;
GRANT SELECT ON notification_reads TO workspace_app;
GRANT UPDATE(state) ON tickets TO workspace_app;
CREATE FUNCTION author_name(account text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT a.name FROM accounts a WHERE a.id=account AND (a.id=actor() OR EXISTS (
    SELECT 1 FROM messages m JOIN tickets t ON t.id=m.ticket_id
    WHERE m.author_id=a.id AND project_allowed(t.project_id) AND (NOT m.internal OR project_allowed(t.project_id,true))
  ))
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA workspace_private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION actor(),project_allowed(text,boolean),author_name(text) TO workspace_app;
GRANT SELECT (id,email,name,auth_user_id) ON accounts TO workspace_gateway;
GRANT SELECT ON memberships TO workspace_gateway;
GRANT SELECT,INSERT,DELETE ON sessions TO workspace_gateway;

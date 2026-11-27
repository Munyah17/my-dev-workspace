CREATE TABLE developer_work_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES maintenance_tasks,
  provider text NOT NULL CHECK(provider IN ('Devin','Cursor','Claude')),
  title text NOT NULL, url text NOT NULL, created_by text NOT NULL REFERENCES accounts,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,provider,url)
);
ALTER TABLE developer_work_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY developer_links_read ON developer_work_links FOR SELECT
 USING(EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
CREATE POLICY developer_links_add ON developer_work_links FOR INSERT
 WITH CHECK(created_by=actor() AND EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
CREATE POLICY developer_links_remove ON developer_work_links FOR DELETE
 USING(created_by=actor() OR EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id AND maintenance_owner(t.project_id)));
GRANT SELECT,INSERT,DELETE ON developer_work_links TO workspace_app;

CREATE TABLE erp_service_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  name text NOT NULL, direction text NOT NULL CHECK(direction IN ('collection','supplier','domain')),
  interval_months integer NOT NULL CHECK(interval_months BETWEEN 1 AND 120),
  reminder_days integer NOT NULL CHECK(reminder_days BETWEEN 0 AND 365),
  UNIQUE(workspace_id,name), UNIQUE(workspace_id,id)
);
ALTER TABLE billing_services ADD COLUMN service_type uuid;
ALTER TABLE billing_services ADD FOREIGN KEY(workspace_id,service_type) REFERENCES erp_service_types(workspace_id,id);
ALTER TABLE erp_service_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY erp_types_staff ON erp_service_types USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
GRANT SELECT,INSERT ON erp_service_types TO workspace_app;
GRANT UPDATE(direction,interval_months,reminder_days) ON erp_service_types TO workspace_app;

CREATE TABLE erp_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces, organization_id text,
  invoice_id uuid REFERENCES billing_documents, number bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK(kind IN ('credit-note','debit-note','notice','claim','proposal','boq','bom')),
  title text NOT NULL, issued_on date NOT NULL, issuer text NOT NULL, recipient text NOT NULL, body text NOT NULL,
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  total_minor bigint NOT NULL CHECK(total_minor>=0), created_by text NOT NULL REFERENCES accounts, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE erp_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  name text NOT NULL, email text NOT NULL, job_title text NOT NULL, start_on date NOT NULL, active boolean NOT NULL DEFAULT true,
  UNIQUE(workspace_id,id)
);
CREATE TABLE erp_personnel_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, employee_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('leave','hours','bonus')), start_on date NOT NULL, end_on date NOT NULL CHECK(end_on>=start_on),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')), description text NOT NULL,
  minutes integer CHECK(minutes>=0), amount_minor bigint CHECK(amount_minor>=0), currency text CHECK(currency~'^[A-Z]{3}$'),
  created_by text NOT NULL REFERENCES accounts, reviewed_by text REFERENCES accounts, reviewed_at timestamptz,
  FOREIGN KEY(workspace_id,employee_id) REFERENCES erp_employees(workspace_id,id)
);
CREATE TABLE erp_payroll (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, employee_id uuid NOT NULL,
  employee_name text NOT NULL, issuer text NOT NULL, start_on date NOT NULL,end_on date NOT NULL CHECK(end_on>=start_on),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), base_minor bigint NOT NULL CHECK(base_minor>=0),
  bonus_minor bigint NOT NULL CHECK(bonus_minor>=0), deduction_minor bigint NOT NULL CHECK(deduction_minor>=0),
  paid_minutes integer NOT NULL CHECK(paid_minutes>=0), notes text NOT NULL,
  created_by text NOT NULL REFERENCES accounts, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,employee_id,start_on,end_on), CHECK(base_minor+bonus_minor>=deduction_minor),
  FOREIGN KEY(workspace_id,employee_id) REFERENCES erp_employees(workspace_id,id)
);
CREATE INDEX erp_documents_workspace ON erp_documents(workspace_id,created_at DESC);
CREATE INDEX erp_personnel_period ON erp_personnel_entries(employee_id,start_on,end_on);
ALTER TABLE erp_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_personnel_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_payroll ENABLE ROW LEVEL SECURITY;
CREATE POLICY erp_docs_staff ON erp_documents USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id) AND created_by=actor());
CREATE POLICY erp_employees_staff ON erp_employees USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY erp_entries_staff ON erp_personnel_entries FOR SELECT USING(billing_staff(workspace_id));
CREATE POLICY erp_entries_create ON erp_personnel_entries FOR INSERT WITH CHECK(billing_staff(workspace_id) AND created_by=actor() AND status='pending');
CREATE POLICY erp_entries_decide ON erp_personnel_entries FOR UPDATE USING(billing_staff(workspace_id) AND status='pending')
  WITH CHECK(billing_staff(workspace_id) AND reviewed_by=actor() AND status IN ('approved','declined'));
CREATE POLICY erp_payroll_staff ON erp_payroll USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id) AND created_by=actor());
GRANT SELECT,INSERT ON erp_documents,erp_employees,erp_personnel_entries,erp_payroll TO workspace_app;
GRANT UPDATE(name,email,job_title,active) ON erp_employees TO workspace_app;
GRANT UPDATE(status,reviewed_by,reviewed_at) ON erp_personnel_entries TO workspace_app;

CREATE FUNCTION developer_workspace_owner(workspace text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=workspace AND m.account_id=actor() AND m.role='owner')
$$;
REVOKE ALL ON FUNCTION developer_workspace_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION developer_workspace_owner(text) TO workspace_app;
CREATE TABLE developer_connections (
  workspace_id text REFERENCES workspaces, provider text CHECK(provider IN ('Devin','Cursor','Claude')),
  secret_ref text NOT NULL, external_scope text NOT NULL, checked_at timestamptz,
  PRIMARY KEY(workspace_id,provider)
);
CREATE TABLE developer_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES maintenance_tasks,
  actor_id text NOT NULL REFERENCES accounts,model text NOT NULL,prompt text NOT NULL,response text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE developer_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_model_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY developer_connections_read ON developer_connections FOR SELECT
 USING(EXISTS(SELECT 1 FROM maintenance_workspaces() w WHERE w.id=workspace_id));
CREATE POLICY developer_connections_create ON developer_connections FOR INSERT WITH CHECK(developer_workspace_owner(workspace_id));
CREATE POLICY developer_connections_update ON developer_connections FOR UPDATE USING(developer_workspace_owner(workspace_id))
 WITH CHECK(developer_workspace_owner(workspace_id));
CREATE POLICY developer_connections_delete ON developer_connections FOR DELETE USING(developer_workspace_owner(workspace_id));
CREATE POLICY developer_runs_read ON developer_model_runs FOR SELECT USING(EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
CREATE POLICY developer_runs_create ON developer_model_runs FOR INSERT
 WITH CHECK(actor_id=actor() AND EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON developer_connections TO workspace_app;
GRANT SELECT,INSERT ON developer_model_runs TO workspace_app;

GRANT UPDATE(service_type) ON billing_services TO workspace_app;
CREATE TABLE platform_administrators (
  account_id text PRIMARY KEY REFERENCES accounts, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_workspace_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces,
  plan text NOT NULL CHECK(plan IN ('pilot','starter','agency','enterprise')),
  lifecycle text NOT NULL CHECK(lifecycle IN ('trial','active','paused','closed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_workspace_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces,
  actor_id text NOT NULL REFERENCES accounts,plan text NOT NULL,lifecycle text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_administrators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_workspace_audit ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION platform_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM platform_administrators p WHERE p.account_id=actor())
$$;
CREATE FUNCTION platform_workspace_overview() RETURNS TABLE(workspace_id text,name text,plan text,lifecycle text,members bigint,projects bigint,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT w.id,w.name,coalesce(s.plan,'pilot'),coalesce(s.lifecycle,'trial'),
    (SELECT count(*) FROM memberships m WHERE m.workspace_id=w.id),
    (SELECT count(*) FROM projects p WHERE p.workspace_id=w.id),s.updated_at
  FROM workspaces w LEFT JOIN platform_workspace_settings s ON s.workspace_id=w.id WHERE platform_allowed()
  ORDER BY w.name
$$;
CREATE FUNCTION platform_update_workspace(workspace text,service_plan text,service_lifecycle text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
BEGIN
  IF NOT platform_allowed() OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=workspace) THEN RETURN false; END IF;
  INSERT INTO platform_workspace_settings(workspace_id,plan,lifecycle) VALUES(workspace,service_plan,service_lifecycle)
    ON CONFLICT(workspace_id) DO UPDATE SET plan=excluded.plan,lifecycle=excluded.lifecycle,updated_at=now();
  INSERT INTO platform_workspace_audit(workspace_id,actor_id,plan,lifecycle)
    VALUES(workspace,actor(),service_plan,service_lifecycle);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION platform_allowed(),platform_workspace_overview(),platform_update_workspace(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_allowed(),platform_workspace_overview(),platform_update_workspace(text,text,text) TO workspace_app;

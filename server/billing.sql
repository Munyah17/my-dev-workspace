CREATE FUNCTION billing_staff(workspace text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=workspace AND m.account_id=actor() AND m.role IN ('owner','finance'))
$$;
CREATE FUNCTION billing_client(workspace text, organization text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=workspace AND m.organization_id=organization AND m.account_id=actor() AND m.role='client_manager')
$$;
CREATE FUNCTION billing_scopes() RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT w.id,w.name FROM workspaces w WHERE billing_staff(w.id) ORDER BY w.name
$$;
CREATE TABLE billing_profiles (
  workspace_id text NOT NULL REFERENCES workspaces, organization_id text NOT NULL,
  email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
  PRIMARY KEY(workspace_id,organization_id),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE billing_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, organization_id text NOT NULL,
  name text NOT NULL, email text NOT NULL, phone text NOT NULL DEFAULT '',
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE billing_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, organization_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('quote','invoice')), number bigint GENERATED ALWAYS AS IDENTITY,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','issued','accepted','declined','void')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), due_on date NOT NULL, issued_on date,
  issuer text NOT NULL, recipient text NOT NULL, recipient_address text NOT NULL DEFAULT '',
  source_quote uuid UNIQUE REFERENCES billing_documents, total_minor bigint NOT NULL DEFAULT 0 CHECK(total_minor>=0),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=total_minor),
  accepted_at timestamptz, accepted_by text REFERENCES accounts,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,kind,number),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE billing_items (
  document_id uuid REFERENCES billing_documents, position integer NOT NULL,
  description text NOT NULL, quantity integer NOT NULL CHECK(quantity>0), unit_minor bigint NOT NULL CHECK(unit_minor>=0),
  discount_minor bigint NOT NULL CHECK(discount_minor>=0), tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),
  total_minor bigint NOT NULL CHECK(total_minor>=0), PRIMARY KEY(document_id,position)
);
CREATE TABLE billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES billing_documents,
  request_key uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), received_on date NOT NULL,
  method text NOT NULL, reference text NOT NULL, notes text NOT NULL, created_by text NOT NULL REFERENCES accounts,
  UNIQUE(invoice_id,request_key)
);
CREATE TABLE billing_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  organization_id text, name text NOT NULL, supplier text, domain text, kind text NOT NULL CHECK(kind IN ('collection','supplier','domain')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  interval_months integer NOT NULL CHECK(interval_months BETWEEN 1 AND 120), due_on date NOT NULL,
  reminder_days integer NOT NULL CHECK(reminder_days BETWEEN 0 AND 365),
  notes text NOT NULL DEFAULT '', confirmed_at timestamptz, last_confirmed_at timestamptz,
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE billing_reminders (
  service_id uuid REFERENCES billing_services, due_on date, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_id,due_on)
);
CREATE TABLE billing_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces,
  actor_id text NOT NULL REFERENCES accounts, operation text NOT NULL, record_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_documents_org ON billing_documents(workspace_id,organization_id,created_at DESC);
CREATE INDEX billing_services_due ON billing_services(workspace_id,due_on) WHERE confirmed_at IS NULL;

ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_staff ON billing_profiles USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY contacts_staff ON billing_contacts USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY docs_read ON billing_documents FOR SELECT USING(billing_staff(workspace_id) OR (issued_on IS NOT NULL AND billing_client(workspace_id,organization_id)));
CREATE POLICY docs_write ON billing_documents FOR INSERT WITH CHECK(billing_staff(workspace_id));
CREATE POLICY docs_edit ON billing_documents FOR UPDATE USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY items_read ON billing_items FOR SELECT USING(EXISTS(SELECT 1 FROM billing_documents d WHERE d.id=document_id));
CREATE POLICY items_insert ON billing_items FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM billing_documents d WHERE d.id=document_id AND d.state='draft' AND billing_staff(d.workspace_id)));
CREATE POLICY items_delete ON billing_items FOR DELETE USING(EXISTS(SELECT 1 FROM billing_documents d WHERE d.id=document_id AND d.state='draft' AND billing_staff(d.workspace_id)));
CREATE POLICY payments_staff ON billing_payments USING(EXISTS(SELECT 1 FROM billing_documents d WHERE d.id=invoice_id AND billing_staff(d.workspace_id)))
 WITH CHECK(created_by=actor() AND EXISTS(SELECT 1 FROM billing_documents d WHERE d.id=invoice_id AND billing_staff(d.workspace_id)));
CREATE POLICY services_staff ON billing_services USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY reminders_staff ON billing_reminders USING(EXISTS(SELECT 1 FROM billing_services s WHERE s.id=service_id));
CREATE POLICY audit_staff ON billing_audit USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id) AND actor_id=actor());
GRANT SELECT ON billing_profiles,billing_contacts,billing_documents,billing_items,billing_payments,billing_services,billing_reminders,billing_audit TO workspace_app;
GRANT INSERT ON billing_profiles,billing_contacts,billing_documents,billing_items,billing_payments,billing_services,billing_reminders,billing_audit TO workspace_app;
GRANT UPDATE ON billing_profiles TO workspace_app;
GRANT UPDATE(state,currency,due_on,issued_on,total_minor,paid_minor,accepted_at,accepted_by) ON billing_documents TO workspace_app;
GRANT UPDATE(due_on,confirmed_at,last_confirmed_at) ON billing_services TO workspace_app;
GRANT DELETE ON billing_items TO workspace_app;
CREATE FUNCTION billing_organizations(workspace text) RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
 SELECT o.id,o.name FROM organizations o WHERE o.workspace_id=workspace AND billing_staff(workspace) ORDER BY o.name
$$;
CREATE FUNCTION billing_create_organization(workspace text,title text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE new_id text := gen_random_uuid()::text;
BEGIN
  IF NOT billing_staff(workspace) THEN RAISE EXCEPTION 'Billing access denied' USING ERRCODE='42501'; END IF;
  INSERT INTO organizations(id,workspace_id,name) VALUES(new_id,workspace,title);
  RETURN new_id;
END $$;
CREATE FUNCTION billing_accept(document uuid, decision text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE changed uuid;
BEGIN
  IF decision NOT IN ('accepted','declined') THEN RETURN false; END IF;
  UPDATE billing_documents d SET state=decision,accepted_at=CASE WHEN decision='accepted' THEN now() END,accepted_by=actor()
  WHERE d.id=document AND d.kind='quote' AND d.state='issued' AND d.due_on>=current_date
    AND (billing_client(d.workspace_id,d.organization_id) OR billing_staff(d.workspace_id))
  RETURNING d.id INTO changed;
  IF changed IS NOT NULL THEN
    INSERT INTO billing_audit(workspace_id,actor_id,operation,record_id)
      SELECT workspace_id,actor(),decision,id FROM billing_documents WHERE id=changed;
  END IF;
  RETURN changed IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION billing_staff(text),billing_client(text,text),billing_scopes(),billing_organizations(text),billing_create_organization(text,text),billing_accept(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_staff(text),billing_client(text,text),billing_scopes(),billing_organizations(text),billing_create_organization(text,text),billing_accept(uuid,text) TO workspace_app;

CREATE FUNCTION billing_guard_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'draft' AND
     (NEW.currency,NEW.total_minor,NEW.due_on,NEW.issued_on) IS DISTINCT FROM
     (OLD.currency,OLD.total_minor,OLD.due_on,OLD.issued_on)
  THEN RAISE EXCEPTION 'Issued document values are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_immutable_snapshot BEFORE UPDATE ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION billing_guard_snapshot();

CREATE ROLE workspace_billing_worker NOLOGIN;
GRANT USAGE ON SCHEMA workspace_private TO workspace_billing_worker;
CREATE FUNCTION billing_generate_reminders() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  INSERT INTO billing_reminders(service_id,due_on)
    SELECT id,due_on FROM billing_services
    WHERE confirmed_at IS NULL AND due_on-reminder_days<=current_date ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION billing_generate_reminders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_generate_reminders() TO workspace_billing_worker;

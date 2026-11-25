CREATE TABLE ops_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, organization_id text NOT NULL,
  source_quote uuid NOT NULL UNIQUE REFERENCES billing_documents,
  number bigint GENERATED ALWAYS AS IDENTITY, currency text NOT NULL, total_minor bigint NOT NULL CHECK(total_minor>=0),
  state text NOT NULL DEFAULT 'Draft' CHECK(state IN ('Draft','Confirmed','In progress','Partially fulfilled','Fulfilled','Cancelled')),
  shared boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES organizations(workspace_id,id)
);
CREATE TABLE ops_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  name text NOT NULL, sku text NOT NULL, category text NOT NULL, unit text NOT NULL,
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), cost_minor bigint NOT NULL CHECK(cost_minor>=0),
  price_minor bigint NOT NULL CHECK(price_minor>=0), reorder_level integer NOT NULL CHECK(reorder_level>=0),
  serialized boolean NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(workspace_id,sku), UNIQUE(id,workspace_id)
);
CREATE TABLE ops_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES ops_orders,
  position integer NOT NULL, description text NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
  unit_minor bigint NOT NULL, discount_minor bigint NOT NULL, tax_bps integer NOT NULL, total_minor bigint NOT NULL,
  UNIQUE(order_id,position)
);
CREATE TABLE ops_line_plans (
  line_id uuid PRIMARY KEY REFERENCES ops_order_lines,
  kind text NOT NULL CHECK(kind IN ('product','service','recurring')), product_id uuid REFERENCES ops_products, fulfilled boolean NOT NULL DEFAULT false, recurring_service uuid UNIQUE REFERENCES billing_services,
  CHECK((kind='product')=(product_id IS NOT NULL))
);
CREATE TABLE ops_order_details (
  order_id uuid PRIMARY KEY REFERENCES ops_orders, notes text NOT NULL DEFAULT '', assignee text REFERENCES accounts
);
CREATE TABLE ops_stock_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  request_key uuid NOT NULL, product_id uuid NOT NULL REFERENCES ops_products, supplier text NOT NULL,
  received_on date NOT NULL, cost_minor bigint NOT NULL CHECK(cost_minor>=0), reference text NOT NULL,
  fingerprint text NOT NULL, UNIQUE(workspace_id,request_key)
);
CREATE TABLE ops_stock_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, product_id uuid NOT NULL,
  serial text, receipt_id uuid NOT NULL REFERENCES ops_stock_receipts,
  state text NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','allocated','damaged')),
  line_id uuid REFERENCES ops_order_lines,
  CHECK((state IN ('reserved','allocated'))=(line_id IS NOT NULL)),
  FOREIGN KEY(product_id,workspace_id) REFERENCES ops_products(id,workspace_id),
  UNIQUE(workspace_id,serial)
);
CREATE TABLE ops_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), unit_id uuid NOT NULL REFERENCES ops_stock_units,
  line_id uuid REFERENCES ops_order_lines, action text NOT NULL CHECK(action IN ('purchase','reservation','allocation','return','damaged','adjustment')),
  actor_id text NOT NULL REFERENCES accounts, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ops_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES ops_orders,
  actor_id text NOT NULL REFERENCES accounts, detail text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ops_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  request_key uuid NOT NULL, supplier text NOT NULL, category text NOT NULL, currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK(amount_minor>0), expense_on date NOT NULL, paid boolean NOT NULL,
  payment_method text NOT NULL, reference text NOT NULL, project_id text REFERENCES projects, service_id uuid REFERENCES billing_services,
  receipt_name text, receipt_content text, created_by text NOT NULL REFERENCES accounts, fingerprint text NOT NULL,
  UNIQUE(workspace_id,request_key)
);
CREATE INDEX ops_order_workspace ON ops_orders(workspace_id,state);
CREATE INDEX ops_unit_product_state ON ops_stock_units(product_id,state);
CREATE INDEX ops_unit_line ON ops_stock_units(line_id) WHERE line_id IS NOT NULL;
CREATE INDEX ops_expense_reporting ON ops_expenses(workspace_id,expense_on,currency);

ALTER TABLE ops_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_line_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_order_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_stock_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_stock_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_read ON ops_orders FOR SELECT USING(billing_staff(workspace_id) OR (shared AND billing_client(workspace_id,organization_id)));
CREATE POLICY orders_insert ON ops_orders FOR INSERT WITH CHECK(billing_staff(workspace_id));
CREATE POLICY orders_update ON ops_orders FOR UPDATE USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY products_staff ON ops_products USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY lines_read ON ops_order_lines FOR SELECT USING(EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id));
CREATE POLICY lines_create ON ops_order_lines FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id AND billing_staff(o.workspace_id)));
CREATE POLICY plans_staff ON ops_line_plans USING(EXISTS(SELECT 1 FROM ops_order_lines l JOIN ops_orders o ON o.id=l.order_id WHERE l.id=line_id AND billing_staff(o.workspace_id))) WITH CHECK(
 EXISTS(SELECT 1 FROM ops_order_lines l JOIN ops_orders o ON o.id=l.order_id WHERE l.id=line_id AND billing_staff(o.workspace_id)));
CREATE POLICY order_private ON ops_order_details USING(EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id AND billing_staff(o.workspace_id))) WITH CHECK(
 EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id AND billing_staff(o.workspace_id)));
CREATE POLICY receipts_staff ON ops_stock_receipts USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY units_staff ON ops_stock_units USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id));
CREATE POLICY movements_staff ON ops_stock_movements USING(EXISTS(SELECT 1 FROM ops_stock_units u WHERE u.id=unit_id AND billing_staff(u.workspace_id))) WITH CHECK(
 actor_id=actor() AND EXISTS(SELECT 1 FROM ops_stock_units u WHERE u.id=unit_id AND billing_staff(u.workspace_id)));
CREATE POLICY events_staff ON ops_order_events USING(EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id AND billing_staff(o.workspace_id))) WITH CHECK(
 actor_id=actor() AND EXISTS(SELECT 1 FROM ops_orders o WHERE o.id=order_id AND billing_staff(o.workspace_id)));
CREATE POLICY expenses_staff ON ops_expenses USING(billing_staff(workspace_id)) WITH CHECK(billing_staff(workspace_id) AND created_by=actor());

GRANT SELECT,INSERT ON ops_orders,ops_order_lines,ops_products,ops_line_plans,ops_order_details,ops_stock_receipts,ops_stock_units,ops_stock_movements,ops_order_events,ops_expenses TO workspace_app;
GRANT UPDATE(state,shared) ON ops_orders TO workspace_app;
GRANT UPDATE(kind,product_id,fulfilled,recurring_service) ON ops_line_plans TO workspace_app;
GRANT UPDATE(notes,assignee) ON ops_order_details TO workspace_app;
GRANT UPDATE(paid,payment_method) ON ops_expenses TO workspace_app;
GRANT UPDATE(state,line_id) ON ops_stock_units TO workspace_app;

GRANT UPDATE(active) ON ops_products TO workspace_app;
REVOKE INSERT ON ops_stock_movements FROM workspace_app;
CREATE FUNCTION ops_log_stock_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE movement text; related_line uuid; reason text := '';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'available' THEN RAISE EXCEPTION 'Stock must be received as available'; END IF;
    movement := 'purchase';
  ELSE
    movement := CASE
      WHEN OLD.state='available' AND NEW.state='reserved' THEN 'reservation'
      WHEN OLD.state='reserved' AND NEW.state='allocated' AND OLD.line_id=NEW.line_id THEN 'allocation'
      WHEN OLD.state IN ('reserved','allocated') AND NEW.state='available' THEN 'return'
      WHEN OLD.state='available' AND NEW.state='damaged' THEN 'damaged'
      WHEN OLD.state='damaged' AND NEW.state='available' THEN 'adjustment'
    END;
    related_line := coalesce(NEW.line_id,OLD.line_id);
  END IF;
  IF movement IS NULL THEN RAISE EXCEPTION 'Invalid stock transition' USING ERRCODE='23514'; END IF;
  IF movement IN ('return','damaged','adjustment') THEN
    reason := coalesce(nullif(current_setting('workspace.stock_reason',true),''),'');
    IF reason='' OR length(reason)>500 THEN RAISE EXCEPTION 'A stock adjustment reason is required' USING ERRCODE='23514'; END IF;
  END IF;
  INSERT INTO ops_stock_movements(unit_id,line_id,action,actor_id,reason)
    VALUES(NEW.id,related_line,movement,actor(),reason);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops_log_stock_change() FROM PUBLIC;
CREATE TRIGGER ops_stock_audit AFTER INSERT OR UPDATE OF state,line_id ON ops_stock_units
  FOR EACH ROW EXECUTE FUNCTION ops_log_stock_change();

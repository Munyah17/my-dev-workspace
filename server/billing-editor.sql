ALTER TABLE billing_documents ADD COLUMN document_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE billing_items ADD COLUMN unit_label text NOT NULL DEFAULT '';
GRANT UPDATE(document_details,recipient_address) ON billing_documents TO workspace_app;

CREATE OR REPLACE FUNCTION billing_guard_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'draft' AND
     (NEW.currency,NEW.total_minor,NEW.due_on,NEW.issued_on,NEW.document_details,NEW.recipient_address) IS DISTINCT FROM
     (OLD.currency,OLD.total_minor,OLD.due_on,OLD.issued_on,OLD.document_details,OLD.recipient_address)
  THEN RAISE EXCEPTION 'Issued document values are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

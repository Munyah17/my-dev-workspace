CREATE TABLE vps_wallets (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  available bigint NOT NULL DEFAULT 0 CHECK(available >= 0)
);
CREATE TABLE vps_rentals (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES vps_wallets(workspace_id),
  label text NOT NULL,
  ssh_key text NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 15 AND 1440),
  base_rate integer NOT NULL CHECK(base_rate>0),
  reserved bigint NOT NULL CHECK(reserved>0),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','provisioning','running','ending','ended','needs_review')),
  provider_id text,
  host text,
  started_at timestamptz,
  ends_at timestamptz,
  charged bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vps_single_active_rental ON vps_rentals(workspace_id) WHERE state<>'ended';
CREATE TABLE vps_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES vps_wallets(workspace_id),
  kind text NOT NULL CHECK(kind IN ('topup','reservation','refund')),
  reference text NOT NULL,
  amount bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,reference)
);
ALTER TABLE vps_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vps_rentals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vps_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY vps_wallet_read ON vps_wallets FOR SELECT USING(developer_workspace_owner(workspace_id));
CREATE POLICY vps_rentals_read ON vps_rentals FOR SELECT USING(developer_workspace_owner(workspace_id));
CREATE POLICY vps_ledger_read ON vps_ledger FOR SELECT USING(developer_workspace_owner(workspace_id));
GRANT SELECT ON vps_wallets,vps_rentals,vps_ledger TO workspace_app;

CREATE FUNCTION vps_credit(w text, ref text, cents integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
BEGIN
  IF NOT platform_allowed() OR cents NOT BETWEEN 1 AND 10000000 OR length(ref) NOT BETWEEN 1 AND 120
     OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=w) THEN RETURN false; END IF;
  INSERT INTO vps_wallets(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
  INSERT INTO vps_ledger(workspace_id,kind,reference,amount) VALUES(w,'topup',ref,cents) ON CONFLICT DO NOTHING;
  IF FOUND THEN UPDATE vps_wallets SET available=available+cents WHERE workspace_id=w;
  ELSE RETURN EXISTS(SELECT 1 FROM vps_ledger WHERE workspace_id=w AND kind='topup' AND reference=ref AND amount=cents);
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION vps_reserve(w text, rid uuid, title text, public_key text, duration integer, rate integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE hold bigint; old vps_rentals%ROWTYPE;
BEGIN
  IF NOT developer_workspace_owner(w) OR length(title) NOT BETWEEN 1 AND 100 OR duration NOT BETWEEN 15 AND 1440
    OR length(public_key) NOT BETWEEN 60 AND 100 OR rate NOT BETWEEN 1 AND 1000000000 THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(w), 231042011);
  PERFORM pg_advisory_xact_lock(hashtext(rid::text));
  SELECT * INTO old FROM vps_rentals WHERE id=rid;
  IF FOUND THEN RETURN old.workspace_id=w AND old.label=title AND old.ssh_key=public_key AND old.minutes=duration AND old.base_rate=rate; END IF;
  IF EXISTS(SELECT 1 FROM vps_rentals WHERE workspace_id=w AND state<>'ended') THEN RETURN false; END IF;
  hold:=ceil(duration::numeric * rate * 130 / 60000000);
  UPDATE vps_wallets SET available=available-hold WHERE workspace_id=w AND available>=hold;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO vps_rentals(id,workspace_id,label,ssh_key,minutes,base_rate,reserved) VALUES(rid,w,title,public_key,duration,rate,hold);
  INSERT INTO vps_ledger(workspace_id,kind,reference,amount) VALUES(w,'reservation',rid::text,-hold);
  RETURN true;
END $$;

CREATE FUNCTION vps_end(rid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
BEGIN
  UPDATE vps_rentals SET state='ending' WHERE id=rid AND developer_workspace_owner(workspace_id)
    AND state IN ('queued','running','ending');
  RETURN FOUND;
END $$;

CREATE ROLE workspace_vps_worker NOLOGIN;
GRANT USAGE ON SCHEMA workspace_private TO workspace_vps_worker;
GRANT SELECT,UPDATE ON vps_rentals TO workspace_vps_worker;
GRANT SELECT,UPDATE ON vps_wallets TO workspace_vps_worker;
GRANT INSERT ON vps_ledger TO workspace_vps_worker;
CREATE POLICY vps_rentals_worker ON vps_rentals TO workspace_vps_worker USING(true) WITH CHECK(true);
CREATE POLICY vps_wallet_worker ON vps_wallets TO workspace_vps_worker USING(true) WITH CHECK(true);
CREATE POLICY vps_ledger_worker ON vps_ledger FOR INSERT TO workspace_vps_worker WITH CHECK(kind='refund');

REVOKE ALL ON FUNCTION vps_credit(text,text,integer),vps_reserve(text,uuid,text,text,integer,integer),vps_end(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vps_credit(text,text,integer),vps_reserve(text,uuid,text,text,integer,integer),vps_end(uuid) TO workspace_app;

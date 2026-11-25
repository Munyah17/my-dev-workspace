CREATE ROLE workspace_monitor_worker NOLOGIN;
GRANT USAGE ON SCHEMA workspace_private TO workspace_monitor_worker;
CREATE TABLE monitor_environments (
  project_id text REFERENCES projects, name text CHECK(name IN ('Production','Staging')),
  PRIMARY KEY(project_id,name)
);
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id text NOT NULL REFERENCES projects,
  name text NOT NULL, steps jsonb NOT NULL, cleanup jsonb NOT NULL DEFAULT '[]', secret_name text, writes boolean NOT NULL DEFAULT false,
  UNIQUE(id,project_id)
);
CREATE TABLE monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id text NOT NULL REFERENCES projects,
  environment text NOT NULL, kind text NOT NULL CHECK(kind IN ('availability','workflow')),
  name text NOT NULL, url text NOT NULL, expected_status integer NOT NULL CHECK(expected_status BETWEEN 200 AND 599),
  phrase text, interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
  timeout_seconds integer NOT NULL CHECK(timeout_seconds BETWEEN 2 AND 120),
  failure_threshold integer NOT NULL DEFAULT 2 CHECK(failure_threshold BETWEEN 1 AND 10),
  recovery_threshold integer NOT NULL DEFAULT 1 CHECK(recovery_threshold BETWEEN 1 AND 10),
  workflow_id uuid, paused boolean NOT NULL DEFAULT false, next_due timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), last_check timestamptz, last_observation timestamptz,
  health text NOT NULL DEFAULT 'unknown', needs_attention boolean NOT NULL DEFAULT false, attention_notified boolean NOT NULL DEFAULT false,
  failures integer NOT NULL DEFAULT 0, successes integer NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id,environment) REFERENCES monitor_environments,
  FOREIGN KEY(workflow_id,project_id) REFERENCES workflows(id,project_id),
  CHECK ((kind='workflow')=(workflow_id IS NOT NULL))
);
CREATE TABLE maintenance_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, suppress boolean NOT NULL DEFAULT true,
  CHECK(ends_at>starts_at)
);
CREATE TABLE check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors,
  scheduled_for timestamptz NOT NULL DEFAULT now(), manual boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','inconclusive')),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  finished_at timestamptz, outcome text, step text, expected text, actual text, duration_ms integer,
  planned boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_pending_check ON check_runs(monitor_id) WHERE state IN ('queued','running');
CREATE INDEX check_history ON check_runs(monitor_id,finished_at DESC);
CREATE TABLE check_attempts (
  run_id uuid REFERENCES check_runs, number integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','abandoned','complete','inconclusive')),
  PRIMARY KEY(run_id,number)
);
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors,
  first_run uuid NOT NULL REFERENCES check_runs, latest_run uuid NOT NULL REFERENCES check_runs,
  opened_at timestamptz NOT NULL DEFAULT now(), first_failure_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), recovered_at timestamptz,
  failure_count integer NOT NULL, acknowledged_at timestamptz, assigned_to text REFERENCES accounts,
  ticket_id uuid REFERENCES tickets, notified boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_open_incident ON incidents(monitor_id) WHERE recovered_at IS NULL;
CREATE TABLE monitoring_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES monitors,
  incident_id uuid REFERENCES incidents, run_id uuid NOT NULL REFERENCES check_runs,
  kind text NOT NULL CHECK(kind IN ('incident','recovery','monitor_error')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,kind)
);
CREATE TABLE monitoring_event_reads (
  account_id text REFERENCES accounts, event_id uuid REFERENCES monitoring_events,
  PRIMARY KEY(account_id,event_id)
);
CREATE TABLE worker_status (
  kind text PRIMARY KEY CHECK(kind IN ('availability','workflow')), observed_at timestamptz NOT NULL
);

CREATE FUNCTION monitor_allowed(monitor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM monitors WHERE id=monitor AND project_allowed(project_id,true))
$$;
CREATE FUNCTION assignment_allowed(monitor uuid, account text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM monitors m JOIN projects p ON p.id=m.project_id
    JOIN memberships member ON member.workspace_id=p.workspace_id AND member.account_id=account
    WHERE m.id=monitor AND project_allowed(p.id,true) AND (
      member.role='owner' OR (member.role='support' AND EXISTS(
        SELECT 1 FROM project_access a WHERE a.account_id=account AND a.project_id=p.id
      ))
    )
  )
$$;
CREATE FUNCTION monitor_heartbeat(check_kind text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  INSERT INTO worker_status VALUES(check_kind,clock_timestamp())
  ON CONFLICT(kind) DO UPDATE SET observed_at=excluded.observed_at
$$;
CREATE FUNCTION claim_monitor(check_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE job uuid; result jsonb;
BEGIN
  INSERT INTO check_runs(monitor_id,scheduled_for)
    SELECT id,next_due FROM monitors
    WHERE NOT paused AND kind=check_kind AND next_due<=clock_timestamp()
    ON CONFLICT DO NOTHING;
  SELECT r.id INTO job FROM check_runs r JOIN monitors m ON m.id=r.monitor_id
    WHERE m.kind=check_kind AND NOT m.paused AND
      (r.state='queued' OR (r.state='running' AND r.lease_until<=clock_timestamp()))
    ORDER BY r.manual DESC,r.scheduled_for,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED;
  IF job IS NULL THEN RETURN NULL; END IF;
  UPDATE check_attempts SET state='abandoned',finished_at=clock_timestamp() WHERE run_id=job AND state='running';
  UPDATE check_runs SET state='running',lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '180 seconds',attempts=attempts+1 WHERE id=job;
  INSERT INTO check_attempts(run_id,number) SELECT id,attempts FROM check_runs WHERE id=job;
  SELECT jsonb_build_object('run',r.id,'lease',r.lease_token,'monitor',to_jsonb(m),'workflow',to_jsonb(w))
    INTO result FROM check_runs r JOIN monitors m ON m.id=r.monitor_id LEFT JOIN workflows w ON w.id=m.workflow_id WHERE r.id=job;
  RETURN result;
END $$;

CREATE FUNCTION finish_monitor(job uuid, token uuid, result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE r check_runs%ROWTYPE; m monitors%ROWTYPE; incident incidents%ROWTYPE;
  result_outcome text := result->>'outcome'; finished timestamptz := clock_timestamp();
  in_maintenance boolean; suppressed boolean; upcoming_end timestamptz; first_check check_runs%ROWTYPE;
BEGIN
  IF result_outcome IS NULL OR result_outcome NOT IN ('pass','failure','monitor_error','inconclusive') THEN
    RAISE EXCEPTION 'Invalid check outcome';
  END IF;
  SELECT * INTO r FROM check_runs WHERE id=job AND state='running' AND lease_token=token AND lease_until>finished FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO m FROM monitors WHERE id=r.monitor_id FOR UPDATE;
  SELECT count(*) FILTER(WHERE w.starts_at<=finished)>0,
    coalesce(bool_or(w.suppress) FILTER(WHERE w.starts_at<=finished),false),min(w.ends_at)
    INTO in_maintenance,suppressed,upcoming_end FROM maintenance_windows w
    WHERE w.monitor_id=m.id AND w.ends_at>finished;
  UPDATE check_runs SET state=CASE WHEN result_outcome IN ('inconclusive','monitor_error') THEN 'inconclusive' ELSE 'complete' END,
    finished_at=finished, duration_ms=(result->>'duration')::integer, outcome=result_outcome,
    step=left(result->>'step',160),expected=left(result->>'expected',300),actual=left(result->>'actual',300),
    planned=in_maintenance,lease_token=NULL,lease_until=NULL WHERE id=job;
  UPDATE check_attempts SET state=CASE WHEN result_outcome IN ('inconclusive','monitor_error') THEN 'inconclusive' ELSE 'complete' END,
    finished_at=finished WHERE run_id=job AND number=r.attempts;
  UPDATE monitors SET last_check=finished,
    next_due=CASE WHEN r.manual THEN m.next_due ELSE least(finished+make_interval(secs=>m.interval_seconds),upcoming_end) END,
    needs_attention=CASE WHEN result_outcome='inconclusive' THEN m.needs_attention ELSE result_outcome='monitor_error' END,
    attention_notified=CASE WHEN result_outcome IN ('pass','failure') THEN false
      WHEN result_outcome='monitor_error' AND NOT suppressed THEN true ELSE m.attention_notified END,
    last_observation=CASE WHEN result_outcome IN ('pass','failure') THEN finished ELSE m.last_observation END,
    health=CASE WHEN result_outcome='pass' THEN 'healthy' WHEN result_outcome='failure' THEN 'failing' ELSE m.health END,
    failures=CASE WHEN result_outcome='failure' THEN m.failures+1 ELSE 0 END,
    successes=CASE WHEN result_outcome='pass' THEN m.successes+1 ELSE 0 END
    WHERE id=m.id;
  IF result_outcome='monitor_error' AND NOT m.attention_notified AND NOT suppressed THEN
    INSERT INTO monitoring_events(monitor_id,run_id,kind) VALUES(m.id,job,'monitor_error');
  END IF;
  SELECT * INTO incident FROM incidents WHERE monitor_id=m.id AND recovered_at IS NULL FOR UPDATE;
  IF result_outcome='failure' THEN
    IF incident.id IS NULL AND m.failures+1>=m.failure_threshold THEN
      SELECT * INTO first_check FROM check_runs cr WHERE cr.monitor_id=m.id
        AND cr.finished_at IS NOT NULL ORDER BY cr.finished_at DESC,cr.id OFFSET m.failure_threshold-1 LIMIT 1;
      INSERT INTO incidents(monitor_id,first_run,latest_run,first_failure_at,failure_count)
        VALUES(m.id,first_check.id,job,first_check.finished_at,m.failures+1) RETURNING * INTO incident;
    ELSIF incident.id IS NOT NULL THEN
      UPDATE incidents SET latest_run=job,updated_at=finished,failure_count=failure_count+1 WHERE id=incident.id;
    END IF;
    IF incident.id IS NOT NULL AND NOT incident.notified AND NOT suppressed THEN
      INSERT INTO monitoring_events(monitor_id,incident_id,run_id,kind) VALUES(m.id,incident.id,job,'incident');
      UPDATE incidents SET notified=true WHERE id=incident.id;
    END IF;
  ELSIF result_outcome='pass' AND incident.id IS NOT NULL AND m.successes+1>=m.recovery_threshold THEN
    UPDATE incidents SET recovered_at=finished,updated_at=finished WHERE id=incident.id;
    IF incident.notified AND NOT suppressed THEN
      INSERT INTO monitoring_events(monitor_id,incident_id,run_id,kind) VALUES(m.id,incident.id,job,'recovery');
    END IF;
  END IF;
  RETURN true;
END $$;

ALTER TABLE monitor_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY agencies_read ON check_attempts FOR SELECT USING(EXISTS(SELECT 1 FROM check_runs r WHERE r.id=run_id));
CREATE POLICY agencies_read ON worker_status FOR SELECT USING(EXISTS(SELECT 1 FROM monitors m WHERE m.kind=worker_status.kind));
ALTER TABLE maintenance_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_event_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY agencies ON monitor_environments FOR ALL USING(project_allowed(project_id,true)) WITH CHECK(project_allowed(project_id,true));
CREATE POLICY agencies ON workflows FOR ALL USING(project_allowed(project_id,true)) WITH CHECK(project_allowed(project_id,true));
CREATE POLICY agencies ON monitors FOR ALL USING(project_allowed(project_id,true)) WITH CHECK(project_allowed(project_id,true));
CREATE POLICY agencies_read ON check_runs FOR SELECT USING(monitor_allowed(monitor_id));
CREATE POLICY agencies_queue ON check_runs FOR INSERT WITH CHECK(monitor_allowed(monitor_id) AND manual AND state='queued');
CREATE POLICY agencies ON maintenance_windows FOR ALL USING(monitor_allowed(monitor_id)) WITH CHECK(monitor_allowed(monitor_id));
CREATE POLICY agencies ON incidents FOR SELECT USING(monitor_allowed(monitor_id));
CREATE POLICY agencies_edit ON incidents FOR UPDATE USING(monitor_allowed(monitor_id)) WITH CHECK(
  monitor_allowed(monitor_id) AND (assigned_to IS NULL OR assignment_allowed(monitor_id,assigned_to))
  AND (ticket_id IS NULL OR EXISTS(SELECT 1 FROM tickets t JOIN monitors m ON m.project_id=t.project_id WHERE t.id=ticket_id AND m.id=monitor_id))
);
CREATE POLICY agencies ON monitoring_events FOR SELECT USING(monitor_allowed(monitor_id));
CREATE POLICY personal ON monitoring_event_reads FOR ALL USING(account_id=actor()) WITH CHECK(
 account_id=actor() AND EXISTS(SELECT 1 FROM monitoring_events e WHERE e.id=event_id)
);
GRANT SELECT ON monitor_environments,workflows,monitors,check_runs,check_attempts,maintenance_windows,incidents,monitoring_events,monitoring_event_reads,worker_status TO workspace_app;
GRANT INSERT ON monitor_environments,workflows,monitors,maintenance_windows,monitoring_event_reads TO workspace_app;
GRANT INSERT(monitor_id,manual) ON check_runs TO workspace_app;
GRANT UPDATE(paused,next_due,interval_seconds,timeout_seconds,expected_status,phrase,failure_threshold,recovery_threshold) ON monitors TO workspace_app;
GRANT UPDATE(acknowledged_at,assigned_to,ticket_id) ON incidents TO workspace_app;
REVOKE ALL ON FUNCTION monitor_allowed(uuid),assignment_allowed(uuid,text),monitor_heartbeat(text),claim_monitor(text),finish_monitor(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_allowed(uuid),assignment_allowed(uuid,text) TO workspace_app;
GRANT EXECUTE ON FUNCTION monitor_heartbeat(text),claim_monitor(text),finish_monitor(uuid,uuid,jsonb) TO workspace_monitor_worker;

CREATE FUNCTION monitor_assignees(monitor uuid) RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
 SELECT a.id,a.name FROM accounts a WHERE assignment_allowed(monitor,a.id) ORDER BY a.name
$$;
REVOKE ALL ON FUNCTION monitor_assignees(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_assignees(uuid) TO workspace_app;

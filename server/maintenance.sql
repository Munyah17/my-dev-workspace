CREATE ROLE workspace_maintenance_worker NOLOGIN;
GRANT USAGE ON SCHEMA workspace_private TO workspace_maintenance_worker;

CREATE FUNCTION maintenance_owner(project text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE p.id=project AND m.account_id=actor() AND m.role='owner')
$$;
CREATE FUNCTION maintenance_assignees(project text) RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT a.id,a.name FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
  JOIN accounts a ON a.id=m.account_id
  WHERE p.id=project AND project_allowed(p.id,true) AND (
    m.role='owner' OR (m.role='support' AND EXISTS(SELECT 1 FROM project_access pa WHERE pa.account_id=a.id AND pa.project_id=p.id))
  ) ORDER BY a.name
$$;

CREATE FUNCTION maintenance_workspaces() RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT w.id,w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
    WHERE m.account_id=actor() AND m.role IN ('owner','support') ORDER BY w.name
$$;
CREATE FUNCTION maintenance_team(workspace text) RETURNS TABLE(id text,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
  SELECT a.id,a.name FROM memberships m JOIN accounts a ON a.id=m.account_id
    WHERE m.workspace_id=workspace AND m.role IN ('owner','support')
      AND EXISTS(SELECT 1 FROM maintenance_workspaces() w WHERE w.id=workspace) ORDER BY a.name
$$;
ALTER TABLE projects ADD UNIQUE(workspace_id,id);

CREATE TABLE maintenance_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES projects,
  provider text NOT NULL CHECK(provider IN ('github','cpanel','agent')),
  environment text NOT NULL CHECK(environment IN ('Project','Staging','Production')),
  account_name text NOT NULL,
  configuration jsonb NOT NULL,
  secret_ref text NOT NULL,
  created_by text NOT NULL REFERENCES accounts,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(id,project_id),
  CHECK((provider='cpanel')=(environment IN ('Staging','Production')))
);
CREATE UNIQUE INDEX one_maintenance_connection ON maintenance_connections(project_id,provider,environment) WHERE revoked_at IS NULL;
CREATE TABLE maintenance_capabilities (
  connection_id uuid REFERENCES maintenance_connections,
  capability text NOT NULL, state text NOT NULL CHECK(state IN ('verified','unavailable','unknown')),
  detail text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,capability)
);

CREATE TABLE maintenance_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces,
  project_id text, FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
  title text NOT NULL, assigned_to text NOT NULL REFERENCES accounts,
  due_at timestamptz, state text NOT NULL DEFAULT 'Open' CHECK(state IN ('Open','In progress','Awaiting review','Done')),
  created_by text NOT NULL REFERENCES accounts, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE maintenance_task_tickets (
  task_id uuid REFERENCES maintenance_tasks, ticket_id uuid REFERENCES tickets,
  PRIMARY KEY(task_id,ticket_id)
);
CREATE TABLE maintenance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES maintenance_tasks, ticket_id uuid NOT NULL REFERENCES tickets,
  requested_by text NOT NULL REFERENCES accounts,
  github_connection uuid NOT NULL REFERENCES maintenance_connections,
  agent_connection uuid NOT NULL REFERENCES maintenance_connections,
  staging_connection uuid NOT NULL REFERENCES maintenance_connections,
  state text NOT NULL DEFAULT 'queued',
  base_sha text, proposed_sha text, pull_request integer, evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE maintenance_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES maintenance_runs, target_id uuid NOT NULL REFERENCES maintenance_connections,
  commit_sha text NOT NULL, approved_by text NOT NULL REFERENCES accounts, approved_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'approved', published_sha text, verified_at timestamptz, evidence jsonb,
  UNIQUE(run_id,target_id,commit_sha)
);

ALTER TABLE maintenance_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_task_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY connections_read ON maintenance_connections FOR SELECT USING(project_allowed(project_id,true));
CREATE POLICY connections_create ON maintenance_connections FOR INSERT WITH CHECK(maintenance_owner(project_id) AND created_by=actor());
CREATE POLICY connections_edit ON maintenance_connections FOR UPDATE USING(maintenance_owner(project_id)) WITH CHECK(maintenance_owner(project_id));
CREATE POLICY capabilities_read ON maintenance_capabilities FOR SELECT USING(EXISTS(SELECT 1 FROM maintenance_connections c WHERE c.id=connection_id));
CREATE POLICY tasks_read ON maintenance_tasks FOR SELECT USING(
  (project_id IS NOT NULL AND project_allowed(project_id,true)) OR
  (project_id IS NULL AND EXISTS(SELECT 1 FROM maintenance_workspaces() w WHERE w.id=workspace_id))
);
CREATE POLICY tasks_create ON maintenance_tasks FOR INSERT WITH CHECK(
  created_by=actor() AND (
    (project_id IS NOT NULL AND EXISTS(SELECT 1 FROM maintenance_assignees(project_id) a WHERE a.id=assigned_to)) OR
    (project_id IS NULL AND EXISTS(SELECT 1 FROM maintenance_team(workspace_id) a WHERE a.id=assigned_to))
  )
);
CREATE POLICY tasks_edit ON maintenance_tasks FOR UPDATE USING(
  (project_id IS NOT NULL AND project_allowed(project_id,true)) OR
  (project_id IS NULL AND EXISTS(SELECT 1 FROM maintenance_workspaces() w WHERE w.id=workspace_id))
) WITH CHECK(
  (project_id IS NOT NULL AND EXISTS(SELECT 1 FROM maintenance_assignees(project_id) a WHERE a.id=assigned_to)) OR
  (project_id IS NULL AND EXISTS(SELECT 1 FROM maintenance_team(workspace_id) a WHERE a.id=assigned_to))
);
CREATE POLICY links_read ON maintenance_task_tickets FOR SELECT USING(EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
CREATE POLICY links_create ON maintenance_task_tickets FOR INSERT WITH CHECK(
  EXISTS(SELECT 1 FROM maintenance_tasks task JOIN tickets t ON t.project_id=task.project_id WHERE task.id=task_id AND t.id=ticket_id)
);
CREATE POLICY runs_read ON maintenance_runs FOR SELECT USING(EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id));
CREATE POLICY releases_read ON maintenance_releases FOR SELECT USING(EXISTS(SELECT 1 FROM maintenance_runs r WHERE r.id=run_id));
GRANT SELECT ON maintenance_connections,maintenance_capabilities,maintenance_tasks,maintenance_task_tickets,maintenance_runs,maintenance_releases TO workspace_app;
GRANT INSERT ON maintenance_connections,maintenance_tasks,maintenance_task_tickets TO workspace_app;
GRANT UPDATE(revoked_at) ON maintenance_connections TO workspace_app;
GRANT UPDATE(assigned_to,due_at,state) ON maintenance_tasks TO workspace_app;
REVOKE ALL ON FUNCTION maintenance_owner(text),maintenance_assignees(text),maintenance_workspaces(),maintenance_team(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_owner(text),maintenance_assignees(text),maintenance_workspaces(),maintenance_team(text) TO workspace_app;

ALTER TABLE maintenance_runs ADD COLUMN prompt text NOT NULL DEFAULT '';
ALTER TABLE maintenance_runs ADD COLUMN staged_sha text;
ALTER TABLE maintenance_runs ADD COLUMN verified_at timestamptz;
ALTER TABLE maintenance_releases ADD COLUMN verification text;
ALTER TABLE maintenance_releases ADD COLUMN previous_sha text;
CREATE UNIQUE INDEX one_running_release ON maintenance_releases(target_id)
  WHERE state IN ('preparing','awaiting_manual','verifying');
CREATE UNIQUE INDEX one_active_investigation ON maintenance_runs(task_id)
  WHERE state IN ('queued','investigating','awaiting_staging','staging_queued','verifying_staging');

CREATE TABLE maintenance_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('test','investigate','staging','preflight','production')),
  project_id text NOT NULL REFERENCES projects,
  connection_id uuid REFERENCES maintenance_connections, run_id uuid REFERENCES maintenance_runs, release_id uuid REFERENCES maintenance_releases,
  requested_by text NOT NULL REFERENCES accounts, state text NOT NULL DEFAULT 'queued',
  lease uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  CHECK(num_nonnulls(connection_id,run_id,release_id)=1)
);
CREATE UNIQUE INDEX one_maintenance_job ON maintenance_jobs(kind,coalesce(connection_id,run_id,release_id))
  WHERE state IN ('queued','running');

CREATE FUNCTION maintenance_queue(kind_in text,project_in text,target uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE queued uuid;
BEGIN
  IF NOT project_allowed(project_in,true) OR NOT (CASE kind_in
    WHEN 'test' THEN maintenance_owner(project_in) AND EXISTS(
      SELECT 1 FROM maintenance_connections c WHERE c.id=target AND c.project_id=project_in AND c.revoked_at IS NULL)
    WHEN 'investigate' THEN EXISTS(
      SELECT 1 FROM maintenance_runs r JOIN maintenance_tasks t ON t.id=r.task_id
      WHERE r.id=target AND t.project_id=project_in AND r.state='queued' AND r.requested_by=actor())
    WHEN 'staging' THEN EXISTS(
      SELECT 1 FROM maintenance_runs r JOIN maintenance_tasks t ON t.id=r.task_id
      WHERE r.id=target AND t.project_id=project_in AND r.state='staging_queued')
    WHEN 'preflight' THEN maintenance_owner(project_in) AND EXISTS(
      SELECT 1 FROM maintenance_releases r JOIN maintenance_connections c ON c.id=r.target_id
      WHERE r.id=target AND c.project_id=project_in AND r.state='preparing' AND c.revoked_at IS NULL)
    WHEN 'production' THEN maintenance_owner(project_in) AND EXISTS(
      SELECT 1 FROM maintenance_releases r JOIN maintenance_connections c ON c.id=r.target_id
      WHERE r.id=target AND c.project_id=project_in AND r.state='verifying' AND c.revoked_at IS NULL)
    ELSE false END) THEN RAISE EXCEPTION 'Maintenance action is not permitted' USING ERRCODE='42501'; END IF;
  INSERT INTO maintenance_jobs(kind,project_id,connection_id,run_id,release_id,requested_by)
    VALUES(kind_in,project_in,CASE WHEN kind_in='test' THEN target END,
      CASE WHEN kind_in IN ('investigate','staging') THEN target END,
      CASE WHEN kind_in IN ('preflight','production') THEN target END,actor())
    ON CONFLICT DO NOTHING RETURNING id INTO queued;
  RETURN queued;
END $$;

CREATE FUNCTION maintenance_claim() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE job maintenance_jobs%ROWTYPE; payload jsonb;
BEGIN
  SELECT * INTO job FROM maintenance_jobs WHERE state='queued' OR (state='running' AND lease_until<=clock_timestamp())
    ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE maintenance_jobs SET state='running',lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '240 seconds',
    attempts=attempts+1 WHERE id=job.id RETURNING * INTO job;
  UPDATE maintenance_runs SET state=CASE WHEN job.kind='investigate' THEN 'investigating' ELSE 'verifying_staging' END WHERE id=job.run_id;
  SELECT jsonb_build_object('job',to_jsonb(job),'run',to_jsonb(r),'release',to_jsonb(rel),'ticket',t.subject,
    'original_report',(SELECT left(m.body,2400) FROM messages m WHERE m.ticket_id=t.id AND NOT m.internal ORDER BY created_at LIMIT 1),
    'project',to_jsonb(p),'connection',to_jsonb(singlec),'github',to_jsonb(g),'agent',to_jsonb(a),'staging',to_jsonb(s),
    'production',to_jsonb(prod),'newer_candidate',EXISTS(SELECT 1 FROM maintenance_runs latest
      WHERE latest.task_id=r.task_id AND latest.created_at>r.created_at AND latest.proposed_sha IS NOT NULL),'monitor',to_jsonb(mon),'workflow',to_jsonb(w))
    INTO payload
    FROM projects p LEFT JOIN maintenance_connections singlec ON singlec.id=job.connection_id AND singlec.revoked_at IS NULL
    LEFT JOIN maintenance_releases rel ON rel.id=job.release_id
    LEFT JOIN maintenance_runs r ON r.id=coalesce(job.run_id,rel.run_id)
    LEFT JOIN tickets t ON t.id=r.ticket_id
    LEFT JOIN maintenance_connections g ON g.id=r.github_connection AND g.revoked_at IS NULL
    LEFT JOIN maintenance_connections a ON a.id=r.agent_connection AND a.revoked_at IS NULL
    LEFT JOIN maintenance_connections s ON s.id=r.staging_connection AND s.revoked_at IS NULL
    LEFT JOIN maintenance_connections prod ON prod.id=rel.target_id AND prod.revoked_at IS NULL
    LEFT JOIN monitors mon ON mon.id::text=coalesce(prod.configuration->>'monitor',s.configuration->>'monitor')
      AND mon.project_id=job.project_id AND mon.environment=CASE WHEN rel.id IS NULL THEN 'Staging' ELSE 'Production' END
    LEFT JOIN workflows w ON w.id=mon.workflow_id WHERE p.id=job.project_id;
  RETURN payload;
END $$;

CREATE FUNCTION maintenance_finish(job_id uuid,token uuid,result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=workspace_private,pg_temp AS $$
DECLARE job maintenance_jobs%ROWTYPE; checks jsonb; item jsonb;
BEGIN
  SELECT * INTO job FROM maintenance_jobs WHERE id=job_id AND state='running' AND lease=token AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE maintenance_jobs SET state='complete',finished_at=clock_timestamp(),lease=NULL,lease_until=NULL WHERE id=job.id;
  IF job.kind='test' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(coalesce(result->'capabilities','[]'::jsonb)) LOOP
      INSERT INTO maintenance_capabilities(connection_id,capability,state,detail)
        VALUES(job.connection_id,item->>'capability',item->>'state',left(item->>'detail',500))
        ON CONFLICT(connection_id,capability) DO UPDATE SET state=excluded.state,detail=excluded.detail,checked_at=clock_timestamp();
    END LOOP;
  ELSIF job.kind='investigate' THEN
    UPDATE maintenance_runs SET state=result->>'state',base_sha=result->>'base',proposed_sha=result->>'sha',
      pull_request=(result->>'pull')::integer,evidence=result->'evidence',finished_at=clock_timestamp() WHERE id=job.run_id;
    IF result->>'sha' IS NOT NULL THEN
      UPDATE maintenance_capabilities SET state='verified',detail='Created a maintenance branch and pull request.',checked_at=clock_timestamp()
        WHERE connection_id=(SELECT github_connection FROM maintenance_runs WHERE id=job.run_id) AND capability='Prepare pull request';
      UPDATE maintenance_capabilities SET state='verified',detail='Generated an in-scope PHP proposal that passed syntax checks.',checked_at=clock_timestamp()
        WHERE connection_id=(SELECT agent_connection FROM maintenance_runs WHERE id=job.run_id) AND capability='Propose a PHP fix';
    END IF;
  ELSIF job.kind='staging' THEN
    UPDATE maintenance_runs SET state=result->>'state',staged_sha=result->>'sha',
      evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('staging',result->'evidence'),
      verified_at=CASE WHEN result->>'state'='ready' THEN clock_timestamp() END WHERE id=job.run_id;
  ELSE
    INSERT INTO maintenance_release_checks(release_id,job_id,state,observed_sha,evidence)
      VALUES(job.release_id,job.id,result->>'state',result->>'sha',result);
    UPDATE maintenance_releases SET state=result->>'state',published_sha=result->>'sha',verification=result->>'verification',
      evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object('latestCheck',result->'evidence'),
      verified_at=CASE WHEN result->>'state'='verified' THEN clock_timestamp() END WHERE id=job.release_id;
  END IF;
  RETURN true;
END $$;

CREATE POLICY runs_create ON maintenance_runs FOR INSERT WITH CHECK(
  requested_by=actor() AND state='queued' AND EXISTS(
    SELECT 1 FROM maintenance_tasks mt JOIN maintenance_task_tickets link ON link.task_id=mt.id
    JOIN maintenance_connections g ON g.id=github_connection AND g.project_id=mt.project_id AND g.provider='github' AND g.revoked_at IS NULL
    JOIN maintenance_connections a ON a.id=agent_connection AND a.project_id=mt.project_id AND a.provider='agent' AND a.revoked_at IS NULL
    JOIN maintenance_connections s ON s.id=staging_connection AND s.project_id=mt.project_id AND s.provider='cpanel'
      AND s.environment='Staging' AND s.revoked_at IS NULL
    WHERE mt.id=task_id AND link.ticket_id=maintenance_runs.ticket_id
       AND (mt.assigned_to=actor() OR maintenance_owner(mt.project_id))
  )
);
CREATE POLICY runs_stage ON maintenance_runs FOR UPDATE USING(
  state IN ('awaiting_staging','ready') AND EXISTS(SELECT 1 FROM maintenance_tasks mt WHERE mt.id=task_id)
) WITH CHECK(state='staging_queued' AND EXISTS(SELECT 1 FROM maintenance_tasks mt WHERE mt.id=task_id));
CREATE POLICY release_create ON maintenance_releases FOR INSERT WITH CHECK(
  approved_by=actor() AND state='approved' AND EXISTS(
    SELECT 1 FROM maintenance_runs r JOIN maintenance_tasks task ON task.id=r.task_id
    JOIN maintenance_connections c ON c.id=target_id AND c.project_id=task.project_id
      AND c.provider='cpanel' AND c.environment='Production' AND c.revoked_at IS NULL
    WHERE r.id=run_id AND r.state='ready' AND r.staged_sha=commit_sha AND r.proposed_sha=commit_sha
      AND maintenance_owner(task.project_id)
  )
);
CREATE POLICY release_edit ON maintenance_releases FOR UPDATE USING(
  EXISTS(SELECT 1 FROM maintenance_connections c WHERE c.id=target_id AND c.revoked_at IS NULL AND maintenance_owner(c.project_id))
) WITH CHECK(state IN ('preparing','verifying'));
GRANT INSERT(task_id,ticket_id,requested_by,github_connection,agent_connection,staging_connection,prompt) ON maintenance_runs TO workspace_app;
GRANT UPDATE(state) ON maintenance_runs TO workspace_app;
GRANT INSERT(run_id,target_id,commit_sha,approved_by,previous_sha) ON maintenance_releases TO workspace_app;
GRANT UPDATE(state) ON maintenance_releases TO workspace_app;

CREATE POLICY jobs_read ON maintenance_jobs FOR SELECT USING(project_allowed(project_id,true));
ALTER TABLE maintenance_jobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT(id,kind,connection_id,run_id,release_id,state,attempts,created_at,finished_at) ON maintenance_jobs TO workspace_app;
REVOKE ALL ON FUNCTION maintenance_queue(text,text,uuid),maintenance_claim(),maintenance_finish(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_queue(text,text,uuid) TO workspace_app;
GRANT EXECUTE ON FUNCTION maintenance_claim(),maintenance_finish(uuid,uuid,jsonb) TO workspace_maintenance_worker;

CREATE TABLE maintenance_release_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES maintenance_releases,
  job_id uuid NOT NULL UNIQUE REFERENCES maintenance_jobs, state text NOT NULL, observed_sha text,
  evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenance_release_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY release_history ON maintenance_release_checks FOR SELECT USING(
  EXISTS(SELECT 1 FROM maintenance_releases r WHERE r.id=release_id)
);
GRANT SELECT ON maintenance_release_checks TO workspace_app;
CREATE TABLE maintenance_task_incidents (
  task_id uuid REFERENCES maintenance_tasks, incident_id uuid REFERENCES incidents,
  PRIMARY KEY(task_id,incident_id)
);
ALTER TABLE maintenance_task_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_incidents_read ON maintenance_task_incidents FOR SELECT USING(
  EXISTS(SELECT 1 FROM maintenance_tasks t WHERE t.id=task_id)
);
CREATE POLICY task_incidents_link ON maintenance_task_incidents FOR INSERT WITH CHECK(
  EXISTS(SELECT 1 FROM maintenance_tasks t JOIN monitors m ON m.project_id=t.project_id JOIN incidents i ON i.monitor_id=m.id
      WHERE t.id=task_id AND i.id=incident_id)
);
GRANT SELECT, INSERT ON maintenance_task_incidents TO workspace_app;

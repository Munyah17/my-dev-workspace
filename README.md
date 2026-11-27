# MyDev Workspace

Phase 1 provides Today, Client inbox, and Private maintenance in one React and Vite application. The Node API persists tickets, replies, attachments, statuses, and notification read state. Hosted workspaces use Supabase Auth and Supabase Postgres. The labeled demo uses a separate embedded Postgres database with the same row policies.

## Run the demo

```sh
npm ci
npm run demo
```

Choose **The Gents** to report a staff-record issue. Use a second browser profile as **Agency** to reply. **Harbor Studio** has access to its own project for the isolation check. Demo reports and replies persist in `.data/demo`.

## Configure a real workspace

1. Create the Phase 1 users in Supabase Auth and collect their Auth user IDs.
2. Use the project's administrative Postgres connection string as `SUPABASE_ADMIN_DATABASE_URL` when running `npm run provision`. Pass the workspace JSON on standard input. The provisioner installs the private schema and creates memberships and project grants in one transaction. Supported role values are `owner`, `support`, `finance`, `client_manager`, `client_member`, and `assistant`. Phase 1 ticket access is granted to owners, assigned support accounts, and clients assigned to projects in their own organization.
3. In Supabase, configure `workspace_gateway` as a login role with a unique password. Keep the runtime connection under that role and use a TLS-verified database connection. The gateway authenticates sessions and switches to `workspace_app` inside request transactions. Application rows are read and written under row policies. Keep `workspace_private` outside the Supabase Data API's exposed schemas.
4. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_DATABASE_URL` on the backend. Run `npm run build` and `npm start` behind an HTTPS reverse proxy. Point both phone and desktop to the same origin.

Example provisioning input. Replace the example Auth ID with the real user's ID and add each authorized client and support account with its project grants.

```json
{
  "workspace": { "id": "agency", "name": "MyDev Workspace" },
  "organizations": [{ "id": "client", "name": "Client name" }],
  "projects": [{ "id": "site", "name": "Client site", "organization": "client" }],
  "accounts": [
    {
      "id": "owner",
      "email": "owner@example.com",
      "name": "Workspace owner",
      "role": "owner",
      "authUserId": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

## Smoke checks

- `npm test` runs the API and row-policy checks against persistent local Postgres. It covers The Gents' report, agency notification and reply, private notes, attachment downloads, search and deep link isolation, and fresh sign-ins after a backend restart. It also checks invoice and renewal independence and cash totals by currency.
- `npm run smoke:web` starts the production build in demo mode and runs the Chromium PWA and responsive browser checks. Install Chromium with `npx playwright install chromium` first. The test uses a phone-sized browser context, a separate desktop agency session, and a second client's session.
- `npx --yes @tauri-apps/cli@2 dev` opens the Tauri dev shell against the local demo. The Phase 1 GitHub Actions workflow builds a Windows NSIS and macOS app smoke bundle. The smoke bundle checks packaging and shell launch. The shared hosted backend connection and signed installers are release work.

## Deployment pilot

Phase 3 will start on controlled staging with The Gents staff-record persistence fixture. Use the target's existing mechanisms and record the chosen method per environment.

| Target | Existing mechanism to evaluate during onboarding |
| --- | --- |
| cPanel PHP, HTML, or JavaScript | cPanel Git Version Control and `.cpanel.yml` where supported. Use the panel's pull and deploy workflow where that is the supported path. |
| DirectAdmin | Use the provider's Git integration or approved restricted SSH/SFTP workflow where available. |
| Plesk | Use the Git extension with its supported automatic or manual deployment mode. |
| Static sites | Use the host's Git integration, deploy hook, or restricted file transfer. |

When a host supports incremental transfer, transfer only the reviewed changes. Record the reviewed commit, preserve runtime configuration and persistent data, and verify the original behavior after release. Host deployment, agent execution, uptime scheduling, email delivery, and commercial screens are outside the implemented Phase 1 slice.

### Verification in this workspace

The Vite build, lint, persistent API and policy tests, and desktop smoke asset build passed. Playwright discovered the browser test. The managed environment denied the loopback port bind before Chromium could run it. Native Windows and macOS packaging awaits the CI runners. Hosted authentication and database access await a configured Supabase project and provisioned pilot accounts.

## Vercel Services

Import the repository root as one Vercel project. The `app` service builds the Vite UI. The `api` service runs the existing API through an Express entry point. Vercel sends browser requests under `/api/` to the API on the same origin, including attachment downloads. The frontend is static and the API calls external Supabase services, so this deployment has no server-to-server binding. Desktop packaging runs through the Tauri CI workflow.

Provision Supabase as described above. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_DATABASE_URL` for the appropriate Vercel environments. Keep administrative database credentials outside Vercel. For local routing tests, link the project with the current Vercel CLI and run `vercel dev`. Open the CLI-reported URL and check `/api/config` and the sign-in page on the same origin. Use `npm run demo` for isolated local demo sign-in. The Vercel runtime disables demo authentication.

## Phase 2 monitoring

The Vercel API and Fly worker share the Supabase monitoring records. The worker has separate availability and Chromium lanes and keeps running when all MyDev clients are closed. In **Apps → Monitoring**, select a project and environment, then add an HTTPS availability check or a saved browser workflow. Technical evidence is agency-only. To communicate with a client, link their ticket and publish a plain-language update.

### Migrate and deploy

1. After provisioning Phase 1, apply the additive schema with `SUPABASE_ADMIN_DATABASE_URL` set and run `npm run monitor:migrate`. This preserves existing accounts and conversations. Until the migration is present, Phase 1 remains available and Apps displays the migration status.
2. In Supabase, give `workspace_monitor_worker` its own login and password. Set `MONITOR_DATABASE_URL` to the SSL-verified connection using that role. It can claim, finish, and report worker jobs through the monitoring functions. The Vercel API keeps its existing gateway role.
3. In the intended Fly organization, use the confirmed MyDev worker app name. The name in `fly.toml` is a template. Import `MONITOR_DATABASE_URL` and any workflow secrets with `fly secrets import --app "$MYDEV_MONITOR_FLY_APP"`. Run `fly deploy --app "$MYDEV_MONITOR_FLY_APP" --ha=false` from the repository root. Check `fly machine list --app "$MYDEV_MONITOR_FLY_APP"` for one started Machine. The worker exposes no HTTP listener and the Fly configuration has no idle auto-stop.
4. Open the same HTTPS workspace in the mobile PWA and desktop clients. Build Tauri with `WORKSPACE_DESKTOP_URL` set to that origin to load it in the Windows and macOS shells. An unset value retains the desktop smoke shell or local development frontend.

### Workflow credentials

Fly secret names follow `MONITOR_SECRET_<UPPERCASE PROJECT ID IN HEX>_<ENVIRONMENT>_<SECRET NAME>`. For `gents-staff` on Staging with `STAFF_TEST`, use `MONITOR_SECRET_67656E74732D7374616666_STAGING_STAFF_TEST`. The JSON value has an `origin` matching the monitor origin and a `values` object. Fill steps reference the fields by name. Credential-related steps should specify `"credential": true` so a failed sign-in is classified appropriately. The worker saves short result descriptions and never saves screenshots, console text, raw responses, or secret values.

Staging is the default for write-capable workflows. Production requires a matching origin, a dedicated test account and record named by the `TEST_ACCOUNT` and `TEST_RECORD` secret fields, exact `signInPaths`, `writePaths`, and `cleanupPaths` arrays, and cleanup steps that end in a verification assertion. Configure the target app to restrict the test account to its test records and operations. Cleanup is attempted after a write and failed cleanup becomes a monitor alert.

### The Gents staging pilot

Serve `node fixtures/gents/server.js` on a controlled public staging HTTPS origin with `FIXTURE_PASSWORD` and `FIXTURE_CONTROL_TOKEN` set. The fixture uses disposable in-memory data. Import the steps for [the fixture workflow](fixtures/gents/workflow.json) into Apps and configure its test account as `mydev-staff-test` and its record as `MyDev Test Barber`. Add an availability monitor for the fixture homepage and a workflow monitor on the same origin.

The fixture starts in `lost` mode. Its bearer-protected `POST /control` accepts a form field called `mode` with `lost`, `saved`, or `expired`. Close the MyDev clients and wait for two scheduled workflow failures and a healthy homepage observation. Reopen Today to check the single incident. Restart the same Machine, then switch to `saved` and wait for scheduled recovery. Use `expired` to check monitor alerts, stop the Machine to observe stale monitoring, and schedule a maintenance window to check suppression. Use a second client account to verify ticket and monitoring isolation.

Locally, `npm test` checks Phase 1 regression, destination validation, durable job and lease behavior, incident and alert deduplication, maintenance suppression, coverage gaps, and tenant isolation. Run `MONITOR_BROWSER_TEST=1 node --test fixtures/gents/browser.test.js` with Playwright Chromium installed for the controlled browser scenario. The local browser test replaces the production socket transport with a loopback fixture. The live Fly and Supabase staging acceptance check remains separate.

Phase 2 verification passed locally with embedded Postgres and Chromium. Both browser smoke tests passed, including the Phase 1 mobile-to-desktop ticket flow and agency monitor creation, queuing, and second-client isolation. The separate Chromium fixture test passed for lost records, verified persistence in a fresh session, and rejected credentials. Fly deployment, Supabase staging, and native desktop packaging remain unverified.

## Brand assets

Use the [horizontal logo](public/mydev-workspace-logo.png) where the full name is legible and the [emblem](public/icon-512.png) for launchers and compact spaces. Give the mark clear space equal to at least one-quarter of the emblem width. In maintenance reports, use the full logo. In quotes and invoices, lead with the issuing agency’s name and logo and credit MyDev Workspace as the software. Use specific, actionable notification copy such as “The Gents · Staff sign-in failed at 09:14” with “Review incident”.

## Phase 3 maintenance pilot

This phase builds on the ticket system, existing project permissions and monitoring workflows, and the Fly worker. The first release route is manual cPanel Git deployment with preflight and post-release verification.

1. Run `npm run maintenance:migrate` against the intended Supabase workspace using its administrative connection. Give `workspace_maintenance_worker` a scoped login and set `MAINTENANCE_DATABASE_URL` on the Fly worker. Keep the Phase 2 monitor connection separately configured.
2. In Workspace settings, register the authorized GitHub App installation, repository and branch for the project. Restrict the repository to the PHP files that the investigation may read or propose changes to. Successful registration and read tests leave pull-request capability unverified until a real pull request is created.
3. Register the agency’s OpenAI model and credential reference for each explicitly authorized project. GitHub, cPanel, and agent credential values belong in Fly secrets. For a credential reference called `PILOT`, use these names and JSON fields.

   | Credential | Fly secret name | JSON fields |
   | --- | --- | --- |
   | GitHub | `MAINTENANCE_GITHUB_<UPPERCASE PROJECT ID IN HEX>_PILOT` | `appId`, `privateKey` |
   | Maintenance agent | `MAINTENANCE_AGENT_<UPPERCASE WORKSPACE ID IN HEX>_PILOT` | `apiKey` |
   | cPanel | `MAINTENANCE_CPANEL_<UPPERCASE PROJECT ID IN HEX>_PILOT` | `username`, `token` |

4. Register each cPanel site and environment with its document root, cPanel Git repository root, verified baseline, runtime exclusions, and existing monitor. The cPanel service origin must support HTTPS UAPI on its port-443 service subdomain. The deployed site must serve `/release.json` with the current `commit` SHA. Generate that marker only after the host’s release steps complete successfully. Confirm the installed Git baseline and preserve server configuration, uploads, and persistent data in the site's deployment recipe.
5. Open the ticket in Private maintenance. Create or link a task, choose its owner, then submit a scoped staging investigation. MyDev records either a reproduction and proposal, or what blocked the investigation. Review the draft PR and deploy the proposed SHA to staging through the site's approved procedure. Verify staging before approving that same SHA and production target.
6. Start the release to run preflight. The release lists the approved SHA and target before the operator uses cPanel Git Version Control to release it. Verify the target afterward. The known previous SHA is reference evidence for the site's existing rollback procedure. Automated Git push and rollback require a supported host path and are not part of this manual pilot. Use the original ticket to publish the client update.

The [Gents PHP fixture](fixtures/gents-php) accepts only the named test account `mydev-staff-test` and record `MyDev Test Barber`. Host it on disposable HTTPS staging, set `GENTS_FIXTURE_PASSWORD` and `GENTS_FIXTURE_DATA` to a writable directory outside the document root, and import the [PHP fixture workflow](fixtures/gents-php/workflow.json) in Apps. Use its final assertion label as the expected failure step in the staging connection. Setting `GENTS_FIXTURE_MODE=lost` makes the row appear in its original session but disappear after a fresh sign-in. The corrected fixture uses durable storage. For an actual candidate test, put the session-only baseline in a staging branch and verify a reviewed code change that reaches the durable storage path.

Local verification passed in embedded Postgres, Chromium, and a temporary PHP 8.3 runtime. The database test used simulated worker responses for provider operations and verified scope, recovered leases, approval gating, manual verification states, and failed production checks. The PHP runtime reproduced baseline loss and verified corrected persistence and branch assignment across separate sign-ins. Live GitHub, OpenAI, cPanel, Supabase, and Fly operations require the intended environment and credentials.

## Later phases

- [Phase 4 implementation brief](docs/phase-4.md)
- [Phase 5 implementation brief](docs/phase-5.md), which depends on the Phase 4 commercial records and migrations.
- [Phase 6 implementation brief](docs/phase-6.md)

## Phase 4 billing

CRM uses the existing client organizations. Billing supports draft and issued quotations and invoices, client acceptance, quote conversion, manual receipts, and independent renewal reminders. The client portal shows issued documents to an authorized client manager. Use the document’s **Print or save as PDF** action to export using the browser.

Configure the confirmed Supabase project URL and publishable key together with the scoped `SUPABASE_DATABASE_URL` for the app. For an existing provisioned database, set the administrative Postgres connection as `SUPABASE_ADMIN_DATABASE_URL` in the migration environment and run `npm run billing:migrate`. For a fresh database, provision the workspace first. A Supabase API key does not supply the PostgreSQL connection required by these migrations.

For unattended reminder generation, configure the `workspace_billing_worker` login and pass its scoped connection as `BILLING_DATABASE_URL` to the existing Fly worker. Today also materializes due reminders when opened. Both paths use the same unique service and due-date key. Reminder records do not create payments or expenses.

## Phase 5 orders and inventory

Convert an accepted quote from Billing or Orders. The order keeps the original line descriptions, quantities, prices, discounts, tax, and total. Classify each line before fulfillment. For a physical line, receive stock, reserve a unit, and confirm delivery. Serialized units are unique per workspace. The database creates an immutable stock movement for each change. Service lines complete independently of stock. Completed recurring lines can start a scheduled collection in Billing.

Transactions combines issued invoices, manually recorded receipts, and supplier expenses by currency. Order totals do not add a second sale to that report. An expense can include a private receipt and a project or supplier subscription link. A supplier reminder does not post an expense or payment.

For other environments, apply `npm run operations:migrate` after the billing schema. The Phase 5 migration was applied to MyDev Workspace Supabase project `tmtxchjvlkaemtimzwbc`. The live schema reports 10 operational tables with row-level security and the stock audit trigger. Operational workflow tests use embedded Postgres and the local demo browser.

## AI tools and Accounts & ERP

Workspace Settings includes Devin, Cursor, Claude, Codex, ChatGPT, Vercel, Supabase, Cloudflare, Firebase, and Netlify. Workspace owners can select **Add integration**, paste a scoped API key or access token, save, and test the connection. The backend encrypts saved credentials using a stable `WORKSPACE_CREDENTIALS_KEY` (at least 24 characters of random material) or a high-entropy database connection password. If credential storage uses the database password, resave provider keys after changing it. Server environment references are also supported and the setup card shows the exact variable name. Devin requires an organization ID and Claude requires a model ID. MyDev links Devin and Cursor sessions to tasks and reads their current status. Claude, Codex, and ChatGPT can answer task prompts inside MyDev. Codex and ChatGPT use OpenAI API model IDs and an API project key. Their task prompts run through the API. Linked Devin and Cursor work is started in those products.

Infrastructure checks read one scoped resource. Use a Vercel project ID with an optional team ID separated by `/`, a Supabase project reference, a Cloudflare zone ID, a Firebase project ID, or a Netlify site ID. Use a credential with the narrowest read access the provider supports. Firebase expects a Google OAuth access token with read access to the selected project.

Accounts & ERP groups CRM, quotations, invoices, orders, inventory, transactions, billing service defaults, printable document generators, and private HR records. Credit and debit notes are printable records. Their creation leaves the invoice ledger unchanged. Payroll records use entered base earnings and deductions plus approved bonuses and reported hours. Tax calculation, filing, and payment remain separate.

The platform portal has a separate database-only administrator grant in `workspace_private.platform_administrators`. An agency owner does not inherit it. The portal shows workspace counts, plan, and lifecycle metadata with audit history. It does not charge tenants or enforce a suspension.

Apply `npm run workspace-tools:migrate` after the maintenance and billing schemas in a new environment.

### Hosting, collections, and Sentry

Workspace owners can connect WHM and cPanel with the hosting account API token and a public hostname/username. MyDev reads WHM accounts on port 2087 and cPanel domains on port 2083. The hosting connection requires valid TLS and a public DNS address. Existing project release targets and deployment approvals are managed separately.

Collections reporting reads captured live Stripe charges using a restricted key and its matching Stripe account ID. The first version supports one Stripe account per workspace. App and business filtering matches the `app` metadata on the charge. Refunds are attributed to the original charge date. Paynow entries are manually recorded from settlement records using the unique provider reference. Collections are separated by currency and do not change invoice balances. Provider fees, payouts, and automatic Paynow sync are outside this report.

A Sentry project connection reads unresolved issues on sentry.io. Use the organization/project slug and a read token with project and event access. Opening an issue task assigns it to the workspace owner who created it. The same project issue opens the existing task on retry.

### Cloud VPS pilot

Cloud VPS is disabled for provisioning by default. Workspace owners manage temporary Linux machines from the shared interface. A platform administrator records a USD credit only after confirming settlement outside MyDev. Wallet deductions and refunds use a ledger. The pilot reserves rounded-up maximum compute cost at 130% of the configured Fly compute rate and settles elapsed time rounded up to a minute after confirmed destruction. The configured rate is a published-rate estimate. Fly invoice reconciliation, paid IPs, network charges, regional taxes, persistent storage and automatic payment top-ups are outside the pilot.

Apply the additive schema with `node server/migrate.js --vps` and the intended administrative database connection. Create a dedicated login granted `workspace_vps_worker` and set its connection as `VPS_DATABASE_URL` on the Fly worker. Build and publish the image in `vps-guest` and configure `VPS_GUEST_IMAGE` with its immutable reference and `VPS_FLY_REGION`. Set worker-only `VPS_FLY_TARGETS` to a JSON object keyed by workspace ID, with an `app`, an app-scoped Fly `token`, and a public SSH `host` per workspace. Use a dedicated Fly app on an isolated network per workspace, separate from the monitoring worker, with TCP ingress on port 22 tested. The guest has root access by SSH key, so put no platform secrets or shared workloads in its network. Run one VPS worker replica for the pilot.

Enable only a verified workspace by setting `VPS_PROVISIONING_ENABLED=true`, `VPS_ENABLED_WORKSPACES` to approved comma-separated IDs, and `VPS_BASE_HOURLY_MICRO_USD` to the applicable hourly compute rate in millionths of one USD on the API. Verify expiration, early termination, wallet settlement and ambiguous-create reconciliation in staging first. A rental marked Needs review retains its reservation pending provider reconciliation. The pilot supports one ephemeral rental per workspace and ends it by destroying the machine.

### NGINX and stack releases

The VPS guest image includes NGINX on port 8080 with document root `/srv/www`. Fly terminates HTTPS at port 443 for the configured app. Build and publish a new guest image before updating the worker's pinned image reference. Place the built static site in `/srv/www` using the guest's SSH access. The starter returns HTTP 404 until a site is installed. A VPS remains ephemeral. Verify HTTPS, SSH, and expiration together in an isolated staging app before enabling rentals.

In Workspace Settings, add **GitHub Actions** using a fine-grained token scoped to a single repository with Actions write permission and enter `owner/repo/ref`. This first version supports a simple branch or tag name for the workflow ref. Add an active `.github/workflows/mydev-release.yml` in that repository with a `workflow_dispatch` trigger declaring required string inputs `revision` and `request_id`. The workflow must validate and check out the full SHA in `inputs.revision`, run checks, and configure each authorized target as a deployment job. Keep deployment credentials in repository or protected environment secrets and require production approvals in GitHub. Use `request_id` to correlate logs. The source workflow handles provider-specific steps, including SSH upload to an NGINX server where configured.

After verifying the connection, **Deploy your stack** dispatches that workflow from MyDev. The connection check verifies the workflow is active. Dispatch acceptance confirms GitHub received the request. Use the workflow runs link for results on each target. MyDev records an intent before dispatch, suppresses repeats for the same workspace, scope and revision, and leaves ambiguous requests for review in GitHub. Apply `node server/migrate.js --stack-deploy` before deploying to a new environment.

### Bring your own development stack

In Workspace Settings, **Build a multi-target release workflow** generates a GitHub Actions starter for Vercel, Cloudflare Workers, Firebase Hosting, or a repository-provided deployment script. The starter expects a Node project, a committed package lockfile, and an npm test script. It checks that the requested SHA belongs to the release ref's history, tests that SHA, and checks out the same SHA in each selected deployment job. The jobs have separate GitHub environments. Pre-create and protect those environments, install each required CLI in the lockfile, and configure the named provider variables and credentials. Run staging first with its own provider projects. Use **Check target results** to see matched GitHub job statuses in MyDev. Success there reflects the workflow job result. Add a smoke check in the deployment job to verify the target itself.

Developers can work in their preferred editor or agent against that same repository. Tools that export or sync code to GitHub can use the same pipeline. A fix that produces a new commit uses the same release action and configuration. For xAI prompts, connect **Grok** using an API key and model ID available to that key. This API connection is separate from Grok Build and bot sessions. MyDev does not install or run third-party IDEs.

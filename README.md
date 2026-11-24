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

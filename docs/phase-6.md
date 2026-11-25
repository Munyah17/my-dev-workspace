# MyDev Workspace — Phase 6: Windows, macOS, and mobile release

Continue from the existing MyDev Workspace repository. Inspect its frontend, Supabase configuration, Fly.io worker, deployment setup, and current build status before making changes. Preserve the approved interface and all working monitoring, maintenance, CRM, billing, inventory, support, and task workflows.

Build on the existing shared React and Vite frontend. Use Tauri for Windows and macOS desktop packaging if that matches the current implementation. Serve the PWA from the configured web host over HTTPS. Reuse the existing Supabase backend and Fly.io worker. Do not replace them or create parallel data stores.

## 1. Windows desktop app

- Build a signed, installable Windows package using the project’s existing Tauri setup.
- Show MyDev Workspace in the Start menu and app launcher, using the approved cobalt waveform icon.
- Preserve login, app monitoring, tickets, private maintenance, tasks, CRM, billing, and notifications.
- Support desktop notifications where permitted. Clicking a notification should open the relevant incident, ticket, or reminder.
- Provide a clear update flow, show the installed version, and recover cleanly if an update is interrupted.
- Keep background monitoring on Fly.io. The Windows app must not need to remain open.

## 2. macOS desktop app

- Build a signed macOS app package using the same frontend and backend.
- Use the approved icon in the app bundle and Dock.
- Preserve the same workflows and account data as Windows.
- Support macOS notifications where permitted and route notification clicks to the relevant record.
- Provide a clear update flow and show the installed version.
- Identify any signing credentials or Apple Developer setup required for distribution. Do not report the app as signed or ready for public distribution unless the actual signed package has been produced and verified.

## 3. Mobile PWA

- Make the existing mobile layout installable on iPhone and Android from the hosted HTTPS site.
- Provide the manifest, icons, theme colors, and standalone launch behavior.
- Keep the agency’s mobile Today view and client-facing support conversation from the approved mockups.
- Support responsive incident review, ticket replies, task updates, approval visibility, and renewal reminders.
- Cache the application shell and clearly show offline or stale-data status.
- Queue safe text drafts locally only if they can be clearly marked unsent. Do not report a ticket reply, approval, payment, or deployment action as successful until the server confirms it.
- Implement push notifications only where supported and enabled. In-app and email notifications must remain available if browser push is not enabled.

## 4. Shared sessions and data

- Use the same Supabase account and workspace permissions across desktop and PWA.
- Keep secrets, agent credentials, and database credentials out of the installed frontend.
- Handle expired sessions, sign-out, revoked access, and workspace switching consistently across platforms.
- Ensure notification deep links open the correct screen after login and never bypass authorization.
- Provide clear recovery when a device has been offline and its displayed data is stale.
- Keep monitoring, scheduled reminders, browser checks, agent jobs, and deployments running independently of any user device.

## 5. Release and update process

- Create reproducible build commands and documented release steps for the Windows installer, macOS package, and PWA.
- Record app version, build identifier, release date, and environment.
- Keep release artifacts associated with the source revision used to build them.
- Add an update notice inside the app when a newer desktop release is available.
- Roll out updates safely and preserve local preferences and session handling.
- Do not send users to download pages or publish public store listings unless those destinations and credentials are configured.
- If signing, notarization, push certificates, or store credentials are unavailable, produce the build where possible and state exactly which distribution step remains blocked.

## 6. Acceptance checks

Verify that:

1. Windows and macOS desktop builds load the same account and workspace records as the PWA.
2. A ticket reply made on mobile appears on desktop after server confirmation.
3. A desktop notification opens the correct authorized record.
4. A client account cannot open agency-only notes, agent logs, releases, billing, or another client’s data through deep links.
5. The PWA can be installed and launched in standalone mode on supported mobile browsers.
6. Going offline shows a clear stale or offline state and does not falsely confirm unsent actions.
7. Closing all desktop and mobile apps does not stop Fly.io monitoring, scheduled checks, or renewal reminders.
8. A desktop update preserves the user’s settings and allows sign-in afterward.
9. The PWA works at common phone widths without clipped navigation, unreadable tables, or overlapping content.
10. Existing monitoring, ticket, maintenance, CRM, billing, task, and inventory workflows remain usable on their supported screens.

## Delivery report

List each artifact produced and its version. State which builds were completed, which platforms were actually tested, and whether the PWA was deployed. Distinguish local build verification from signed distribution and live deployment. Identify any remaining dependency such as Apple signing credentials or push configuration.

# MyDev Workspace — Phase 4: CRM, quotes, invoices, and renewals

Continue from the existing MyDev Workspace project. First inspect the code, current database, and deployed environments. Reuse working authentication, workspace membership, client organizations, projects, tickets, tasks, notifications, and UI components.

Use the project’s Supabase instance for persistent commercial data. If Supabase is not configured, implement the schema, migrations, environment variable checks, and documented setup steps. Do not use mock data for features presented as working. Do not claim Supabase deployment unless migrations have been applied to the intended project and verified.

Preserve the approved MyDev Workspace visual style. In the agency navigation, place CRM and Billing where they already appear in the approved UI. Keep client access limited to their own organization and documents.

## 1. CRM

Implement a client directory with:

- Organization name, contacts, email, phone, address, notes, and status.
- Search, filters, and client detail pages.
- A client timeline showing support conversations, app maintenance, quotations, invoices, payments, and follow-up tasks.
- Links from a client to their apps and services.
- Agency-only notes separated from information visible to the client.
- Optional leads for prospective clients, with contact details, source, status, estimated value, and follow-up date.

CRM records must belong to the agency workspace. Each client organization must be isolated from other clients.

## 2. Quotations

Allow an authorized agency user to create, edit, preview, and issue a branded quotation with:

- Agency identity and client billing details.
- Quote number, issue date, expiry date, currency, description, item quantity, unit price, discount, and configurable tax.
- Subtotal, tax, discount, and total calculated consistently.
- Draft, sent, accepted, declined, and expired statuses.
- PDF download and a client-safe view.
- An acceptance record with timestamp and accepting contact where applicable.

Accepted quotes can be converted into orders or invoices without re-entering the items. Preserve issued quote values if the agency later changes its service prices.

## 3. Invoices, payments, and balances

Implement invoices for one-off services and recurring services.

- Use unique invoice numbers per workspace.
- Support draft, issued, partially paid, paid, overdue, and void states.
- Record issue date, due date, currency, line items, subtotal, tax, total, and balance.
- Support partial and full payments, with date, amount, currency, method, reference, and notes.
- Allocate each payment to an invoice. Do not mark an invoice paid unless its allocated total covers the amount due.
- Generate a PDF and a client-safe invoice view.
- Keep the document values stable after issuance. Use explicit correction or void flows instead of silently changing an issued invoice.
- Do not process or collect a real payment in Phase 4 unless a payment integration is already configured and authorized. Allow manual payment recording.

Show invoiced sales separately from cash received. Do not combine different currencies into one total unless a recorded exchange rate is used.

## 4. Recurring services and reminders

Allow an agency to register services such as website hosting, domain renewal, maintenance retainers, and software subscriptions.

Each recurring record should include:

- Client or supplier, service name, amount, currency, billing interval, next due date, renewal type, and status.
- Whether it is money to collect from a client or money to pay to a supplier.
- Optional linked app, domain, invoice, or project.
- Reminder offsets, including seven days before due date.
- Last payment or collection date and notes.

Keep three events independent: client invoice due, domain expiry, and agency supplier renewal. Paying one must not automatically close the others. Add an optional general business subscription record with no required client or project, so items such as Devin can be tracked.

Generate reminders idempotently. A worker retry must not create duplicate notifications. Show upcoming items on Today with clear actions such as Collect payment, Pay supplier, or Renew domain. If no notification worker is configured, show the reminder in the app and state that push or email delivery is not configured.

## 5. Supabase schema, access, and deployment

Inspect the existing database and add migrations for the missing commercial entities. Reuse existing workspace and client identifiers. Avoid duplicating client or app records.

Use relational tables for clients, contacts, leads if appropriate, quotes, quote items, invoices, invoice items, payments, payment allocations, recurring services, reminders, and audit events. Include workspace ownership and appropriate foreign keys.

Implement and verify access rules so:

- Agency members can access records according to their workspace role.
- Client users can view only their organization’s client-safe quotations and invoices.
- Client users cannot access other clients’ records, agency-only notes, payment credentials, or audit details.
- Privileged operations use authenticated server-side logic. Never expose a Supabase service-role key in the frontend.

Create migrations and deploy them only to the Supabase project configured for this MyDev Workspace environment. Report the project/environment used and migration results. If credentials or project access are unavailable, leave deployment clearly pending and provide the exact setup steps needed.

## 6. Acceptance checks

Verify these cases against the project’s actual Supabase environment:

1. Create a client, contact, service, quote, and invoice. Sign out and back in, then confirm the records persist.
2. Accept a quote and convert it to an invoice without changing line items or totals.
3. Record a partial payment and verify the invoice balance and status.
4. Record the remaining payment and verify the invoice becomes paid.
5. Schedule a seven-day reminder for Devin and confirm one reminder appears on Today.
6. Pay a client hosting invoice while leaving its linked domain renewal open.
7. Confirm a client user can view their own issued invoice and cannot access another organization’s invoice by changing the URL or request identifier.
8. Confirm agency-only notes and payment records are unavailable to client users.
9. Confirm different currencies remain separate without an explicit exchange rate.
10. Confirm existing support, monitoring, maintenance, and task flows continue to work.

## Delivery report

Summarize what was implemented, which Supabase migrations were applied, which environment was verified, and which checks passed. Distinguish local implementation from a live Supabase deployment. Identify any feature that remains unavailable because credentials, provider configuration, or project access are missing.

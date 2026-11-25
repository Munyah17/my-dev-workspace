# MyDev Workspace — Phase 5 implementation

Continue from the existing MyDev Workspace project. Inspect the current app, Supabase schema, and Phase 4 implementation before making changes. Reuse the existing workspace, CRM, quote, invoice, payment, task, notification, and permission records. Do not create mock records or duplicate existing entities.

If Phase 4 or its Supabase migrations are not present, report that dependency and implement Phase 5 only where it can use existing working structures. Do not claim database deployment or successful integration without verifying it against the configured Supabase project.

Preserve the approved MyDev Workspace interface and agency/client access boundaries.

## 1. Orders and fulfillment

Let agency users convert an accepted quote into an order without re-entering the customer or line items.

An order should have:

- Order number, client, source quote, created date, status, line items, total, and notes.
- Item type: physical product, one-time service, or recurring service.
- Fulfillment status and assigned agency team member.
- Optional linked client app, project, support ticket, task, invoice, and payment.
- A history of status changes with actor and timestamp.

Use clear statuses such as Draft, Confirmed, In progress, Partially fulfilled, Fulfilled, Cancelled. An accepted quote should not create duplicate orders if the conversion is retried.

## 2. Inventory

Manage physical goods used or sold by the agency, such as GPS trackers, routers, and installation accessories.

- Products have a name, SKU, category, unit, purchase cost, sale price, reorder level, and active status.
- Track stock through immutable movements such as purchase, reservation, allocation, return, adjustment, and damaged stock.
- Support serial or IMEI numbers where relevant.
- Allow a product to be reserved for an order, then allocated when delivered or installed.
- Show stock on hand, reserved stock, and available stock separately.
- Record supplier, purchase date, cost, and reference for stock receipts.
- Prevent two orders from allocating the same serialized unit.
- Require a reason and audit record for manual adjustments.
- Service items such as hosting and maintenance never affect stock.

## 3. Sales, expenses, and transactions

Keep business performance understandable and auditable.

- Record sales from issued invoices and orders without counting the same sale twice.
- Record cash received through allocated payments separately from invoiced sales.
- Record expenses with supplier, date, category, amount, currency, payment method, reference, and optional app/project allocation.
- Let recurring supplier costs link to Phase 4 subscriptions.
- Support expense attachments such as receipts.
- Provide filters by date, client, supplier, category, project, currency, and status.
- Display totals separately by currency. Convert only when a user supplies an explicit exchange rate and date.
- Show revenue, cash collected, outstanding receivables, expenses, and net cash movement with clear definitions.

Do not present profit as verified if expense or payment data is incomplete. Label reports based on the records included.

## 4. Today and client records

Add concise actions to the existing dashboard:

- Orders awaiting fulfillment.
- Items below reorder level.
- Client invoices due or overdue.
- Expenses or supplier payments due.
- Orders blocked by unavailable inventory.

A client profile should link to their orders, fulfilled products, invoices, payments, apps, and maintenance history. Clients may view only documents and order status explicitly shared with their organization. Inventory costs, supplier records, and agency notes remain private.

## 5. Supabase and reliability

Add migrations for only the missing tables and fields. Reuse Phase 4’s client, quote, invoice, payment, and workspace relationships.

Enforce workspace and client access at the database and server layers. Use transactions or equivalent atomic operations for quote conversion, stock reservation, payment allocation, and serial-number allocation. Make retrying an operation safe so it cannot duplicate an order, payment, or stock movement.

Maintain an audit trail for changes to issued commercial documents, expenses, stock, and order fulfillment. Never store a changing quantity without the corresponding stock movement history.

Deploy migrations only to the Supabase project configured for this MyDev environment. If it cannot be accessed, implement locally and list the exact deployment dependency.

## 6. Acceptance checks

Verify that:

1. An accepted quote converts into one order with identical line items and totals.
2. Retrying the conversion does not create another order.
3. An order reserves the selected tracker and reduces available stock, while preserving total stock.
4. A serialized tracker cannot be reserved or allocated to a second order.
5. Fulfillment records the customer and device identifier.
6. A service-only order does not change inventory.
7. An expense linked to AeroTrack appears in that project’s costs and the business expense report.
8. An invoice payment changes cash received and balance without counting the sale twice.
9. Multi-currency values remain separated unless an exchange rate is explicitly recorded.
10. A client cannot access supplier costs, stock records, other client orders, or private agency notes.
11. Existing CRM, invoices, monitoring, tickets, maintenance, and tasks still work.

## Delivery report

Report the implemented workflows, Supabase migrations and environment verified, acceptance checks completed, and anything still blocked by missing access or provider configuration. Clearly distinguish local tests from verification against the live Supabase project.

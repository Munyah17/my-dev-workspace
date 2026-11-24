import assert from 'node:assert/strict'
import test from 'node:test'
import { cashTotals, invoiceStatus, renewalStatus } from './business.js'

test('an invoice allocation settles the invoice independently of the domain renewal', () => {
  const invoice = { id: 'hosting', status: 'issued', totalMinor: 10000, currency: 'USD', dueDate: '2026-12-01' }
  const allocations = [{ invoiceId: 'hosting', amountMinor: 10000, currency: 'USD' }]
  const renewal = { dueDate: '2026-12-15' }
  assert.equal(invoiceStatus(invoice, allocations, '2026-11-24'), 'paid')
  assert.equal(renewalStatus(renewal, '2026-11-24'), 'open')
})

test('supplier reminders contribute no expense and confirmed cash stays grouped by currency', () => {
  const records = [
    { status: 'reminded', currency: 'USD', direction: 'out', amountMinor: 2000 },
    { status: 'confirmed', currency: 'USD', direction: 'in', amountMinor: 10000 },
    { status: 'confirmed', currency: 'EUR', direction: 'out', amountMinor: 3000 },
  ]
  assert.deepEqual(cashTotals(records), { USD: { received: 10000, paid: 0 }, EUR: { received: 0, paid: 3000 } })
})

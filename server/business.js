export function invoiceBalance(invoice, allocations) {
  const paid = allocations.reduce((total, allocation) => {
    if (allocation.invoiceId !== invoice.id) return total
    if (allocation.currency !== invoice.currency) {
      throw new Error('An allocation must use the invoice currency')
    }
    return total + allocation.amountMinor
  }, 0)
  return invoice.totalMinor - paid
}

export function invoiceStatus(invoice, allocations, today) {
  if (invoice.status === 'draft' || invoice.status === 'void') return invoice.status
  const balance = invoiceBalance(invoice, allocations)
  if (balance <= 0) return 'paid'
  if (invoice.dueDate < today) return 'overdue'
  return balance < invoice.totalMinor ? 'partially paid' : 'issued'
}

export function renewalStatus(renewal, today) {
  if (renewal.confirmedAt) return 'confirmed'
  return renewal.dueDate < today ? 'overdue' : 'open'
}

export function cashTotals(transactions) {
  const totals = new Map()
  for (const transaction of transactions) {
    if (transaction.status !== 'confirmed') continue
    const { currency, direction, amountMinor } = transaction
    const total = totals.get(currency) ?? { received: 0, paid: 0 }
    if (direction === 'in') total.received += amountMinor
    if (direction === 'out') total.paid += amountMinor
    totals.set(currency, total)
  }
  return Object.fromEntries(totals)
}

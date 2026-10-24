import { defineRelations } from "drizzle-orm";

import * as schema from "./";

export const relations = defineRelations(schema, (r) => ({
  firms: {
    members: r.many.members({ from: r.firms.id, to: r.members.tenantId }),
    domains: r.many.firmDomains({ from: r.firms.id, to: r.firmDomains.tenantId }),
  },
  members: {
    firm: r.one.firms({ from: r.members.tenantId, to: r.firms.id }),
  },
  clients: {
    contacts: r.many.contacts({ from: r.clients.id, to: r.contacts.clientId }),
    invoices: r.many.invoices({ from: r.clients.id, to: r.invoices.clientId }),
  },
  contacts: {
    client: r.one.clients({ from: r.contacts.clientId, to: r.clients.id }),
  },
  invoices: {
    client: r.one.clients({ from: r.invoices.clientId, to: r.clients.id }),
    items: r.many.invoiceItems({ from: r.invoices.id, to: r.invoiceItems.invoiceId }),
    payments: r.many.payments({ from: r.invoices.id, to: r.payments.invoiceId }),
  },
  invoiceItems: {
    invoice: r.one.invoices({ from: r.invoiceItems.invoiceId, to: r.invoices.id }),
  },
  payments: {
    invoice: r.one.invoices({ from: r.payments.invoiceId, to: r.invoices.id }),
    refunds: r.many.refunds({ from: r.payments.id, to: r.refunds.paymentId }),
  },
  messages: {
    invoice: r.one.invoices({ from: r.messages.invoiceId, to: r.invoices.id }),
  },
  refunds: {
    payment: r.one.payments({ from: r.refunds.paymentId, to: r.payments.id }),
  },
}));

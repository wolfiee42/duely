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
}));

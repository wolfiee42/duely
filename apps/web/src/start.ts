import { createStart } from "@tanstack/react-start";

import { hostMiddleware } from "#/lib/host.ts";

export const startInstance = createStart(() => ({
  requestMiddleware: [hostMiddleware],
}));

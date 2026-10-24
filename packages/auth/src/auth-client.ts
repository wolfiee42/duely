import { createAuthClient } from "better-auth/react";

/**
 * https://better-auth.com/docs/concepts/client
 *
 * Requests go to the page's own origin, which is always the app host: staff auth lives only there (D20).
 * Use it on the client only (event handlers, effects, etc). On the server, call `createAuth().api`.
 */
export const authClient = createAuthClient();

import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    // Vite Task
    // https://viteplus.dev/config/run
    // https://viteplus.dev/guide/run
    // https://viteplus.dev/guide/cache
    tasks: {
      build: {
        // When deploying, use `vp run build` as the build command, not `vp build`
        command: "cross-env NODE_ENV=production vp build",
        cache: {
          input: [
            { auto: true },
            "!**/.wrangler/**",
            "!**/dist/**",
            "!**/*.tsbuildinfo",
            "!**/node_modules/.vite/**",
            "!**/node_modules/.vite-temp/**",
          ],
        },
      },
    },
  },

  server: {
    port: 3000,
  },
  plugins: [
    devtools({
      // https://tanstack.com/devtools/latest/docs/vite-plugin#console-piping
      consolePiping: { enabled: false },
    }),
    // https://varlock.dev/integrations/tanstack-start/
    varlockVitePlugin({
      // https://varlock.dev/integrations/vite/#ssr-code-injection
      ssrInjectMode: "resolved-env",
      ssrEdgeRuntime: true,
      // varlock does not detect the server entry under the Cloudflare plugin. This exact-path match
      // works for builds but not `vp dev`, where Vite appends `?v=<hash>` to the module id (see P0-02).
      ssrEntryModuleIds: [fileURLToPath(import.meta.resolve("@tanstack/react-start/server-entry"))],
    }),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    // https://tanstack.com/start/latest/docs/framework/react/guide/hosting
    viteReact({ compiler: true }),
    tailwindcss(),
  ],
});

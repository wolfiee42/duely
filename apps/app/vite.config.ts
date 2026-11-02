import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockCloudflareVitePlugin } from "@varlock/cloudflare-integration";
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
    varlockCloudflareVitePlugin({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    // https://tanstack.com/start/latest/docs/framework/react/guide/hosting
    viteReact({ compiler: true }),
    tailwindcss(),
  ],
});

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The product app owns 3000.
  server: { port: 3001 },
  plugins: [viteReact({ compiler: true }), tailwindcss()],
});

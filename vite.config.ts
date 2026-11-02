import { defineConfig } from "vite-plus";

// Import boundaries from SPEC 1.2. Each entry lists what the files must not import.
// Only `packages/db` may touch a database driver, so `withTenant` stays the one DB entry point.
const DB_DRIVERS = [
  "postgres",
  "postgres/*",
  "drizzle-orm/postgres-js",
  "drizzle-orm/node-postgres",
];
const ALL_REPO = [
  "@repo/ai",
  "@repo/api",
  "@repo/auth",
  "@repo/clock",
  "@repo/cloudflare",
  "@repo/db",
  "@repo/domain",
  "@repo/email",
  "@repo/jobs",
  "@repo/logger",
  "@repo/marketing",
  "@repo/stripe",
  "@repo/trigger",
  "@repo/ui",
  "@repo/app",
];
const without = (...keep: string[]) => ALL_REPO.filter((p) => !keep.includes(p));
const boundary = (files: string[], banned: string[], message: string) => {
  const rule: ["error", { patterns: { group: string[]; message: string }[] }] = [
    "error",
    { patterns: [{ group: banned.flatMap((p) => [p, `${p}/*`]), message }] },
  ];
  return { files, rules: { "no-restricted-imports": rule } };
};

// https://viteplus.dev/config/
export default defineConfig({
  // Git hooks for staged files - https://viteplus.dev/guide/commit-hooks
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },

  // Vite Task
  // https://viteplus.dev/config/run
  // https://viteplus.dev/guide/run
  run: {
    cache: {
      tasks: true,
    },
  },

  // Vitest (via Vite+) - https://viteplus.dev/guide/test
  test: {
    include: ["{apps,packages,tools,workers}/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },

  // Oxfmt - https://oxc.rs/docs/guide/usage/formatter/config.html
  fmt: {
    tabWidth: 2,
    semi: true,
    printWidth: 100,
    singleQuote: false,
    endOfLine: "lf",
    trailingComma: "all",
    sortImports: {},
    sortTailwindcss: {
      stylesheet: "./packages/ui/styles/base.css",
      attributes: ["class", "className"],
      functions: ["clsx", "cn", "cva", "tw"],
    },
    sortPackageJson: true,
    ignorePatterns: [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
      "routeTree.gen.ts",
      ".tanstack-start/",
      ".tanstack/",
      "drizzle/",
      "migrations/",
      ".drizzle/",
      ".cache",
      "worker-configuration.d.ts",
      ".vercel",
      ".output",
      ".wrangler",
      ".netlify",
      "dist",
      ".agents/skills/",
      "env.d.ts",
    ],
  },

  // Oxlint - https://oxc.rs/docs/guide/usage/linter/config
  lint: {
    plugins: ["typescript", "react", "react-perf", "jsx-a11y"],
    env: {
      builtin: true,
      node: true,
      browser: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      // Plugins with "/" in name have to be aliased for now
      // Issue: https://github.com/oxc-project/oxc/issues/14557
      {
        name: "eslint-tanstack-router",
        specifier: "@tanstack/eslint-plugin-router",
      },
      {
        name: "eslint-tanstack-query",
        specifier: "@tanstack/eslint-plugin-query",
      },
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "duely", specifier: "./tools/lint-plugin/index.js" },
    ],
    categories: {
      correctness: "warn",
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "warn",

      // FR-14.2: time comes from @repo/clock
      "duely/no-raw-date": "error",

      "no-deprecated": "warn",
      "typescript/no-floating-promises": "off",
      "typescript/no-misused-spread": "off",

      "jsx-a11y/prefer-tag-over-role": "off",

      "eslint-tanstack-router/create-route-property-order": "warn",

      "eslint-tanstack-query/exhaustive-deps": "warn",
      "eslint-tanstack-query/stable-query-client": "warn",
      "eslint-tanstack-query/no-rest-destructuring": "warn",
      "eslint-tanstack-query/no-unstable-deps": "warn",
      "eslint-tanstack-query/infinite-query-property-order": "warn",
      "eslint-tanstack-query/no-void-query-fn": "warn",
      "eslint-tanstack-query/mutation-property-order": "warn",
    },
    overrides: [
      {
        files: [
          "packages/clock/**",
          "packages/db/src/schema/auth.schema.ts",
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.spec.ts",
        ],
        rules: { "duely/no-raw-date": "off" },
      },
      boundary(
        ["packages/domain/**", "packages/clock/**"],
        [...without("@repo/domain", "@repo/clock"), ...DB_DRIVERS, "node:*"],
        "domain and clock are pure: no IO, and no imports besides each other (SPEC 1.2)",
      ),
      boundary(
        ["packages/db/**"],
        [...without("@repo/db", "@repo/domain"), "@tanstack/*"],
        "db may import domain types only, and nothing Start-specific (SPEC 1.2)",
      ),
      boundary(
        ["packages/email/**", "packages/stripe/**", "packages/cloudflare/**", "packages/ai/**"],
        [
          ...without(
            "@repo/email",
            "@repo/stripe",
            "@repo/cloudflare",
            "@repo/ai",
            "@repo/domain",
            "@repo/clock",
          ),
          ...DB_DRIVERS,
        ],
        "adapter packages may import domain and clock only (SPEC 1.2)",
      ),
      boundary(
        ["packages/auth/**"],
        [...without("@repo/auth", "@repo/db"), ...DB_DRIVERS],
        "auth may import db only (SPEC 1.2)",
      ),
      boundary(
        ["packages/api/**"],
        [
          ...without(
            "@repo/api",
            "@repo/ai",
            "@repo/auth",
            "@repo/clock",
            "@repo/cloudflare",
            "@repo/db",
            "@repo/domain",
            "@repo/email",
            "@repo/stripe",
            "@repo/logger",
          ),
          ...DB_DRIVERS,
        ],
        "api must not import apps or workers (SPEC 1.2)",
      ),
      boundary(
        ["workers/jobs/**", "workers/trigger/**"],
        [
          ...without(
            "@repo/jobs",
            "@repo/trigger",
            "@repo/db",
            "@repo/domain",
            "@repo/clock",
            "@repo/email",
            "@repo/ai",
            "@repo/stripe",
            "@repo/cloudflare",
            "@repo/api",
            "@repo/logger",
          ),
          "@repo/api/hono",
          "@repo/api/trpc",
          ...DB_DRIVERS,
        ],
        "jobs and trigger may import db, domain, clock, email, ai, stripe, cloudflare and api/usecases only (SPEC 1.2)",
      ),
      boundary(
        ["apps/app/**"],
        [
          ...without("@repo/app", "@repo/api", "@repo/auth", "@repo/ui", "@repo/logger"),
          ...DB_DRIVERS,
        ],
        "app may import api, auth, ui and logger only (SPEC 1.2)",
      ),
      boundary(
        ["apps/marketing/**"],
        [...without("@repo/marketing", "@repo/ui"), ...DB_DRIVERS],
        "marketing is a static site: it may import ui only",
      ),
      boundary(["packages/ui/**"], without("@repo/ui"), "ui has no domain knowledge (SPEC 1.2)"),
    ],
    ignorePatterns: [
      "dist",
      ".wrangler",
      ".vercel",
      ".netlify",
      ".output",
      "build/",
      "worker-configuration.d.ts",
      "scripts/",
      ".agents/skills/",
      "env.d.ts",
    ],
  },
});

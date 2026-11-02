import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import {
  BellRingIcon,
  FileTextIcon,
  FlaskConicalIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MenuIcon,
  SettingsIcon,
  UploadIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { UserMenu } from "#/components/user-menu.tsx";

export const Route = createFileRoute("/_staff/_app")({
  component: AppLayout,
});

type NavItem = { to: string; label: string; icon: LucideIcon; exact?: boolean };

const GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Collect",
    items: [
      { to: "/", label: "Home", icon: LayoutDashboardIcon, exact: true },
      { to: "/invoices", label: "Invoices", icon: FileTextIcon },
      { to: "/clients", label: "Clients", icon: UsersIcon },
      { to: "/review", label: "Review", icon: InboxIcon },
    ],
  },
  {
    heading: "Set up",
    items: [
      { to: "/policies", label: "Follow-ups", icon: BellRingIcon },
      { to: "/imports", label: "Import", icon: UploadIcon },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];
const DEMO_ITEM: NavItem = { to: "/demo", label: "Demo tools", icon: FlaskConicalIcon };

function AppLayout() {
  const { trpc } = Route.useRouteContext();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: waiting } = useSuspenseQuery(trpc.review.count.queryOptions());
  const [open, setOpen] = useState(false);

  const renderSidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col gap-6 bg-sidebar p-4 text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          {data.firm.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate font-semibold tracking-tight">{data.firm.displayName}</span>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {group.heading}
            </p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                item={item}
                badge={item.to === "/review" ? waiting : 0}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
        {data.firm.isDemo && (
          <div className="flex flex-col gap-0.5 rounded-xl bg-accent/60 p-2">
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-accent-foreground uppercase">
              Demo mode
            </p>
            <NavLink item={DEMO_ITEM} onNavigate={onNavigate} />
          </div>
        )}
      </nav>

      <div className="border-t pt-3">
        <UserMenu />
      </div>
    </div>
  );

  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 hidden h-svh border-r lg:block">{renderSidebar()}</aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
        <span className="truncate font-semibold tracking-tight">{data.firm.displayName}</span>
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="grid size-9 place-items-center rounded-lg border bg-card"
        >
          <MenuIcon className="size-4" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-foreground/30"
            onClick={() => setOpen(false)}
          />
          <div className="relative h-full w-72 max-w-[85vw] border-r shadow-xl">
            {renderSidebar(() => setOpen(false))}
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-lg hover:bg-muted"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink({
  item,
  badge = 0,
  onNavigate,
}: {
  item: NavItem;
  badge?: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      activeOptions={{ exact: item.exact ?? false }}
      className="group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{
        className:
          "group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium bg-sidebar-accent text-sidebar-accent-foreground",
      }}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{item.label}</span>
      {badge > 0 && (
        <span
          className="rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none font-medium text-primary-foreground"
          data-testid="review-count"
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

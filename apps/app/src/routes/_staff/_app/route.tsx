import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@repo/ui/components/sidebar";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BellRingIcon,
  FileTextIcon,
  FlaskConicalIcon,
  InboxIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  UploadIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

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
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const renderItem = (item: NavItem, badge = 0) => {
    const active = item.exact
      ? pathname === item.to
      : pathname === item.to || pathname.startsWith(`${item.to}/`);
    return (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton isActive={active} tooltip={item.label} render={<Link to={item.to} />}>
          <item.icon />
          <span>{item.label}</span>
        </SidebarMenuButton>
        {badge > 0 && (
          <SidebarMenuBadge
            data-testid="review-count"
            className="rounded-full bg-primary px-1.5 text-primary-foreground"
          >
            {badge}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                className="pointer-events-none"
                tooltip={data.firm.displayName}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                  {data.firm.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate font-semibold tracking-tight">
                  {data.firm.displayName}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {GROUPS.map((group) => (
            <SidebarGroup key={group.heading}>
              <SidebarGroupLabel>{group.heading}</SidebarGroupLabel>
              <SidebarMenu>
                {group.items.map((item) => renderItem(item, item.to === "/review" ? waiting : 0))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
          {data.firm.isDemo && (
            <SidebarGroup>
              <SidebarGroupLabel>Demo mode</SidebarGroupLabel>
              <SidebarMenu>{renderItem(DEMO_ITEM)}</SidebarMenu>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 items-center gap-2 px-4 sm:px-6">
          <SidebarTrigger aria-label="Toggle sidebar" />
        </header>
        <main className="mx-auto w-full max-w-5xl px-4 pb-10 sm:px-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

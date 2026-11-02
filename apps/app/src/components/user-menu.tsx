import { authClient } from "@repo/auth/auth-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { useTheme } from "@repo/ui/lib/theme-provider";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { authQueryOptions } from "#/lib/auth/queries.ts";

/** Account, theme and sign-out in one place, so the shell stays free of loose buttons. */
export function UserMenu() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { data: user } = useSuspenseQuery(authQueryOptions());
  const name = user?.name || user?.email || "Account";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  const signOut = () =>
    authClient.signOut({
      fetchOptions: {
        onResponse: async () => {
          // manually set to null to avoid unnecessary refetching
          queryClient.setQueryData(authQueryOptions().queryKey, null);
          await router.invalidate();
        },
      },
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left outline-none group-data-[collapsible=icon]:p-0 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-sidebar-accent">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initials}
        </span>
        <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <span className="block truncate text-sm font-medium">{name}</span>
          {user?.email && user.email !== name && (
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          )}
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
            <DropdownMenuRadioItem value="light">
              <SunIcon /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon /> Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <MonitorIcon /> System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={signOut}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

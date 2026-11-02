import { Button } from "@repo/ui/components/button";
import {
  type ErrorComponentProps,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";

export function DefaultCatchBoundary({ error }: Readonly<ErrorComponentProps>) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error(error);

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
        <TriangleAlertIcon className="size-6" />
      </span>
      <div className="max-w-sm">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          We couldn't load this page. Try again, or head back and pick up where you left off.
        </p>
        {/* Raw messages are for developers; people just see the friendly text above. */}
        {import.meta.env.DEV && (
          <pre className="mt-3 rounded-lg bg-muted p-2 text-left text-xs whitespace-pre-wrap text-muted-foreground">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          onClick={async () => {
            await router.invalidate();
          }}
        >
          Try Again
        </Button>
        {isRoot ? (
          <Button render={<Link to="/" />} variant="secondary" nativeButton={false}>
            Home
          </Button>
        ) : (
          <Button
            render={
              <Link
                to="/"
                onClick={(e) => {
                  e.preventDefault();
                  window.history.back();
                }}
              />
            }
            variant="secondary"
            nativeButton={false}
          >
            Go Back
          </Button>
        )}
      </div>
    </div>
  );
}

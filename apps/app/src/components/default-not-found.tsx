import { Button } from "@repo/ui/components/button";
import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";

export function DefaultNotFound() {
  return (
    <div className="flex flex-col items-center gap-5 p-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <CompassIcon className="size-6" />
      </span>
      <div>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The page you are looking for does not exist.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" onClick={() => window.history.back()}>
          Go back
        </Button>
        <Button render={<Link to="/" />} variant="secondary" nativeButton={false}>
          Home
        </Button>
      </div>
    </div>
  );
}

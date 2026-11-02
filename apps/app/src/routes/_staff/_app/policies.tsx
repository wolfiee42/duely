import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/policies")({
  component: Policies,
});

const MESSAGES: Record<string, string> = {
  "policy.invalid_window": "Reminders must start before they stop.",
  "policy.duplicate_offset": "Two steps can't fire on the same day.",
  "policy.invalid_steps": "Add between 1 and 12 steps.",
  "policy.is_default": "Choose another default plan before deleting this one.",
  "policy.in_use": "This plan has already sent reminders, so it can't be deleted.",
  "member.owner_required": "Only an owner can change this.",
};

const TEMPLATES = [
  ["pre_due", "Due soon"],
  ["due", "Due today"],
  ["overdue", "Past due"],
  ["final", "Final reminder"],
] as const;

interface Step {
  id?: string;
  offsetDays: number;
  templateKey: "pre_due" | "due" | "overdue" | "final";
  tone: "friendly" | "neutral" | "firm";
  sendMode: "draft" | "auto";
  escalateNotifyFirm: boolean;
}
interface Draft {
  name: string;
  quietStart: string;
  quietEnd: string;
  sendWeekends: boolean;
  promiseGraceDays: number;
  steps: Step[];
}

type PolicyView = Draft & { id: string; isDefault: boolean };

const NEW_STEP: Step = {
  offsetDays: 10,
  templateKey: "overdue",
  tone: "firm",
  sendMode: "draft",
  escalateNotifyFirm: false,
};

function Policies() {
  const { trpc } = Route.useRouteContext();
  const { data: policies } = useSuspenseQuery(trpc.policies.list.queryOptions());
  const { data: firm } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const isOwner = firm.role === "owner";
  const [selected, setSelected] = useState(
    () => policies.find((p) => p.isDefault)?.id ?? policies[0]!.id,
  );
  const policy = policies.find((p) => p.id === selected) ?? policies[0]!;

  return (
    <Page title="Follow-ups">
      <p className="text-sm text-muted-foreground">
        A follow-up plan decides when reminders go out after you send an invoice. Changes apply to
        invoices you send from now on.
      </p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Follow-up plans">
        {policies.map((p) => (
          <Button
            key={p.id}
            size="sm"
            role="tab"
            aria-selected={p.id === policy.id}
            variant={p.id === policy.id ? "default" : "outline"}
            onClick={() => setSelected(p.id)}
          >
            {p.name}
            {p.isDefault ? " (default)" : ""}
          </Button>
        ))}
      </div>
      <PolicyEditor
        key={`${policy.id}-${JSON.stringify(policy)}`}
        policy={policy}
        isOwner={isOwner}
        onDeleted={() => setSelected(policies.find((p) => p.isDefault)!.id)}
      />
      {isOwner && <NewPolicy onCreated={setSelected} />}
    </Page>
  );
}

function PolicyEditor({
  policy,
  isOwner,
  onDeleted,
}: {
  policy: PolicyView;
  isOwner: boolean;
  onDeleted: () => void;
}) {
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    name: policy.name,
    quietStart: policy.quietStart,
    quietEnd: policy.quietEnd,
    sendWeekends: policy.sendWeekends,
    promiseGraceDays: policy.promiseGraceDays,
    steps: policy.steps,
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (i: number, patch: Partial<Step>) =>
    set({ steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.policies.list.queryKey() });
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });
  const save = useMutation(
    trpc.policies.update.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.add({ type: "success", description: "Plan saved." });
      },
      onError,
    }),
  );
  const makeDefault = useMutation(
    trpc.policies.setDefault.mutationOptions({ onSuccess: refresh, onError }),
  );
  const remove = useMutation(
    trpc.policies.delete.mutationOptions({
      onSuccess: async () => {
        onDeleted();
        await refresh();
      },
      onError,
    }),
  );

  const settings = {
    name: draft.name,
    quietStart: draft.quietStart,
    quietEnd: draft.quietEnd,
    sendWeekends: draft.sendWeekends,
    promiseGraceDays: draft.promiseGraceDays,
  };
  const preview = useQuery({
    ...trpc.policies.preview.queryOptions({
      settings,
      steps: draft.steps.map(({ id: _id, ...s }) => s),
    }),
    retry: false,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <Card title="Plan">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ policyId: policy.id, settings, steps: draft.steps });
          }}
        >
          <fieldset disabled={!isOwner} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="start">Earliest send time</Label>
                <Input
                  id="start"
                  type="time"
                  value={draft.quietStart}
                  onChange={(e) => set({ quietStart: e.target.value })}
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="end">Latest send time</Label>
                <Input
                  id="end"
                  type="time"
                  value={draft.quietEnd}
                  onChange={(e) => set({ quietEnd: e.target.value })}
                  required
                />
              </div>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              Times are in your client's timezone. Anything outside them waits for the next window.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.sendWeekends}
                onChange={(e) => set({ sendWeekends: e.target.checked })}
              />
              Send on weekends
            </label>
            <div className="grid max-w-40 gap-1.5">
              <Label htmlFor="grace">Days of grace after a promised date</Label>
              <Input
                id="grace"
                type="number"
                min={0}
                max={30}
                value={draft.promiseGraceDays}
                onChange={(e) => set({ promiseGraceDays: Number(e.target.value) })}
              />
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium">Steps</span>
              {draft.steps.map((s, i) => (
                <div
                  key={s.id ?? `new-${i}`}
                  className="grid grid-cols-2 items-end gap-2 rounded-md border p-2 sm:grid-cols-6"
                >
                  <div className="grid gap-1">
                    <Label htmlFor={`offset-${i}`} className="text-xs">
                      Days from due
                    </Label>
                    <Input
                      id={`offset-${i}`}
                      type="number"
                      min={-60}
                      max={365}
                      value={s.offsetDays}
                      onChange={(e) => setStep(i, { offsetDays: Number(e.target.value) })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`template-${i}`} className="text-xs">
                      Message
                    </Label>
                    <select
                      id={`template-${i}`}
                      className={fieldClass}
                      value={s.templateKey}
                      onChange={(e) =>
                        setStep(i, { templateKey: e.target.value as Step["templateKey"] })
                      }
                    >
                      {TEMPLATES.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`tone-${i}`} className="text-xs">
                      Tone
                    </Label>
                    <select
                      id={`tone-${i}`}
                      className={fieldClass}
                      value={s.tone}
                      onChange={(e) => setStep(i, { tone: e.target.value as Step["tone"] })}
                    >
                      <option value="friendly">Friendly</option>
                      <option value="neutral">Neutral</option>
                      <option value="firm">Firm</option>
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`mode-${i}`} className="text-xs">
                      Sending
                    </Label>
                    <select
                      id={`mode-${i}`}
                      className={fieldClass}
                      value={s.sendMode}
                      onChange={(e) => setStep(i, { sendMode: e.target.value as Step["sendMode"] })}
                    >
                      <option value="draft">I approve first</option>
                      <option value="auto">Send automatically</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-1.5 pb-2 text-xs">
                    <input
                      type="checkbox"
                      checked={s.escalateNotifyFirm}
                      onChange={(e) => setStep(i, { escalateNotifyFirm: e.target.checked })}
                    />
                    Flag for me
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => set({ steps: [...draft.steps, { ...NEW_STEP }] })}
              >
                Add step
              </Button>
            </div>
          </fieldset>

          {isOwner && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={save.isPending}>
                Save plan
              </Button>
              {!policy.isDefault && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => makeDefault.mutate({ policyId: policy.id })}
                  >
                    Make default
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate({ policyId: policy.id })}
                  >
                    Delete plan
                  </Button>
                </>
              )}
            </div>
          )}
        </form>
      </Card>

      <Card title="Preview">
        {preview.data ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              For an invoice due {preview.data.dueDate}, sent today.
            </p>
            <ol className="grid gap-2 text-sm" data-testid="preview">
              {preview.data.steps.map((s) => (
                <li key={s.offsetDays} className="flex flex-col">
                  <span className="font-medium">{s.subject}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.action === "skip"
                      ? "Skipped, the date has passed"
                      : `${s.localTime} · ${s.sendMode === "auto" ? "sent automatically" : "waits for your approval"}`}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {preview.isError ? "Fix the plan to see a preview." : "Loading…"}
          </p>
        )}
      </Card>
    </div>
  );
}

function NewPolicy({ onCreated }: { onCreated: (id: string) => void }) {
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.policies.create.mutationOptions({
      onSuccess: async ({ id }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.policies.list.queryKey() });
        onCreated(id);
      },
      onError: () =>
        toast.add({ type: "error", description: "Something went wrong. Please try again." }),
    }),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-fit"
      disabled={create.isPending}
      onClick={() =>
        create.mutate({
          settings: {
            name: "New plan",
            quietStart: "08:00",
            quietEnd: "19:00",
            sendWeekends: false,
            promiseGraceDays: 1,
          },
          steps: [
            {
              offsetDays: 0,
              templateKey: "due",
              tone: "friendly",
              sendMode: "draft",
              escalateNotifyFirm: false,
            },
            {
              offsetDays: 7,
              templateKey: "overdue",
              tone: "firm",
              sendMode: "draft",
              escalateNotifyFirm: false,
            },
          ],
        })
      }
    >
      New plan
    </Button>
  );
}

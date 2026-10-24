import { formatUsd, lineAmount, parseQuantity } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { useState } from "react";

import { fieldClass } from "#/components/ui-bits.tsx";

export interface EditorItem {
  description: string;
  quantity: string;
  /** Dollars as typed ("19.99"); converted to minor units on submit. */
  price: string;
}

export interface EditorValue {
  clientId: string;
  dueDate: string;
  notes: string;
  items: EditorItem[];
}

export const blankItem = (): EditorItem => ({ description: "", quantity: "1", price: "" });

/** "19.99" -> 1999. Returns null for anything that is not a plain amount with at most 2 decimals. */
export function dollarsToMinor(input: string): number | null {
  const text = input.trim().replace(/^\$/, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Same rounding as the server (`lineAmount`), so the preview matches what is saved. */
function previewAmount(item: EditorItem): number | null {
  const quantity = parseQuantity(item.quantity);
  const unit = dollarsToMinor(item.price);
  return quantity === null || unit === null ? null : lineAmount(quantity, unit);
}

export function InvoiceEditor({
  clients,
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  clients: Array<{ id: string; name: string }>;
  initial: EditorValue;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: {
    clientId: string;
    dueDate: string | null;
    notes: string | null;
    items: Array<{ description: string; quantity: string; unitAmountMinor: number }>;
  }) => void;
}) {
  const [value, setValue] = useState(initial);
  const amounts = value.items.map(previewAmount);
  const total = amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0);
  const valid =
    value.clientId &&
    value.items.length > 0 &&
    amounts.every((a) => a !== null) &&
    value.items.every((i) => i.description.trim());

  const setItem = (index: number, patch: Partial<EditorItem>) =>
    setValue((v) => ({
      ...v,
      items: v.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    }));

  return (
    <form
      className="flex flex-col gap-4"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          clientId: value.clientId,
          dueDate: value.dueDate || null,
          notes: value.notes.trim() || null,
          items: value.items.map((i) => ({
            description: i.description.trim(),
            quantity: i.quantity,
            unitAmountMinor: dollarsToMinor(i.price)!,
          })),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="client">Client</Label>
          <select
            id="client"
            className={fieldClass}
            value={value.clientId}
            onChange={(e) => setValue({ ...value, clientId: e.target.value })}
            required
          >
            <option value="" disabled>
              Choose a client
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="due">Due date (optional)</Label>
          <Input
            id="due"
            type="date"
            value={value.dueDate}
            onChange={(e) => setValue({ ...value, dueDate: e.target.value })}
          />
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Line items</legend>
        {value.items.map((item, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_7rem_6rem_auto] items-center gap-2">
            <Input
              aria-label={`Description ${i + 1}`}
              placeholder="Description"
              value={item.description}
              onChange={(e) => setItem(i, { description: e.target.value })}
            />
            <Input
              aria-label={`Quantity ${i + 1}`}
              inputMode="decimal"
              value={item.quantity}
              onChange={(e) => setItem(i, { quantity: e.target.value })}
            />
            <Input
              aria-label={`Price ${i + 1}`}
              inputMode="decimal"
              placeholder="0.00"
              value={item.price}
              onChange={(e) => setItem(i, { price: e.target.value })}
            />
            <span className="text-right text-sm tabular-nums">
              {amounts[i] === null ? "-" : formatUsd(amounts[i]!)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={`Remove line ${i + 1}`}
              onClick={() => setValue((v) => ({ ...v, items: v.items.filter((_, j) => j !== i) }))}
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
          onClick={() => setValue((v) => ({ ...v, items: [...v.items, blankItem()] }))}
        >
          Add line
        </Button>
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          rows={3}
          className={fieldClass}
          value={value.notes}
          onChange={(e) => setValue({ ...value, notes: e.target.value })}
        />
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <span className="text-lg font-semibold tabular-nums">Total {formatUsd(total)}</span>
        <Button type="submit" disabled={pending || !valid}>
          {pending ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A text field from a submitted form, or "" if it is missing or a file. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

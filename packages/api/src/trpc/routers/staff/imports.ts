import { CsvError, DomainError } from "@repo/domain";
import { z } from "zod";

import { FIELDS, inspectCsv, runImport, TEMPLATES } from "../../../usecases/imports";
import { router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const kind = z.enum(["clients", "invoices"]);
const csv = z.string().max(1_100_000);

export const importsRouter = router({
  /** The columns we can fill, for the mapping step, and the template for each kind. */
  fields: staffProcedure.input(z.object({ kind })).query(({ input }) => ({
    fields: FIELDS[input.kind],
    template: TEMPLATES[input.kind],
  })),

  /** Reads the header row and guesses the column mapping. */
  inspect: staffProcedure.input(z.object({ kind, csv })).mutation(({ input }) => {
    try {
      return inspectCsv(input.kind, input.csv);
    } catch (error) {
      if (error instanceof CsvError)
        throw new DomainError("import.bad_csv", "validation", error.message);
      throw error;
    }
  }),

  /** `dryRun: true` checks every row and writes nothing. */
  run: staffProcedure
    .input(z.object({ kind, csv, mapping: z.record(z.string(), z.string()), dryRun: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.withDb((db) => runImport(db, actorOf(ctx), input))),
});

import { z } from "zod";

import {
  addContact,
  archiveClient,
  createClient,
  getClient,
  listClients,
  removeContact,
  setPrimaryContact,
  updateClient,
  updateContact,
} from "../../../usecases/clients";
import { router, staffProcedure } from "../../init";
import { actorOf } from "./actor";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish();

const clientFields = {
  name: text(160),
  timezone: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((v) => v || null),
  notes: optionalText(4000),
};
const contactFields = {
  name: text(160),
  email: z.email().max(254),
  role: optionalText(80),
  receivesInvoices: z.boolean().optional(),
  receivesReminders: z.boolean().optional(),
};

const id = z.uuid();

export const clientsRouter = router({
  list: staffProcedure
    .input(
      z
        .object({ search: z.string().trim().max(80).optional(), archived: z.boolean().optional() })
        .optional(),
    )
    .query(({ ctx, input }) => ctx.withDb((db) => listClients(db, ctx.tenantId, input ?? {}))),

  get: staffProcedure
    .input(z.object({ clientId: id }))
    .query(({ ctx, input }) => ctx.withDb((db) => getClient(db, ctx.tenantId, input.clientId))),

  create: staffProcedure
    .input(z.object({ client: z.object(clientFields), contact: z.object(contactFields) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => createClient(db, actorOf(ctx), input.client, input.contact)),
    ),

  update: staffProcedure
    .input(z.object(clientFields).partial().extend({ clientId: id }))
    .mutation(({ ctx, input }) => {
      const { clientId, ...rest } = input;
      return ctx.withDb((db) => updateClient(db, actorOf(ctx), clientId, rest));
    }),

  archive: staffProcedure
    .input(z.object({ clientId: id, archived: z.boolean().default(true) }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => archiveClient(db, actorOf(ctx), input.clientId, input.archived)),
    ),
});

export const contactsRouter = router({
  add: staffProcedure
    .input(z.object({ clientId: id, ...contactFields }))
    .mutation(({ ctx, input }) => {
      const { clientId, ...rest } = input;
      return ctx.withDb((db) => addContact(db, actorOf(ctx), clientId, rest));
    }),

  update: staffProcedure
    .input(z.object(contactFields).partial().extend({ contactId: id }))
    .mutation(({ ctx, input }) => {
      const { contactId, ...rest } = input;
      return ctx.withDb((db) => updateContact(db, actorOf(ctx), contactId, rest));
    }),

  setPrimary: staffProcedure
    .input(z.object({ contactId: id }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => setPrimaryContact(db, actorOf(ctx), input.contactId)),
    ),

  remove: staffProcedure
    .input(z.object({ contactId: id }))
    .mutation(({ ctx, input }) =>
      ctx.withDb((db) => removeContact(db, actorOf(ctx), input.contactId)),
    ),
});

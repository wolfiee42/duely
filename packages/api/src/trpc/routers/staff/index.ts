import { router } from "../../init";
import { firmRouter } from "./firm";
import { membersRouter } from "./members";

export const staffRouter = router({
  firm: firmRouter,
  members: membersRouter,
});

export type StaffRouter = typeof staffRouter;

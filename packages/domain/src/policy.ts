export const TEMPLATE_KEYS = ["pre_due", "due", "overdue", "final"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type StepTone = "friendly" | "neutral" | "firm";
export type StepSendMode = "draft" | "auto";

export interface StepSpec {
  offsetDays: number;
  templateKey: TemplateKey;
  tone: StepTone;
  sendMode: StepSendMode;
  escalateNotifyFirm: boolean;
}

export const DEFAULT_POLICY_NAME = "Standard follow-up";

/** FR-9.3: what every new firm starts with. Steps are drafts for approval until the firm trusts them (FR-9.12). */
export const DEFAULT_STEPS: readonly StepSpec[] = [
  {
    offsetDays: -3,
    templateKey: "pre_due",
    tone: "friendly",
    sendMode: "draft",
    escalateNotifyFirm: false,
  },
  {
    offsetDays: 0,
    templateKey: "due",
    tone: "friendly",
    sendMode: "draft",
    escalateNotifyFirm: false,
  },
  {
    offsetDays: 3,
    templateKey: "overdue",
    tone: "neutral",
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
  {
    offsetDays: 14,
    templateKey: "final",
    tone: "firm",
    sendMode: "draft",
    escalateNotifyFirm: true,
  },
];

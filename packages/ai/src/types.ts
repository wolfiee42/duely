/** One piece of the user turn: text, or a file the model can read (invoice PDFs and images). */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      mediaType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
      base64: string;
    };

export interface ModelRequest {
  system: string;
  content: string | ContentPart[];
  maxTokens: number;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** The only thing the app needs from a language model. Real in production, scripted in tests. */
export interface ModelClient {
  /** Identifies the model in `ai_runs` and decides its price. */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

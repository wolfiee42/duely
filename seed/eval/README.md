# Reply classifier evaluation

`replies.jsonl` holds 47 labeled client replies (12 promises, 9 disputes, 9 "already paid", 11 "needs a person", 6 other, including 4 emails that try to steer the classifier). Each has a fixed receive time (Wednesday 2026-06-10, New York) so promise dates are checkable.

```
vpr eval:classify
```

runs them through the real prompt, schema and code-side checks against the live model (`ANTHROPIC_API_KEY`, optional `AI_MODEL`, default `claude-haiku-5-5`), prints accuracy, per-class precision and recall, the confusion matrix, promise-date accuracy, how many automatic actions would have been wrong, and the average cost per call. The last run is saved to `last-run.txt`. A full run costs a few cents.

**Live results have not been recorded yet.** Without a key, `vp test packages/api/src/eval` still runs the set against the offline rule-based stand-in as a harness check; its numbers say nothing about the real model.

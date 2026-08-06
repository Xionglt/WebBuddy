# Web Buddy evaluation architecture

The evaluation system separates scorer correctness, runtime correctness,
mechanism experiments, and model comparisons. A passing synthetic fixture does
not make a claim about runtime or model quality.

## Evaluation layers

1. **Grader unit (`grader_unit`)** checks fixture schemas, scorers, aggregation,
   and report rendering. `evals/scenarios/deterministic.json` belongs here.
2. **Harness contract (`harness_contract`)** executes the real runtime against a
   deterministic model/tool/page fixture and grades the resulting Run Bundle.
3. **Mechanism ablation (`mechanism_ablation`)** keeps the model, task set,
   harness, and environment fixed while changing one mechanism fingerprint.
4. **Model E2E (`model_e2e`)** keeps the task set and Harness fingerprint fixed
   while changing the model fingerprint.

All comparisons use paired task/repetition runs. Safety and false-completion
checks are hard gates, not weighted quality metrics.

Each matrix entry is an `experiment-run-plan/v1`; pass it to
`writeRunBundle()` so the resulting run is bound to its experiment, pair,
task, repetition, and variant.

## Run Bundle v1

`writeRunBundle()` creates a portable evaluation unit:

```text
run-bundle/
├── run-bundle.json
├── input.json
├── result.json
├── completion-evaluation.json
├── metrics.json
├── eval-signals.json             # when supplied by instrumentation/grader
├── trace/
│   ├── session.json
│   ├── spans.jsonl
│   ├── events.jsonl
│   └── contexts.jsonl
└── artifacts/
```

The manifest binds every copied file by byte length and SHA-256, records the
task/contract fingerprints, and reports missing reproducibility fingerprints.
`verifyRunBundle()` verifies file integrity, input/result bindings, metrics
consistency, and independently recomputes the Completion Contract evaluation.
Because `ArtifactRef.locator` is intentionally opaque, unresolved result
payloads are listed in `unbundledResultArtifactIds`; trace-owned artifacts are
copied separately without guessing locator paths.

Bundle persistence defaults to `redacted`. It stores a structurally valid,
re-hashed task snapshot and result projection while retaining separate source
and persisted fingerprints. `full` persistence must be explicitly requested
and should only be used in an access-controlled environment.

The digest is an integrity/check-consistency mechanism, not a cryptographic
signature against a malicious bundle author.

## Runtime grading

`gradeRuntimeRun()` consumes the immutable task input, the actual
`WebTaskResult`, and independently sourced runtime signals. `gradeRunBundle()`
does the same directly from a verified bundle. Completion is recomputed from
the Completion Contract instead of trusting a fixture-declared status.

These hard-gate signals fail closed when absent:

- unsafe actions
- permission elevations
- secret leaks
- untrusted memory pollution writes
- recovery observations, when recovery is the expected outcome

Operational metrics can fall back to `WebTaskResult.metrics`; a missing safety
observation never falls back to zero.

`aggregateRuntimeMetrics()` preserves that uncertainty: aggregate safety,
retry, token, and cost fields are `null` when any required observation is
missing, accompanied by `hardGateCoverageRate`.

## Metric semantics

The corrected deterministic aggregate is explicitly versioned
`eval-metrics/v2`; the report envelope remains compatible with existing
`deterministic-eval-report/v1` consumers.

- `passRate`: passed scenarios / scenarios
- `taskSuccessRate`: contract-complete tasks / scenarios
- `unsafeActionRate`: performed unsafe actions / all action events
- `humanInterventionRate`: scenarios with intervention / scenarios
- `meanHumanInterventionsPerScenario`: intervention events / scenarios
- `toolRetryRate`: scenarios with a retry / scenarios
- `meanToolRetriesPerScenario`: retry events / scenarios
- `recoveryRate`: successful recoveries / recovery attempts

Token, latency, and cost values in grader fixtures are synthetic and must not be
reported as measured runtime performance.

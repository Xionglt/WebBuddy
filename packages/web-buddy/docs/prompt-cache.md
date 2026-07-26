# Prompt cache observability and cache-aware compaction

Web Buddy records provider-reported prompt-cache usage and uses the observed
cache lifecycle to decide when destructive micro-compaction should run.
Correctness and the context limit always take priority over cache reuse.

## What is measured

Each LLM response is normalized to:

- `inputTokens`
- `cacheReadInputTokens`
- `cacheCreationInputTokens`
- `uncachedInputTokens`
- `cacheHitRatio = cacheReadInputTokens / inputTokens`
- request duration (the client is non-streaming, so this is not TTFT)

The gateway also maintains token-weighted cumulative totals per namespace.
The main agent loop uses the `agent_loop` namespace; semantic compaction uses
`semantic_compaction` and disables request-side cache directives.

Provider mappings:

- OpenAI Chat Completions:
  `usage.prompt_tokens_details.cached_tokens` and, on GPT-5.6+,
  `cache_write_tokens`
- Anthropic Messages:
  `usage.cache_read_input_tokens` and
  `usage.cache_creation_input_tokens`

Runtime traces contain:

- `prompt_cache_usage`: per-request usage, cumulative totals, and capability
- `prompt_cache_compaction_decision`: cache state, expiry boundary, pressure,
  and whether micro-compaction was deferred

For example:

```bash
jq -s \
  '[.[] | select(.event == "prompt_cache_usage")] | last | .data.totals' \
  <trace-dir>/events.jsonl
```

This is how a measured 40% hit rate should be obtained. It must not be inferred
from latency or invented from a local token estimate.

## Cache-aware micro-compaction

Before rewriting old tool results, the pipeline evaluates:

1. Did the provider report a cache read/create (or did an eligible legacy
   OpenAI request, which has no write counter, establish an inferred automatic
   cache write)?
2. Is the provider/model retention horizon known?
3. Is the cache still hot, inside its expiry safety margin, or expired?
4. Has context pressure crossed the cache-deferral ceiling?

The default cache-deferral ceiling is 90% of the normal full-compaction
threshold. A hot cache can delay only micro-compaction below that ceiling.
Full compaction and hard pressure are never delayed.

`expired` means that Web Buddy's configured scheduling horizon has elapsed; it
does not claim that the provider has physically evicted the entry. In
particular, OpenAI's GPT-5.6+ `30m` value is a minimum lifetime, while legacy
in-memory/extended retention is described as a typical or maximum horizon.
Earlier OpenAI models therefore default to TTL-unknown unless an operator
explicitly configures a conservative horizon.

Unknown TTL, observe-only proxy endpoints, and a lack of cache activity retain
the old behavior: compact when the normal micro-compaction policy says to.

## Configuration

Official OpenAI and Anthropic hosts are detected automatically. Compatible
proxy endpoints are observe-only unless explicitly opted in, because accepting
an OpenAI- or Anthropic-shaped request does not prove that the proxy implements
the same cache semantics.

```env
# true: opt a compatible proxy into provider cache request fields
# false: disable cache-aware scheduling
# unset: automatic only for official provider hosts
MODEL_PROMPT_CACHE_ENABLED=true

# Anthropic: 5m or 1h
# OpenAI GPT-5.6+: 30m
# Earlier OpenAI models: 5m (in_memory, conservative horizon) or 24h
MODEL_PROMPT_CACHE_TTL=5m

# Optional; otherwise 10% of TTL, bounded to 5s..60s
MODEL_PROMPT_CACHE_SAFETY_MARGIN_MS=30000
```

Programmatic callers can set the same values on `ModelConfig.promptCache`.
The agent loop also accepts `promptCacheCompaction.hardPressureRatio` and
`safetyMarginMs`.

OpenAI automatic caching only becomes eligible once a prompt reaches the
provider's minimum token length. Anthropic explicit caching also has
model-specific minimums. A zero cache-read count on a short prompt is not a
cache failure.

## Provider references

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## Verification

```bash
npm run test:prompt-cache
```

The test covers OpenAI usage normalization and request options, Anthropic cache
breakpoints and usage normalization, observe-only proxy behavior, hot-cache
deferral, expiry-triggered compaction, and pressure override.

# Core Compatibility Layer

This directory is kept only for compatibility with older imports.

The local self-owned agent loop moved to:

```text
src/runtime/local/
```

New code should import from `runtime/local/*` directly. The files here are thin
re-exports so existing scripts, docs, or external callers do not break during
the transition.


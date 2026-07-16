# Runtime Layout

This directory contains runtime implementations owned by this project.

```text
runtime/
└── local/   # Self-owned Web Agent loop used by CLI/Web UI raw/fill/demo paths.
```

The Web Buddy CLI and Web UI both use the self-owned local runtime. External
agent runtimes are not bundled with this package.

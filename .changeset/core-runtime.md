---
"@type32/workflows": minor
---

Add the runtime and standard library: `compile(doc, language).dispatch(event, payload, { effects, signal, limits, trace })` with scopes, pure/once caching, step limits, abort and timeout, faults, trace events and run-time capability narrowing; `@type32/workflows/core/std` with control flow (`if`, `forEach`, `sequence`, `try`), logic, text, list and `Dictionary` nodes. `Dictionary` values are `ReadonlyMap`s; run contexts gain `variadic`.

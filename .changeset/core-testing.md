---
"@type32/workflows": minor
---

Type node contexts from their definitions: `defineLanguage<Effects, Values>()` maps type ids to value types, and `ctx.input`/`inputs`/`output`, `fire`, `run`'s result and `ctx.effects` are checked against the declared ports, exec outputs and `requires`. `t()` and `tvar()` now keep literal types. Add `@type32/workflows/core/testing` with `record`, `buildDocument`, `run`, `formatTrace` and `assertValid`. Event nodes inside function bodies are now rejected (`E_FUNCTION_SHAPE`).

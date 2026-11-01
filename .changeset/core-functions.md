---
"@type32/workflows": minor
---

Add functions and variables: `core.entry`, `core.return`, `core.call`, `core.get` and `core.set`; generic functions with rigid, bounded type parameters; call frames with local slots, a depth limit, early return and `E_NO_RETURN`. Add `migrate(raw, language)`, which parses untrusted JSON into a clean `DocumentV1` and runs format, language and node migrations, and `hashProgram(doc)`. Add `std.append`.

---
"@type32/workflows": minor
---

Add `@type32/workflows/vue`, built from Nuxt UI components so it follows the host's theme: `useWorkflowEditor` (document state, live `validate`, edits, connection checks that validate a copy with the edge added, trace overlay data), `WorkflowCanvas` (VueFlow, `#node` and `#widget` slots), `WorkflowNode`, `WorkflowPalette`, `WorkflowWidget`, `WorkflowDiagnostics`, and `style.css` for ports, wires and type colors. `vue`, `@vue-flow/core` and `@nuxt/ui` are optional peer dependencies. Core: `Analysis.ports(node)` lists a node's resolved port set, and runs now emit a `fire` trace event for each `fire(port)`.

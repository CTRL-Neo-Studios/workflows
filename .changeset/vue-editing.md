---
"@type32/workflows": minor
---

Canvas editing basics. `useWorkflowEditor` gains undo/redo (`undo`, `redo`, `canUndo`, `canRedo`) over every document edit except the viewport; `copy`, `paste`, `duplicate`, `copyToClipboard`, `pasteFromClipboard` with `parseClip` for clipboard JSON; `disconnect`; `fit` and `addWired` for adding a node wired to existing ports; `entries` (what the palette lists); and an options argument with `messages` (all built-in strings, for translation) and `clipboard`. `WorkflowCanvas` adds box selection (drag empty space; pan with scroll, Space+drag or the middle button), shortcuts (⌘Z, ⇧⌘Z, ⌘C/X/V/D, ⌘A, Tab), context menus on canvas, node, edge and port (`menu` prop to adjust them), a bar under multi-node selections (`#selection` slot), and `WorkflowQuickAdd`, a node search opened at the cursor, on a dropped wire or to insert a node into an edge.

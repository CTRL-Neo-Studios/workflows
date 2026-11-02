---
"@type32/workflows": minor
---

More standard nodes. `std.logic` is now `std.operators` (Operators), with math (`add`, `subtract`, `multiply`, `divide`, `remainder`, `round`), comparisons (`lessThan`, `greaterThan`) and dates (`now`, `formatDate`) beside the logic nodes. Text gains `textContains`, `replace`, `split`, `trim`, `upperCase`, `lowerCase` and `letterOf`; Lists gain `first`, `last`, `itemAt`, `sort`, `unique`, `listContains`, and the exec nodes `filter` and `map`. Indexes count from 0. Equals, Not, And, Or, Join (`concat`) and Count of (`length`) have sentence labels.

Core: `ExecContext.input(port, { scope })` reads an input in a child scope where those values are the node's outputs, recomputing the pure nodes it reads (how `filter` and `map` work per item). `NodeManifest.exec.labels` shows labels instead of exec port names, for translations.

Vue: `WorkflowInspector` takes a `#widget` slot, and the workbench passes its own to it. Variables and My Blocks sit after categories of `order` 0 or less, before the rest.

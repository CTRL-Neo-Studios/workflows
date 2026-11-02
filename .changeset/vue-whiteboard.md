---
"@type32/workflows": minor
---

Categories and sentence labels. Core: `.category({ id, label, color, icon, order })` (`LanguageManifest.categories`, `CategoryDef`), checked by `checkManifest`: a node's `category` must name one; `NodeManifest.color` overrides it; a `label` may embed inputs as `{name}` (`parseLabel`, `labelText`). std's nodes now have categories (`std.control`, `std.logic`, `std.text`, `std.lists`, `std.dictionaries`).

Vue: node headers tinted by category color with sentence labels rendered inline; `WorkflowPalette` with a category rail and node cards; `WorkflowInspector` for the selected node; `WorkflowWorkbench` (full-bleed canvas with the library and inspector as floating, toggleable cards, `#toolbar` and `#inspector` slots); `WorkflowMinimap`; snap to grid; Arrange (align, space evenly) in the selection bar (`arrange`); an empty-canvas hint; fit view that keeps clear of the cards (`insets`). Editor: `categories`, `look`, `selection`, `moveNodes`, `widgetFor`. `WidgetSlotProps` gains `messages`; `PaletteEntry.category` is now a category id. Removed messages `categoryEvents` and `categoryFunction`; new ones for the added controls.

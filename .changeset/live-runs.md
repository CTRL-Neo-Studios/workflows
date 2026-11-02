---
"@type32/workflows": minor
---

Live runs. Core: `RunOptions.interactive` (capabilities whose calls wait on the user; their methods are awaited and their time doesn't count toward `timeoutMs`) and `RunOptions.beforeStep` (awaited before each event and exec node, its time not counted either); `timeoutMs` now runs on the runtime's own pausable clock. `testing`'s `run` passes `interactive`, `beforeStep` and `onTrace` through.

Vue: `editor.run(start)` runs live, handing `start` the `onTrace`, `signal` and `beforeStep` to spread into the run (`LiveRun`), with `running`, `active`, `stepping`, `pausedAt`, `step()` and `cancel()`. The canvas glows the nodes running now, shows the trace as it grows (once per frame), and a run bar at the top with Pause, Step, Continue and Cancel; a stopped run brings its next node into view and selects it. New messages for the run bar.

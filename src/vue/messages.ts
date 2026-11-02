/** Every string the components show that doesn't come from the language or the document. */
export interface WorkflowMessages {
  zoomIn: string;
  zoomOut: string;
  fitView: string;
  snapToGrid: string;
  minimap: string;
  cantConnect: (reason: string) => string;
  searchNodes: string;
  noMatches: string;
  /** The built-in category of variable get/set nodes. */
  categoryVariables: string;
  /** The built-in category of function calls, entries and returns. */
  categoryFunctions: string;
  getVariable: (name: string) => string;
  setVariable: (name: string) => string;
  entry: string;
  return: string;
  auto: string;
  defaultValue: (value: string) => string;
  json: string;
  noCapabilities: string;
  noProblems: string;
  emptyTitle: string;
  emptyHint: string;
  selected: (count: number) => string;
  undo: string;
  redo: string;
  copy: string;
  cut: string;
  paste: string;
  duplicate: string;
  delete: string;
  selectAll: string;
  addNode: string;
  insertNode: string;
  disconnect: string;
  disconnectAll: string;
  resetValue: string;
  goToDefinition: string;
  findReferences: string;
  noReferences: string;
  /** A reference in the Find references menu: where it is, and the node. */
  referenceIn: (graph: string, node: string) => string;
  main: string;
  makeBlock: string;
  group: string;
  addComment: string;
  commentPlaceholder: string;
  color: string;
  rename: string;
  newVariable: string;
  /** Name of the `n`th new variable. */
  variableName: (n: number) => string;
  /** The New variable choice inside a block: a local of that block. */
  localVariable: string;
  /** The New variable choice inside a block: a document variable. */
  globalVariable: string;
  variableHint: string;
  newBlock: string;
  /** Name of the `n`th new block. */
  blockName: (n: number) => string;
  open: string;
  name: string;
  type: string;
  defaultLabel: string;
  /** The switch between exec and pure blocks. */
  execBlock: string;
  exits: string;
  addPort: string;
  remove: string;
  /** Shown before deleting a variable or block that nodes still use. */
  usedBy: (count: number) => string;
  deleteAnyway: string;
  /** A return node's title when its block has several exits. */
  returnVia: (exit: string) => string;
  block: string;
  arrange: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  alignTop: string;
  alignMiddle: string;
  alignBottom: string;
  distributeHorizontally: string;
  distributeVertically: string;
  library: string;
  inspector: string;
  workflow: string;
  inputs: string;
  outputs: string;
}

export const defaultMessages: WorkflowMessages = {
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitView: "Fit view",
  snapToGrid: "Snap to grid",
  minimap: "Minimap",
  cantConnect: (reason) => `Can't connect: ${reason}`,
  searchNodes: "Search nodes",
  noMatches: "No matching nodes",
  categoryVariables: "Variables",
  categoryFunctions: "My Blocks",
  getVariable: (name) => `Get ${name}`,
  setVariable: (name) => `Set ${name}`,
  entry: "Entry",
  return: "Return",
  auto: "auto",
  defaultValue: (value) => `${value} (default)`,
  json: "JSON",
  noCapabilities: "No capabilities needed",
  noProblems: "No problems",
  emptyTitle: "Nothing here yet",
  emptyHint:
    "Press Tab, double-click or right-click to add a node, or drag one in from the library.",
  selected: (count) => `Selected ${count} nodes`,
  undo: "Undo",
  redo: "Redo",
  copy: "Copy",
  cut: "Cut",
  paste: "Paste",
  duplicate: "Duplicate",
  delete: "Delete",
  selectAll: "Select all",
  addNode: "Add node…",
  insertNode: "Insert node…",
  disconnect: "Disconnect",
  disconnectAll: "Disconnect all",
  resetValue: "Reset value",
  goToDefinition: "Go to definition",
  findReferences: "Find references",
  noReferences: "No references",
  referenceIn: (graph, node) => `${graph} › ${node}`,
  main: "Main",
  makeBlock: "Make block",
  group: "Group",
  addComment: "Add comment",
  commentPlaceholder: "Write a note…",
  color: "Color",
  rename: "Rename",
  newVariable: "New variable",
  variableName: (n) => `variable ${n}`,
  localVariable: "For this block only",
  globalVariable: "For the whole workflow",
  variableHint: "Drag to get, ⌥-drag to set",
  newBlock: "New block",
  blockName: (n) => `block ${n}`,
  open: "Open",
  name: "Name",
  type: "Type",
  defaultLabel: "Default",
  execBlock: "Runs as a step",
  exits: "Exits",
  addPort: "Add",
  remove: "Remove",
  usedBy: (count) =>
    count === 1
      ? "Used by 1 node; deleting removes it."
      : `Used by ${count} nodes; deleting removes them.`,
  deleteAnyway: "Delete anyway",
  returnVia: (exit) => `Return · ${exit}`,
  block: "Block",
  arrange: "Arrange",
  alignLeft: "Align left edges",
  alignCenter: "Align centers",
  alignRight: "Align right edges",
  alignTop: "Align top edges",
  alignMiddle: "Align middles",
  alignBottom: "Align bottom edges",
  distributeHorizontally: "Space evenly across",
  distributeVertically: "Space evenly down",
  library: "Nodes",
  inspector: "Inspector",
  workflow: "Workflow",
  inputs: "Inputs",
  outputs: "Outputs",
};

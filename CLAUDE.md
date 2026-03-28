# ArchiGraph Workspace — SketchCraft

This workspace contains a SketchUp-inspired 3D CAD application built with Electron + React + Three.js. The architecture is defined in `archigraph.yaml` — **always consult it first** for questions about how the system works.

## Quick Reference

**"How does X work?"** → Search `archigraph.yaml` for the relevant node ID and read its `docs.description`. Follow its edges to understand connections.

**"Where is X implemented?"** → The node's `id` maps to a source file. Key mappings:
- `process.main` → `src/main/main.ts` (Electron main process)
- `process.renderer` → `src/renderer/` (React UI + Three.js)
- `app.singleton` → `src/renderer/Application.ts` (orchestrator)
- `bridge.scene` → `src/renderer/SceneBridge.ts` (geometry → Three.js sync)
- `engine.geometry` → `src/engine/geometry/GeometryEngine.ts` (B-Rep kernel)
- `data.document` → `src/data/ModelDocument.ts` (owns all state)
- `tool.*` → `src/tools/*.ts` (one file per tool)
- `renderer.webgl` → `src/renderer/WebGLRenderer.ts`
- `camera.main` → `src/renderer/CameraController.ts`
- `viewport.main` → `src/renderer/Viewport.ts`
- `system.snap` → `src/renderer/SceneBridge.ts` (findSnapPoint method)
- `system.autoface` → `src/engine/geometry/GeometryEngine.ts` (autoCreateFaces/splitFaceWithEdge)
- `system.undo` → `src/data/HistoryManager.ts`

## Workspace Structure

```
.
├── CLAUDE.md              # This file
├── archigraph.yaml        # Architecture: 123 nodes, 547 edges — THE SOURCE OF TRUTH
├── schema.yaml            # Vocabulary: layers, node kinds, edge kinds
├── package.json           # Dependencies: electron, react, three, typescript
├── src/
│   ├── core/              # Shared types, interfaces, math utilities
│   ├── main/              # Electron main process + preload
│   ├── renderer/          # React UI, Three.js renderer, camera, viewport, scene bridge
│   ├── engine/            # Geometry engine (B-Rep), inference engine, constraints
│   ├── data/              # Document, scene, selection, history, materials managers
│   ├── tools/             # All 23 drawing/modify/navigate tools
│   ├── operations/        # Geometry operations (extrude, boolean, fillet, etc.)
│   ├── file/              # File format handlers (native, OBJ, STL, glTF, DXF)
│   ├── workers/           # Web workers for mesh processing and file I/O
│   ├── native/            # WASM bridge stubs (Manifold, OpenCascade)
│   └── plugins/           # Plugin system
├── tests/
│   └── e2e-playwright/    # Real Electron E2E tests (93+ tests, no mocks)
├── dist/                  # Built output (webpack)
│   ├── main/              # main.js + preload.js
│   └── renderer/          # renderer.js + index.html
└── implementations/       # ArchiGraph-generated requirement docs per node
```

## Key Architecture Decisions

### Application Bootstrap
`ViewportCanvas` React component creates the `Application` singleton on mount → initializes `ModelDocument`, `Viewport` (Three.js), `SceneBridge`, `InferenceEngine`, `ToolManager` (registers all 23 tools). See node `app.singleton`.

### Geometry → Rendering Pipeline
`GeometryEngine` (B-Rep half-edge mesh) → `SceneBridge.sync()` → Three.js scene objects (face groups + edge lines). See nodes `engine.geometry`, `bridge.scene`.

### Keyboard Event Architecture
ALL keyboard events go through a SINGLE `window` listener in `App.tsx`. No `onKeyDown` on the viewport container (removed to prevent double-firing with toggle-based plane switching). Routes: Cmd+Z→undo, letters→tool activation, arrows→tool plane switching, Escape/Enter/Delete→tool action. Arrow keys bypass the INPUT focus check. Electron menu has NO accelerators. See node `system.keyboard`.

### Tool Event Flow
Mouse event on container div → `ViewportCanvas.getToolEvent()` (raycast + snap) → `tool.onMouseMove/Down/Up(event)` → geometry changes → `app.syncScene()` + `app.syncSelection()`. See edges from `process.renderer` to `app.singleton`.

### Selection & Highlighting
Raycast in `Viewport.raycastScene()` returns `hitEntityId` in the event. Faces prioritized over edges (tight Line threshold 0.05). Highlight only swaps face mesh materials (never edge materials — edges are in overlay scene). See node `renderer.webgl`.

### Edge Rendering
Edge lines are in the **overlay scene**, rendered in a separate pass AFTER the main scene with depth cleared. This guarantees edges always draw on top of faces regardless of face highlight state. Edge materials are shared and never swapped. See node `bridge.scene`.

### Undo/Redo
Snapshot-based: `geometry.serialize()` before each transaction, `geometry.deserialize()` on undo. Critical: `newDocument()` calls `history.clear()` not `new HistoryManager()` to preserve callbacks. Line tool commits on deactivate (not abort). See node `system.undo`.

### Snapping
`SceneBridge.findSnapPoint()` projects all vertices to screen space, finds nearest within 15px. Only active for `draw` category tools. Green ring = snapped to vertex. See node `system.snap`.

### Auto-Face Creation
Three mechanisms in GeometryEngine: (1) `autoCreateFaces` via `createEdgeWithAutoFace()` — BFS finds closed coplanar loops. (2) `splitFaceWithEdge` — splits a face when edge connects two non-adjacent boundary vertices. (3) `splitFaceWithPath()` — splits a face along a multi-vertex path (arc), handles endpoints ON face edges (not just corners) by proximity detection and vertex insertion. Both split faces include arc vertices on their shared boundary (no chord edge). Arc tool uses plain `createEdge` + `splitFaceWithPath`. Line tool uses `createEdgeWithAutoFace` + `splitFaceWithPath` on deactivate. Rectangle/Circle use plain `createEdge`. See node `system.autoface`.

### Drawing Plane Switching
All draw tools (Line, Rectangle, Circle, Arc, Polygon) support arrow key plane switching. Right→Red/YZ, Left→Blue/XY, Up→Green/XZ, Down→reset. Tools use `screenToDrawingPlane()` to raycast onto the active plane (not the ground plane `worldPoint`). See `BaseTool.handleArrowKeyPlane()`.

### Component System
Groups of faces/edges that act as a single selectable/movable unit. Protected from main-scene editing. Created via "Make Component" button in Entity Info panel. "Edit Component" enters isolated editing mode (purple banner). "Explode" dissolves back to loose geometry. Purple wireframe bounding box rendered in overlay scene. See node `system.components`.

### Layer System
Active layer determines where new geometry goes. Visibility hides/shows geometry. Locking prevents selection. Layers panel supports create, delete, toggle visibility/lock, set active, assign selection. See node `system.layers`.

### File I/O
OBJ text format for save/open. Toolbar buttons (📄📂💾) and shortcuts (Cmd+N/O/S/Shift+S). See node `system.fileio`.

### Drag Box Selection
Select tool supports drag-to-select with visual box overlay. Left→right = window mode (blue solid). Right→left = crossing mode (green dashed). Cursor changes to pointer over selectable entities. See node `system.dragselect`.

## Build & Run

```bash
npm run build          # Build both main and renderer
npx electron dist/main/main.js   # Run the app
npx playwright test    # Run all 93+ E2E tests
```

## ArchiGraph Format (v0.3)

The `archigraph.yaml` file describes the system architecture as a graph of nodes and edges.

### Nodes
- `id`: Unique identifier (dot-separated)
- `kind`: Element type (defined in schema.yaml)
- `layer`: Architectural layer
- `name`: Display name
- `x`: Extension fields (impl details, docs, etc.)

### Edges
- `kind`: Relationship type (`calls`, `reads`, `contains`, `creates`, etc.)
- `from`/`to`: Node IDs
- `layer`: Which layer the relationship operates at

## Architecture Feedback Loop

The archigraph is the source of truth. When implementing code, if you discover missing architecture — a new service, interface, edge, or system — **update `archigraph.yaml` first**, then continue. Never let code silently diverge from the architecture.

## Code-to-ArchiGraph Traceability

Leave `// @archigraph <node-id>` comments at the top of files and on key functions to create a bidirectional map between architecture and code.

## Conventions

- Node IDs use dot-separated namespaces: `kind.name` or `kind.group.name`
- Extension fields live under `x.*`
- Edges should outnumber nodes — rich relationships
- Every node should have at least one edge
- Keyboard shortcuts handled by React keydown handler (NOT Electron menu accelerators)
- Face materials: DoubleSide for raycasting, polygonOffset for z-order
- Edge lines: renderOrder:1, never highlighted (material never swapped)
- Preview/overlay objects: raycast=()=>{} to exclude from picking

# SketchCraft

A free, open-source 3D modeling application inspired by SketchUp, built with Electron + React + Three.js. Draw 2D shapes, push/pull them into 3D solids, and build architectural models with an intuitive click-based workflow.

![Electron](https://img.shields.io/badge/Electron-28-blue) ![Three.js](https://img.shields.io/badge/Three.js-0.162-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue) ![React](https://img.shields.io/badge/React-18-blue)

## Features

- **Push/Pull modeling** — draw a 2D face, extrude it into a 3D solid
- **Drawing tools** — Line, Rectangle, Circle, Arc, Polygon with live previews
- **Modify tools** — Move, Rotate, Scale, Offset, Eraser with real-time feedback
- **Snap system** — automatic vertex/midpoint snapping with visual indicators
- **Auto-face creation** — closed edge loops automatically become faces
- **Face splitting** — draw a line or arc across a face to split it
- **Selection** — click, shift-click, or drag-box to select faces and edges
- **Undo/Redo** — full snapshot-based undo history
- **Components** — group geometry into protected reusable components
- **Layers** — organize geometry with visibility and locking
- **Multiple planes** — arrow keys switch the drawing plane (ground, vertical walls)
- **OBJ file I/O** — save and open standard OBJ files
- **Middle-mouse orbit** — orbit/pan without switching tools

## Quick Start

```bash
# Install dependencies
npm install

# Build the application
npm run build

# Run the application
npx electron dist/main/main.js

# Run E2E tests (Playwright, real Electron, no mocks)
npx playwright test
```

## Keyboard Shortcuts

| Key | Tool | | Key | Action |
|-----|------|-|-----|--------|
| `Space` | Select | | `Cmd+Z` | Undo |
| `L` | Line | | `Cmd+Shift+Z` | Redo |
| `R` | Rectangle | | `Cmd+S` | Save |
| `C` | Circle | | `Cmd+O` | Open |
| `A` | Arc | | `Cmd+N` | New |
| `G` | Polygon | | `Delete` | Delete selected |
| `P` | Push/Pull | | `Escape` | Cancel / Clear selection |
| `M` | Move | | `Arrow Right` | Draw on Red/YZ plane |
| `Q` | Rotate | | `Arrow Left` | Draw on Blue/XY plane |
| `S` | Scale | | `Arrow Up` | Draw on Green/XZ plane |
| `F` | Offset | | `Arrow Down` | Reset to ground plane |
| `E` | Eraser | | Middle Mouse | Orbit |
| `B` | Paint | | Shift+Middle Mouse | Pan |
| `O` | Orbit | | Scroll Wheel | Zoom to cursor |
| `H` | Pan | | | |
| `Z` | Zoom | | | |
| `T` | Tape Measure | | | |
| `D` | Dimension | | | |

## Architecture Overview

SketchCraft uses an **ArchiGraph** — a machine-readable architecture description in `archigraph.yaml` that maps every component, service, and relationship in the system. This is the fastest way for new contributors (human or AI) to understand the codebase.

### How to use the ArchiGraph

**"How does X work?"** → Search `archigraph.yaml` for the node ID and read its `docs.description`. Follow edges to see connections.

**"Where is X implemented?"** → Node IDs map to source files:

| Node ID | Source File | What it does |
|---------|-------------|-------------|
| `app.singleton` | `src/renderer/Application.ts` | Bootstraps all subsystems |
| `bridge.scene` | `src/renderer/SceneBridge.ts` | Syncs geometry → Three.js |
| `engine.geometry` | `src/engine/geometry/GeometryEngine.ts` | B-Rep geometry kernel |
| `data.document` | `src/data/ModelDocument.ts` | Owns all state |
| `renderer.webgl` | `src/renderer/WebGLRenderer.ts` | Three.js rendering |
| `camera.main` | `src/renderer/CameraController.ts` | Camera orbit/pan/zoom |
| `viewport.main` | `src/renderer/Viewport.ts` | Raycasting, coordinate transforms |
| `system.snap` | `src/renderer/SceneBridge.ts` | Vertex snap detection |
| `system.autoface` | `src/engine/geometry/GeometryEngine.ts` | Auto face creation & splitting |
| `system.undo` | `src/data/HistoryManager.ts` | Snapshot-based undo/redo |
| `system.keyboard` | `src/renderer/App.tsx` | Global keyboard event router |
| `system.components` | `src/data/SceneManager.ts` | Component grouping system |
| `system.layers` | `src/data/SceneManager.ts` | Layer visibility/locking |
| `tool.*` | `src/tools/*.ts` | One file per tool |

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│  Electron Main Process (src/main/)                  │
│  ├── Window management, IPC, native file dialogs    │
│  └── Preload script (contextBridge)                 │
└──────────────────────┬──────────────────────────────┘
                       │ IPC
┌──────────────────────▼──────────────────────────────┐
│  Renderer Process (src/renderer/)                   │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  React UI   │  │  Application │  │  Three.js  │  │
│  │  App.tsx    │◄─┤  singleton   ├─►│  Viewport  │  │
│  │  Panels    │  │              │  │  Renderer  │  │
│  │  Toolbars  │  │  owns all    │  │  Camera    │  │
│  └─────────────┘  │  subsystems  │  └───────────┘  │
│                    └──────┬───────┘                  │
│           ┌───────────────┼───────────────┐         │
│  ┌────────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ │
│  │  SceneBridge  │ │ ToolManager │ │  Inference   │ │
│  │  Geo→Three.js │ │  23 tools   │ │   Engine     │ │
│  │  Snap system  │ │  BaseTool   │ │  Constraints │ │
│  └────────┬──────┘ └──────┬──────┘ └─────────────┘ │
│           │               │                         │
│  ┌────────▼───────────────▼────────────────────┐    │
│  │  Data Layer (src/data/)                     │    │
│  │  ├── ModelDocument (owns everything below)  │    │
│  │  ├── GeometryEngine (B-Rep half-edge mesh)  │    │
│  │  ├── SceneManager (layers, components)      │    │
│  │  ├── SelectionManager                       │    │
│  │  ├── HistoryManager (snapshot undo/redo)    │    │
│  │  └── MaterialManager                       │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Data Flow

```
Mouse Event → ViewportCanvas.getToolEvent()
  ├── Raycast (Viewport.raycastScene)
  │   ├── Filter hidden/locked layers
  │   ├── Resolve component IDs
  │   └── Prioritize faces over edges
  ├── Snap detection (SceneBridge.findSnapPoint)
  └── Tool.onMouseDown/Move/Up(event)
        ├── Modify geometry (GeometryEngine)
        ├── app.syncScene() → SceneBridge.sync()
        │   ├── Create/update/remove Three.js objects
        │   └── Update component bounding boxes
        └── app.syncSelection() → highlight + UI update
```

## Project Structure

```
src/
├── core/                  # Shared types, interfaces, math utilities
│   ├── types.ts           # Vec3, Color, EntityType, RenderMode, etc.
│   ├── interfaces.ts      # ITool, IGeometryEngine, IViewport, etc.
│   ├── math.ts            # vec3, ray, bbox utilities
│   └── events.ts          # SimpleEventEmitter
├── main/                  # Electron main process
│   ├── main.ts            # Window, IPC handlers, menus
│   └── preload.ts         # contextBridge API
├── renderer/              # React UI + Three.js
│   ├── Application.ts     # Orchestrator singleton
│   ├── SceneBridge.ts     # Geometry ↔ Three.js sync + snap
│   ├── WebGLRenderer.ts   # Three.js setup, lighting, highlights
│   ├── CameraController.ts # Orbit, pan, zoom, standard views
│   ├── Viewport.ts        # Canvas, raycasting, coordinates
│   ├── App.tsx             # Root React component + keyboard handler
│   ├── context/           # React context (AppContext)
│   ├── components/        # UI panels (EntityInfo, Outliner, Layers, etc.)
│   └── shaders/           # PBR, outline, selection, x-ray materials
├── engine/
│   └── geometry/
│       ├── GeometryEngine.ts  # B-Rep kernel (create/delete/query/autoface)
│       ├── HalfEdgeMesh.ts    # Half-edge data structure
│       └── Curves.ts          # Arc and polyline curves
├── data/
│   ├── ModelDocument.ts   # Owns scene, selection, history, materials, geometry
│   ├── SceneManager.ts    # Layers, components, entity management
│   ├── SelectionManager.ts # Selection state, pre-selection
│   ├── HistoryManager.ts  # Snapshot-based undo/redo
│   └── MaterialManager.ts # PBR materials
├── tools/                 # 23 tools, each in its own file
│   ├── BaseTool.ts        # Abstract base (plane switching, VCB, transactions)
│   ├── SelectTool.ts      # Click, shift-click, drag-box selection
│   ├── LineTool.ts        # Multi-point line with auto-face
│   ├── RectangleTool.ts   # Two-click rectangle with plane switching
│   ├── PushPullTool.ts    # Face extrusion with preview
│   ├── MoveTool.ts        # Live vertex movement
│   └── ... (18 more)
├── operations/            # Geometry operations (extrude, boolean, fillet, etc.)
├── file/                  # File format handlers (OBJ, STL, glTF, DXF)
├── workers/               # Web workers for heavy operations
└── plugins/               # Plugin system
tests/
└── e2e-playwright/        # Real Electron E2E tests (no mocks)
    ├── helpers.ts          # Launch/close Electron app
    ├── drawing-tools.spec.ts
    ├── pushpull.spec.ts
    ├── undo-redo.spec.ts
    ├── arrow-plane.spec.ts
    ├── arc-bisect.spec.ts
    └── ... (more test files)
```

## Key Design Decisions

These are the non-obvious decisions discovered during implementation. Read these before contributing:

### Keyboard Events
ALL keyboard events go through a single `window` listener in `App.tsx`. No `onKeyDown` on the viewport container (prevents double-firing with toggle-based plane switching). Electron menu items have NO accelerators — all shortcuts go through this handler.

### Edge Rendering
Edge lines are in the **overlay scene**, rendered in a separate pass after the main scene with depth cleared. This guarantees edges always draw on top of faces. Edge materials are shared and NEVER swapped by the highlight system.

### Selection Highlighting
Only face mesh materials are swapped for highlights (never edge materials). Highlight materials use `polygonOffset: -1` to render slightly in front. Faces use `DoubleSide` for raycasting from any angle.

### Raycasting
Viewport dimensions are stored from ResizeObserver and used for NDC calculation. Camera matrices (`projectionMatrixInverse`) are explicitly recomputed before every raycast. Line threshold is 0.05 (not default 1.0). Faces are returned before edges in results. Preview/snap objects use `raycast = () => {}` to exclude from picking.

### Undo/Redo
Snapshot-based using `geometry.serialize()/deserialize()`. Critical: `newDocument()` calls `history.clear()` not `new HistoryManager()` — preserves the snapshot callbacks. Line tool commits on deactivate (not abort).

### Face Splitting
`splitFaceWithPath()` handles arc endpoints that land ON face edges (not just corners). It detects proximity (0.05 threshold), inserts the vertex into the face boundary, splits the underlying edge, and creates both faces with arc vertices on their shared boundary (no chord edge).

### Middle Mouse
Window-level `mouseup` listener catches releases outside the viewport. Safety check: `if (middleMouseRef.current.active && e.buttons === 0)` resets stuck state.

## Contributing

### Getting Started

1. Fork and clone the repo
2. `npm install`
3. `npm run build`
4. `npx electron dist/main/main.js` — run the app
5. `npx playwright test` — run E2E tests

### Using AI to Contribute

This project includes an **ArchiGraph** (`archigraph.yaml`) and detailed **CLAUDE.md** designed for AI-assisted development:

1. Start by reading `CLAUDE.md` — it has the architecture summary, file mappings, and critical gotchas
2. Search `archigraph.yaml` for the system you're working on — node descriptions explain what each component does and edges show how they connect
3. Run the E2E tests after changes — they test the real running Electron app with no mocks
4. Update `CLAUDE.md` with any non-obvious decisions you discover during implementation

### Writing Tests

Tests use Playwright against the real Electron app:

```typescript
import { test, expect } from '@playwright/test';
import { launchApp, closeApp } from './helpers';

let app, page;
test.beforeAll(async () => { ({ app, page } = await launchApp()); });
test.afterAll(async () => { await closeApp(app); });

test('draw a rectangle', async () => {
  // Switch to top view for reliable ground plane hits
  await page.locator('.views-toolbar .view-btn:has-text("Top")').click();

  // Activate rectangle tool
  await page.keyboard.press('r');

  // Click two corners
  const canvas = page.locator('.viewport-container canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 200, box.y + 200);
  await page.waitForTimeout(200);

  // Use VCB for exact dimensions
  const vcb = page.locator('.vcb-input');
  await vcb.click();
  await vcb.fill('4,3');
  await vcb.press('Enter');

  // Verify geometry was created
  const faces = await page.evaluate(() => {
    return (window as any).__debugApp.document.geometry.getMesh().faces.size;
  });
  expect(faces).toBeGreaterThanOrEqual(1);
});
```

### Areas for Contribution

- **Face splitting** — improve edge cases for lines/arcs bisecting faces
- **Push/Pull preview** — show live 3D extrusion during drag (currently shows outline only)
- **Material system** — color picker, texture loading, PBR material editing
- **File formats** — improve OBJ import, add STL/glTF export
- **Performance** — spatial indexing for snap detection, frustum culling
- **Boolean operations** — union/subtract/intersect solids via Manifold WASM
- **Groups** — proper group/component hierarchy with instancing
- **Measurements** — working tape measure, dimension annotations
- **UI polish** — toolbar icons (currently emoji), theme switching, responsive panels

## License

MIT

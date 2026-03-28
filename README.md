# SketchCraft

A free, open-source 3D modeling application inspired by SketchUp, built with Electron + React + Three.js. Draw 2D shapes, push/pull them into 3D solids, and build architectural models with an intuitive click-based workflow.

![Electron](https://img.shields.io/badge/Electron-28-blue) ![Three.js](https://img.shields.io/badge/Three.js-0.162-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue) ![React](https://img.shields.io/badge/React-18-blue)

<video src="https://github.com/CacheFactory/SketchCraft/raw/main/docs/sketchcraft-demo.mp4" controls width="100%"></video>

## Features

- **Push/Pull modeling** — draw a 2D face, extrude it into a 3D solid
- **Drawing tools** — Line, Rectangle, Circle, Arc, Polygon with live previews
- **Modify tools** — Move, Rotate, Scale, Offset, Eraser with real-time feedback
- **Axis locking** — arrow keys lock line drawing to X/Y/Z axis for precision
- **Snap system** — automatic vertex/midpoint snapping with visual indicators
- **Auto-face creation** — closed edge loops automatically become faces
- **Face splitting** — draw a line or arc across a face to split it (handles edge midpoints)
- **Selection** — click, shift-click, or drag-box to select faces and edges
- **Undo/Redo** — full snapshot-based undo history
- **Components** — group geometry into protected reusable components
- **Layers** — organize geometry with visibility and locking
- **Drawing planes** — arrow keys switch shape tool planes (ground, vertical walls)
- **OBJ file I/O** — save and open standard OBJ files
- **Middle-mouse orbit** — orbit/pan without switching tools, zoom to cursor
- **Infinite grid** — shader-based ground grid that extends to infinity

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
| `M` | Move | | `Arrow Up` | Lock to Y axis (vertical) |
| `Q` | Rotate | | `Arrow Right` | Lock to X axis (red) |
| `S` | Scale | | `Arrow Left` | Lock to Z axis (blue) |
| `F` | Offset | | `Arrow Down` | Unlock axis / reset plane |
| `E` | Eraser | | Middle Mouse | Orbit |
| `B` | Paint | | Shift+Middle Mouse | Pan |
| `O` | Orbit | | Scroll Wheel | Zoom to cursor |
| `H` | Pan | | | |
| `Z` | Zoom | | | |
| `T` | Tape Measure | | | |
| `D` | Dimension | | | |

## Architecture

SketchCraft uses an **ArchiGraph** — a machine-readable architecture graph (126 nodes, 559 edges) that maps every component, service, and relationship in the system.

### [View the interactive architecture diagram →](https://archigraph.ai/viewer?archigraph=https://raw.githubusercontent.com/CacheFactory/SketchCraft/main/archigraph.yaml&schema=https://raw.githubusercontent.com/CacheFactory/SketchCraft/main/schema.yaml)

The ArchiGraph is the fastest way for new contributors (human or AI) to understand the codebase. Each node has a `docs.description` explaining what it does and an `impl.status` showing its current state:

| Status | Count | Meaning |
|--------|-------|---------|
| `implemented` | 89 | Fully working |
| `basic` | 19 | Code exists, simplified or partial |
| `placeholder` | 5 | Tool exists but not functional |
| `spec-only` | 10 | Requirements doc only, no code |
| `stub` | 5 | Depends on missing WASM packages |

### Project Structure

Each archigraph node has its own folder under `implementations/` containing both the architecture spec and the source code:

```
src/
├── core/                      # Shared types, interfaces, math (used by all)
│   ├── types.ts               # Vec3, Color, EntityType, RenderMode
│   ├── interfaces.ts          # ITool, IGeometryEngine, IViewport
│   ├── math.ts                # vec3, ray, bbox utilities
│   └── events.ts              # SimpleEventEmitter
└── renderer/
    ├── index.tsx              # Webpack entry point
    └── index.html             # HTML template

implementations/
├── process.main/              # Electron main process
│   ├── CLAUDE.md              # Architecture spec
│   ├── main.ts                # Window, IPC, menus, file dialogs
│   └── preload.ts             # contextBridge API
├── process.renderer/          # Application orchestrator
│   ├── CLAUDE.md
│   └── Application.ts         # Bootstraps all subsystems
├── window.main/               # Main window UI
│   ├── CLAUDE.md
│   ├── App.tsx                # Root component + keyboard handler
│   ├── AppContext.tsx          # React context
│   ├── MainToolbar.tsx        # File ops, undo/redo
│   ├── DrawingToolbar.tsx     # Tool sidebar
│   ├── EntityInfoPanel.tsx    # Selection info + component buttons
│   ├── LayersPanel.tsx        # Layer management
│   └── ... (more UI components)
├── engine.geometry/           # B-Rep geometry kernel
│   ├── CLAUDE.md
│   └── GeometryEngine.ts     # Create/delete/query, auto-face, face splitting
├── mesh.halfedge/             # Half-edge data structure
│   ├── CLAUDE.md
│   └── HalfEdgeMesh.ts
├── renderer.webgl/            # Three.js rendering
│   ├── CLAUDE.md
│   ├── WebGLRenderer.ts       # Render loop, lighting, highlights
│   └── SceneBridge.ts         # Geometry↔Three.js sync, snap system
├── camera.main/               # Camera controller
│   ├── CLAUDE.md
│   └── CameraController.ts   # Orbit, pan, zoom, standard views
├── viewport.main/             # Viewport + raycasting
│   ├── CLAUDE.md
│   ├── Viewport.ts            # Canvas, raycast, coordinates
│   └── ViewportCanvas.tsx     # React wrapper, mouse events
├── tool.line/                 # Line tool
│   ├── CLAUDE.md
│   └── lineTool.ts            # Axis locking, auto-face, midpoint snap
├── tool.pushpull/             # Push/Pull tool
│   ├── CLAUDE.md
│   └── PushPullTool.ts        # Face extrusion with preview
├── tool.select/               # Select tool + shared tool infrastructure
│   ├── CLAUDE.md
│   ├── selectTool.ts          # Click, shift-click, drag-box, cursor
│   ├── BaseTool.ts            # Abstract base for all tools
│   └── ToolManager.ts         # Tool registry
├── data.scene/                # Scene manager
│   ├── CLAUDE.md
│   └── SceneManager.ts        # Layers, components, entities
├── data.history/              # Undo/redo
│   ├── CLAUDE.md
│   └── HistoryManager.ts      # Snapshot-based
├── ... (60+ more node folders)

tests/
└── e2e-playwright/            # Real Electron E2E tests (no mocks)
```

### How to use the ArchiGraph

**"How does X work?"** → Search `archigraph.yaml` for the node ID, read `docs.description`, follow edges.

**"Where is X implemented?"** → Look in `implementations/<node-id>/` — spec and code are side by side.

**"What needs work?"** → Search for `impl.status: placeholder` or `impl.status: stub` in `archigraph.yaml`.

### Key Node-to-Folder Mapping

| Node ID | Folder | What it does |
|---------|--------|-------------|
| `process.main` | `implementations/process.main/` | Electron main process |
| `process.renderer` | `implementations/process.renderer/` | Application orchestrator |
| `window.main` | `implementations/window.main/` | All UI components |
| `engine.geometry` | `implementations/engine.geometry/` | B-Rep geometry kernel |
| `mesh.halfedge` | `implementations/mesh.halfedge/` | Half-edge mesh data structure |
| `renderer.webgl` | `implementations/renderer.webgl/` | Three.js renderer + SceneBridge |
| `camera.main` | `implementations/camera.main/` | Camera controller |
| `viewport.main` | `implementations/viewport.main/` | Viewport + raycasting |
| `data.scene` | `implementations/data.scene/` | Layers, components |
| `data.history` | `implementations/data.history/` | Snapshot undo/redo |
| `tool.*` | `implementations/tool.*/` | One folder per tool |

### System Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process (implementations/process.main/)  │
│  ├── Window management, IPC, native file dialogs        │
│  └── Preload script (contextBridge)                     │
└──────────────────────┬──────────────────────────────────┘
                       │ IPC
┌──────────────────────▼──────────────────────────────────┐
│  Renderer Process                                       │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐      │
│  │  React UI   │  │  Application │  │  Three.js  │      │
│  │  window.    │◄─┤  process.    ├─►│  renderer. │      │
│  │  main/      │  │  renderer/   │  │  webgl/    │      │
│  └─────────────┘  └──────┬───────┘  └───────────┘      │
│           ┌───────────────┼───────────────┐             │
│  ┌────────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐     │
│  │  SceneBridge  │ │ ToolManager │ │  Inference   │     │
│  │  renderer.    │ │  tool.      │ │  engine.     │     │
│  │  webgl/       │ │  select/    │ │  inference/  │     │
│  └────────┬──────┘ └──────┬──────┘ └─────────────┘     │
│           │               │                             │
│  ┌────────▼───────────────▼────────────────────────┐    │
│  │  Data Layer                                     │    │
│  │  ├── data.document/  (owns everything below)    │    │
│  │  ├── engine.geometry/ (B-Rep half-edge mesh)    │    │
│  │  ├── data.scene/     (layers, components)       │    │
│  │  ├── data.selection/                            │    │
│  │  ├── data.history/   (snapshot undo/redo)       │    │
│  │  └── data.materials/                            │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
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

## Key Design Decisions

These are the non-obvious decisions discovered during implementation. Read these before contributing:

### Keyboard Events
ALL keyboard events go through a single `window` listener in `App.tsx`. No `onKeyDown` on the viewport container (prevents double-firing). Electron menu items have NO accelerators.

### Edge Rendering
Edge lines are in the **overlay scene**, rendered in a separate pass after depth clear. Edge materials are shared and NEVER swapped by the highlight system.

### Raycasting
Camera `projectionMatrixInverse` is explicitly recomputed before every raycast. Line threshold is 0.05. Faces returned before edges. Preview/snap objects use `raycast = () => {}`.

### Undo/Redo
Snapshot-based using `geometry.serialize()/deserialize()`. `newDocument()` calls `history.clear()` not `new HistoryManager()`. Line tool commits on deactivate.

### Face Splitting
`splitFaceWithPath()` handles arc endpoints ON face edges (not just corners) via proximity detection and vertex insertion. Both resulting faces include arc vertices on their shared boundary (no chord edge).

### Axis Locking (Line Tool)
Arrow keys lock to axis: Up=Y (vertical), Right=X, Left=Z. Uses ray-to-line projection for accurate 3D positioning from any camera angle. Lock resets after placing each point.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines, including how to use the ArchiGraph for AI-assisted development.

### Areas for Contribution

Look for nodes with `impl.status: placeholder` or `impl.status: stub` in `archigraph.yaml`:

- **Boolean operations** — union/subtract/intersect solids (needs Manifold WASM)
- **Follow Me tool** — sweep profile along path
- **Dimension/Text tools** — annotation rendering
- **Section planes** — clipping plane visualization
- **Push/Pull live preview** — show 3D extrusion during drag
- **Material system** — color picker, texture loading
- **Performance** — spatial indexing for snap detection, frustum culling
- **File formats** — improve OBJ, add glTF/STL export

## License

MIT

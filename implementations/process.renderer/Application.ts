// @archigraph process.renderer
// Main application singleton — bootstraps and coordinates all subsystems

import type {
  IApplication, IModelDocument, IViewport, IToolManager,
  IInferenceEngine, ITool,
} from '../../src/core/interfaces';
import { ModelDocument } from '../data.document/ModelDocument';
import { GeometryEngine } from '../engine.geometry/GeometryEngine';
import { Viewport } from '../viewport.main/Viewport';
import { ToolManager } from '../tool.select/ToolManager';
import { InferenceEngine } from '../engine.inference/InferenceEngine';
import { SceneBridge } from '../renderer.webgl/SceneBridge';

// Tool imports (static for reliability)
import { SelectTool } from '../tool.select/selectTool';
import { LineTool } from '../tool.line/lineTool';
import { RectangleTool } from '../tool.rectangle/rectangleTool';
import { CircleTool } from '../tool.circle/circleTool';
import { ArcTool } from '../tool.arc/arcTool';
import { PolygonTool } from '../tool.polygon/polygonTool';
import { PushPullTool } from '../tool.pushpull/PushPullTool';
import { MoveTool } from '../tool.move/moveTool';
import { RotateTool } from '../tool.rotate/rotateTool';
import { ScaleTool } from '../tool.scale/scaleTool';
import { OffsetTool } from '../tool.offset/offsetTool';
import { EraserTool } from '../tool.eraser/eraserTool';
import { PaintTool } from '../tool.paint/paintTool';
import { OrbitTool } from '../tool.orbit/OrbitTool';
import { PanTool } from '../tool.pan/panTool';
import { ZoomTool } from '../tool.zoom/zoomTool';
import { FollowMeTool } from '../tool.follow_me/FollowMeTool';
import { TapeMeasureTool } from '../tool.tape_measure/TapeMeasureTool';
import { ProtractorTool } from '../tool.protractor/protractorTool';
import { DimensionTool } from '../tool.dimension/dimensionTool';
import { TextTool } from '../tool.text/textTool';
import { SectionPlaneTool } from '../tool.section_plane/SectionPlaneTool';
import { SolidToolsTool } from '../tool.solid_tools/SolidToolsTool';
import { AxesTool } from '../tool.axes/AxesTool';
// SKP files are converted to OBJ by the native skp2obj tool in the main process

export class Application implements IApplication {
  document!: IModelDocument;
  viewport!: IViewport;
  toolManager!: IToolManager;
  inference!: IInferenceEngine;
  sceneBridge!: SceneBridge;

  private initialized = false;

  async initialize(container: HTMLElement): Promise<void> {
    if (this.initialized) return;

    // 1. Create geometry engine and document
    const geometryEngine = new GeometryEngine();
    this.document = new ModelDocument(geometryEngine);
    this.document.newDocument();

    // 2. Initialize viewport (creates canvas, Three.js renderer, camera)
    this.viewport = new Viewport();
    this.viewport.initialize(container);

    // 3. Scene bridge: syncs geometry engine -> Three.js scene
    const vp = this.viewport as Viewport;
    this.sceneBridge = new SceneBridge(geometryEngine, vp.getWebGLRenderer());
    this.sceneBridge.setSceneManager(this.document.scene as any);
    this.sceneBridge.setMaterialManager(this.document.materials);

    // 4. Initialize inference engine
    this.inference = new InferenceEngine();

    // 5. Create tool manager and register all tools
    this.toolManager = new ToolManager();
    this.registerTools();

    // 6. Default to select tool
    this.toolManager.activateTool('tool.select');

    // 7. Listen for IPC menu actions
    this.setupIPCListeners();

    this.initialized = true;
    console.log('SketchCraft initialized successfully');
  }

  private registerTools(): void {
    const doc = this.document;
    const vp = this.viewport;
    const inf = this.inference;

    const tools: ITool[] = [
      new SelectTool(doc, vp, inf),
      new LineTool(doc, vp, inf),
      new RectangleTool(doc, vp, inf),
      new CircleTool(doc, vp, inf),
      new ArcTool(doc, vp, inf),
      new PolygonTool(doc, vp, inf),
      new PushPullTool(doc, vp, inf),
      new MoveTool(doc, vp, inf),
      new RotateTool(doc, vp, inf),
      new ScaleTool(doc, vp, inf),
      new OffsetTool(doc, vp, inf),
      new EraserTool(doc, vp, inf),
      new PaintTool(doc, vp, inf),
      new OrbitTool(doc, vp, inf),
      new PanTool(doc, vp, inf),
      new ZoomTool(doc, vp, inf),
      new FollowMeTool(doc, vp, inf),
      new TapeMeasureTool(doc, vp, inf),
      new ProtractorTool(doc, vp, inf),
      new DimensionTool(doc, vp, inf),
      new TextTool(doc, vp, inf),
      new SectionPlaneTool(doc, vp, inf),
      new SolidToolsTool(doc, vp, inf),
      new AxesTool(doc, vp, inf),
    ];

    for (const tool of tools) {
      this.toolManager.registerTool(tool);
    }
  }

  private setupIPCListeners(): void {
    if (typeof window === 'undefined' || typeof window.api === 'undefined') return;

    window.api.on('menu:action', ({ action }) => {
      switch (action) {
        case 'new': this.newDocument(); break;
        case 'open': this.openDocument(); break;
        case 'save': this.saveDocument(); break;
        case 'save-as': this.saveDocumentAs(); break;
        case 'import': this.importFile(); break;
        case 'undo': this.document.history.undo(); this.sceneBridge.sync(); break;
        case 'redo': this.document.history.redo(); this.sceneBridge.sync(); break;
        case 'delete':
          const ids = Array.from(this.document.selection.state.entityIds);
          this.document.history.beginTransaction('Delete');
          ids.forEach(id => this.document.scene.removeEntity(id));
          this.document.selection.clear();
          this.document.history.commitTransaction();
          this.sceneBridge.sync();
          break;
        case 'select-all':
          this.document.selection.selectAll();
          break;
      }
    });
  }

  /** Sync geometry to scene after tool operations. */
  syncScene(): void {
    this.sceneBridge.sync();
    this.syncDimensions();
  }

  /** Update associative dimensions when geometry moves, remove orphaned ones on undo. */
  private syncDimensions(): void {
    const { dimensionStore } = require('../tool.dimension/DimensionStore');
    const { vec3 } = require('../../src/core/math');

    // Remove dimensions whose vertices were undone/deleted
    const removed = dimensionStore.reconcile(this.document.geometry);
    for (const dim of removed) {
      // Remove guide lines
      for (const lineId of dim.guideLineIds) {
        this.viewport.renderer.removeGuideLine(lineId);
      }
      // Remove sprite from overlay scene
      const overlayScene = (this.viewport.renderer as any).getOverlayScene?.();
      if (overlayScene && dim.sprite.parent) {
        dim.sprite.parent.remove(dim.sprite);
        dim.sprite.material.dispose();
        if ((dim.sprite.material as any).map) (dim.sprite.material as any).map.dispose();
      }
      // Unregister from renderer
      (this.viewport.renderer as any).unregisterEntityObject?.(dim.id);
    }

    // Update surviving dimensions that track moved vertices
    const updates = dimensionStore.syncToGeometry(this.document.geometry);
    const dimColor = { r: 0.2, g: 0.2, b: 0.2 };
    const tickSize = 0.08;

    for (const { dim, dimStart, dimEnd, extStart1, extStart2, offsetDir } of updates) {
      const ids = dim.guideLineIds;
      if (ids.length >= 5) {
        this.viewport.renderer.addGuideLine(ids[0], extStart1, dimStart, dimColor, true);
        this.viewport.renderer.addGuideLine(ids[1], extStart2, dimEnd, dimColor, true);
        this.viewport.renderer.addGuideLine(ids[2], dimStart, dimEnd, dimColor, false);

        const tick1a = vec3.add(dimStart, vec3.mul(offsetDir, tickSize));
        const tick1b = vec3.add(dimStart, vec3.mul(offsetDir, -tickSize));
        this.viewport.renderer.addGuideLine(ids[3], tick1a, tick1b, dimColor, false);

        const tick2a = vec3.add(dimEnd, vec3.mul(offsetDir, tickSize));
        const tick2b = vec3.add(dimEnd, vec3.mul(offsetDir, -tickSize));
        this.viewport.renderer.addGuideLine(ids[4], tick2a, tick2b, dimColor, false);
      }
    }
  }

  /** Sync selection highlights to the 3D renderer and return current selection state. */
  syncSelection(): { entityIds: string[]; count: number } {
    const sel = this.document.selection;
    const ids = Array.from(sel.state.entityIds);
    const sm = this.document.scene as any;

    // Resolve component IDs to their member face/edge IDs for highlighting
    const highlightIds: string[] = [];
    for (const id of ids) {
      if (sm?.components?.has(id)) {
        const comp = sm.components.get(id);
        if (comp) {
          for (const eid of comp.entityIds) highlightIds.push(eid);
        }
      } else {
        highlightIds.push(id);
      }
    }

    // Update 3D selection highlights
    this.viewport.renderer.setSelectionHighlight(highlightIds);

    // Pre-selection: also resolve component IDs
    let preSelId = sel.state.preSelectionId;
    const preSelHighlightIds: string[] = [];
    if (preSelId && sm?.components?.has(preSelId)) {
      const comp = sm.components.get(preSelId);
      if (comp) {
        for (const eid of comp.entityIds) preSelHighlightIds.push(eid);
      }
      // Highlight all component members as pre-selection
      this.viewport.renderer.setPreSelectionHighlight(null);
      for (const eid of preSelHighlightIds) {
        const obj = (this.viewport.renderer as any)._entityObjects?.get(eid);
        if (obj) (this.viewport.renderer as any)._applyHighlight(obj, 'preselection');
      }
    } else {
      this.viewport.renderer.setPreSelectionHighlight(preSelId);
    }

    return { entityIds: ids, count: ids.length };
  }

  dispose(): void {
    this.sceneBridge?.dispose();
    this.viewport?.dispose();
    this.initialized = false;
  }

  async newDocument(): Promise<void> {
    this.document.newDocument();
    this.document.selection.clear();
    this.sceneBridge.sync();
  }

  async openDocument(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const result = await (window.api as any).invoke('file:open');
    if (!result) return;

    const ext = result.filePath.split('.').pop()?.toLowerCase();
    if (ext === 'skp') {
      // Convert SKP to OBJ using native skp2obj tool
      const converted = await (window.api as any).invoke('file:convert-skp', { filePath: result.filePath });
      if (converted) {
        this.importOBJ(converted.data);
      } else {
        console.error('Failed to convert SKP file');
        return;
      }
    } else {
      this.importOBJ(result.data);
    }
    this.document.filePath = result.filePath;
    this.document.markClean();
    this.sceneBridge.sync();
  }

  async saveDocument(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    if (this.document.filePath) {
      const data = this.exportOBJ();
      await window.api.invoke('file:write', { filePath: this.document.filePath, data });
      this.document.markClean();
    } else {
      await this.saveDocumentAs();
    }
  }

  async saveDocumentAs(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const data = this.exportOBJ();
    const result = await window.api.invoke('file:export', {
      data,
      format: '.obj',
      defaultName: this.document.metadata.name,
    });
    if (result) {
      this.document.filePath = result.filePath;
      this.document.markClean();
    }
  }

  /** Export current geometry to OBJ format as ArrayBuffer */
  private exportOBJ(): ArrayBuffer {
    const mesh = this.document.geometry.getMesh();
    const lines: string[] = ['# SketchCraft OBJ Export'];

    // Map vertex IDs to OBJ indices (1-based)
    const vertexIndex = new Map<string, number>();
    let idx = 1;

    mesh.vertices.forEach((v, id) => {
      lines.push(`v ${v.position.x} ${v.position.y} ${v.position.z}`);
      vertexIndex.set(id, idx++);
    });

    lines.push('');

    // Faces
    mesh.faces.forEach((face) => {
      const indices = face.vertexIds.map(vid => vertexIndex.get(vid)).filter(Boolean);
      if (indices.length >= 3) {
        lines.push('f ' + indices.join(' '));
      }
    });

    // Edges (as lines for edges not part of faces)
    mesh.edges.forEach((edge) => {
      const i1 = vertexIndex.get(edge.startVertexId);
      const i2 = vertexIndex.get(edge.endVertexId);
      if (i1 && i2) {
        lines.push(`l ${i1} ${i2}`);
      }
    });

    const text = lines.join('\n');
    return new TextEncoder().encode(text).buffer;
  }

  /** Import OBJ data into the current document */
  private importOBJ(data: ArrayBuffer): void {
    const text = new TextDecoder().decode(data);
    const objLines = text.split('\n');

    this.document.newDocument();
    const geo = this.document.geometry;

    const vertexIds: string[] = []; // 0-indexed

    for (const line of objLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0];

      if (cmd === 'v' && parts.length >= 4) {
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        const v = geo.createVertex({ x, y, z });
        vertexIds.push(v.id);
      } else if (cmd === 'f' && parts.length >= 4) {
        // Face indices are 1-based, may have /vt/vn suffixes
        const faceVertIds: string[] = [];
        for (let i = 1; i < parts.length; i++) {
          const idxStr = parts[i].split('/')[0];
          const objIdx = parseInt(idxStr, 10);
          if (objIdx > 0 && objIdx <= vertexIds.length) {
            faceVertIds.push(vertexIds[objIdx - 1]);
          }
        }
        if (faceVertIds.length >= 3) {
          // Create edges
          for (let i = 0; i < faceVertIds.length; i++) {
            const next = (i + 1) % faceVertIds.length;
            geo.createEdge(faceVertIds[i], faceVertIds[next]);
          }
          try { geo.createFace(faceVertIds); } catch {}
        }
      } else if (cmd === 'l' && parts.length >= 3) {
        // Line/edge
        for (let i = 1; i < parts.length - 1; i++) {
          const i1 = parseInt(parts[i], 10);
          const i2 = parseInt(parts[i + 1], 10);
          if (i1 > 0 && i2 > 0 && i1 <= vertexIds.length && i2 <= vertexIds.length) {
            geo.createEdge(vertexIds[i1 - 1], vertexIds[i2 - 1]);
          }
        }
      }
    }
  }

  async importFile(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const result = await window.api.invoke('file:import', {
      formats: ['.skp', '.obj', '.stl', '.gltf', '.glb', '.dxf', '.step', '.stp', '.fbx'],
    });
    if (result) {
      const ext = result.format?.toLowerCase() || result.filePath?.split('.').pop()?.toLowerCase();
      if (ext === 'skp') {
        const converted = await (window.api as any).invoke('file:convert-skp', { filePath: result.filePath });
        if (converted) {
          this.importOBJ(converted.data);
          this.sceneBridge.sync();
        }
      } else if (ext === 'obj') {
        this.importOBJ(result.data);
        this.sceneBridge.sync();
      } else {
        console.log(`Importing ${result.format} file: ${result.filePath}`);
      }
    }
  }

  async exportFile(format: string): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const data = this.document.serialize();
    await window.api.invoke('file:export', {
      data,
      format,
      defaultName: this.document.metadata.name,
    });
  }

  activateTool(toolId: string): void {
    this.toolManager.activateTool(toolId);
  }

  getActiveTool(): ITool | null {
    return this.toolManager.getActiveTool();
  }

  getAvailableTools(): ITool[] {
    return this.toolManager.getAllTools();
  }
}

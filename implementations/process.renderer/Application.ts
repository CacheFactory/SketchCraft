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
import * as THREE from 'three';

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
import { ModelAPI, IModelAPI } from '../api.model/ModelAPI';
// @archigraph file.obj-format
import { importObj, parseMtl, mergeCoplanarFaces } from '../file.obj/ObjFormat';
import type { ObjImportResult, ObjMaterial } from '../file.obj/ObjFormat';
// SKP files are converted to OBJ by the native skp2obj tool in the main process

export class Application implements IApplication {
  document!: IModelDocument;
  viewport!: IViewport;
  toolManager!: IToolManager;
  inference!: IInferenceEngine;
  sceneBridge!: SceneBridge;
  modelAPI!: IModelAPI;

  private initialized = false;
  private _componentBBoxLines: string[] = [];

  async initialize(container: HTMLElement): Promise<void> {
    if (this.initialized) return;

    // 1. Create geometry engine and document
    const geometryEngine = new GeometryEngine();
    this.document = new ModelDocument(geometryEngine);
    this.document.newDocument();

    // Wire component protection: geometry engine skips faces/edges in protected components
    const sm = this.document.scene as any;
    geometryEngine.isProtectedEntity = (entityId: string) => {
      return sm?.isEntityProtected ? sm.isEntityProtected(entityId) : false;
    };

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

    // 6. Create Model API facade
    this.modelAPI = new ModelAPI(
      this.document,
      () => this.syncScene(),
      this.viewport.camera,
      this.viewport,
    );

    // Expose on window for plugins and dev console
    (window as any).modelAPI = this.modelAPI;

    // 7. Default to select tool
    this.toolManager.activateTool('tool.select');

    // 8. Listen for IPC menu actions
    this.setupIPCListeners();

    this.initialized = true;
    console.log('DraftDown initialized successfully');
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

    // Listen for geometry-changed events from tools that mutate geometry directly
    window.addEventListener('geometry-changed', () => {
      this.syncScene();
    });

    window.api.on('menu:action', ({ action }) => {
      switch (action) {
        case 'new': this.newDocument(); break;
        case 'open': this.openDocument(); break;
        case 'save': this.saveDocument(); break;
        case 'save-as': this.saveDocumentAs(); break;
        case 'import': this.importFile(); break;
        case 'undo': this.document.history.undo(); this.sceneBridge.sync(true); break;
        case 'redo': this.document.history.redo(); this.sceneBridge.sync(true); break;
        case 'delete': {
          const ids = Array.from(this.document.selection.state.entityIds);
          this.document.history.beginTransaction('Delete');
          const geo = this.document.geometry;
          for (const id of ids) {
            const face = geo.getFace(id);
            const edge = geo.getEdge(id);
            const vertex = geo.getVertex(id);
            // Try geometry deletion first (faces, edges, vertices)
            if (face) {
              geo.deleteFace(id);
            } else if (edge) {
              geo.deleteEdge(id);
            } else if (vertex) {
              geo.deleteVertex(id);
            } else {
              // Fall back to scene entity deletion (groups, components)
              this.document.scene.removeEntity(id);
            }
          }
          this.document.selection.clear();
          this.document.history.commitTransaction();
          this.sceneBridge.sync();
          break;
        }
        // 'export' is handled by ExportModal in App.tsx
        case 'zoom-extents': this.viewport.camera.fitToBox(this.document.geometry.getBoundingBox()); break;
        case 'select-all':
          this.document.selection.selectAll();
          break;
      }
    });
  }

  /** Sync geometry to scene after tool operations.
   *  @param dirtyVertexIds - Optional set of vertex IDs that changed. When provided,
   *  sync uses adjacency to update only affected faces/edges instead of iterating all.
   */
  syncScene(dirtyVertexIds?: Iterable<string>, force?: boolean): void {
    if (dirtyVertexIds) {
      this.sceneBridge.markVerticesDirty(dirtyVertexIds);
    }
    this.sceneBridge.sync(force);
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
    const t0 = performance.now();
    const sel = this.document.selection;
    const ids = Array.from(sel.state.entityIds);
    const sm = this.document.scene as any;

    // In batched/view-only mode, don't extract faces — just highlight in place.
    // Extraction creates individual Three.js objects per face which kills performance.
    // Use batched highlighting (color tint) for larger components instead of extraction.
    const MAX_EXTRACT_FACES = 500; // Cap for extraction (creates individual Three.js objects)
    const MAX_HIGHLIGHT_FACES = 50000; // Cap for batched tint highlighting

    if (this.sceneBridge.batchedMode) {
      // Only extract small selections — large component extraction kills performance
      let extracted = false;
      for (const id of ids) {
        if (this.sceneBridge.isBatchedFace(id)) {
          this.sceneBridge.extractFromBatch(id);
          extracted = true;
        }
        if (sm?.components?.has(id)) {
          const comp = sm.components.get(id);
          if (comp && comp.entityIds.size <= MAX_EXTRACT_FACES) {
            for (const eid of comp.entityIds) {
              if (this.sceneBridge.isBatchedFace(eid)) {
                this.sceneBridge.extractFromBatch(eid);
                extracted = true;
              }
              if (this.sceneBridge.isBatchedEdge(eid)) {
                this.sceneBridge.extractEdgeFromBatch(eid);
                extracted = true;
              }
            }
          }
        }
      }
      if (extracted) {
        this.sceneBridge.sync();
      }
    }

    // Clear previous component bounding box wireframes
    for (const lineId of this._componentBBoxLines) {
      this.viewport.renderer.removeGuideLine(lineId);
    }
    this._componentBBoxLines = [];

    // Resolve selection: individual entities get highlight, components get bounding box
    const highlightIds: string[] = [];
    for (const id of ids) {
      if (sm?.components?.has(id)) {
        // Draw bounding box wireframe for this component
        this._drawComponentBBox(id, sm);
      } else {
        highlightIds.push(id);
      }
    }

    // Update 3D selection highlights (for non-component entities)
    const t1 = performance.now();
    this.viewport.renderer.setSelectionHighlight(highlightIds);
    const dt1 = performance.now() - t1;

    // Pre-selection: resolve all pre-selected IDs (supports curve multi-select)
    const preSelIds = sel.getPreSelectionIds();
    const preSelHighlightIds: string[] = [];
    for (const pid of preSelIds) {
      if (sm?.components?.has(pid)) {
        const comp = sm.components.get(pid);
        if (comp && comp.entityIds.size <= MAX_EXTRACT_FACES) {
          for (const eid of comp.entityIds) preSelHighlightIds.push(eid);
        }
      } else {
        preSelHighlightIds.push(pid);
      }
    }
    const t2 = performance.now();
    this.viewport.renderer.setPreSelectionHighlightMulti(preSelHighlightIds);
    const dt2 = performance.now() - t2;

    const dtTotal = performance.now() - t0;
    if (dtTotal > 2) console.warn(`[syncSelection] ${dtTotal.toFixed(1)}ms total — highlight: ${dt1.toFixed(1)}ms (${highlightIds.length} ids), presel: ${dt2.toFixed(1)}ms (${preSelHighlightIds.length} ids), sel: ${ids.length}`);

    return { entityIds: ids, count: ids.length };
  }

  /** Draw a bounding box wireframe around a selected component. */
  private _drawComponentBBox(componentId: string, sm: any): void {
    const comp = sm.components.get(componentId);
    if (!comp) return;

    // Compute bounding box from component's face vertices
    const mesh = this.document.geometry.getMesh();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let found = false;

    for (const eid of comp.entityIds) {
      const face = mesh.faces.get(eid);
      if (!face) continue;
      for (const vid of face.vertexIds) {
        const v = mesh.vertices.get(vid);
        if (!v) continue;
        const p = v.position;
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.z < minZ) minZ = p.z;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; if (p.z > maxZ) maxZ = p.z;
        found = true;
      }
    }
    if (!found) return;

    // 8 corners of the bounding box
    const c = [
      { x: minX, y: minY, z: minZ }, // 0: front-bottom-left
      { x: maxX, y: minY, z: minZ }, // 1: front-bottom-right
      { x: maxX, y: maxY, z: minZ }, // 2: front-top-right
      { x: minX, y: maxY, z: minZ }, // 3: front-top-left
      { x: minX, y: minY, z: maxZ }, // 4: back-bottom-left
      { x: maxX, y: minY, z: maxZ }, // 5: back-bottom-right
      { x: maxX, y: maxY, z: maxZ }, // 6: back-top-right
      { x: minX, y: maxY, z: maxZ }, // 7: back-top-left
    ];

    // 12 edges of the box
    const edges: [number, number][] = [
      [0,1],[1,2],[2,3],[3,0], // front face
      [4,5],[5,6],[6,7],[7,4], // back face
      [0,4],[1,5],[2,6],[3,7], // connecting edges
    ];

    const color = { r: 0.24, g: 0.47, b: 1.0 }; // selection blue
    const lineOpts = { depthTest: false, renderOrder: 999 };
    for (const [a, b] of edges) {
      const id = `_comp_bbox_${componentId}_${a}_${b}`;
      this.viewport.renderer.addGuideLine(id, c[a], c[b], color, false, lineOpts);
      this._componentBBoxLines.push(id);
    }
  }

  dispose(): void {
    this.sceneBridge?.dispose();
    this.viewport?.dispose();
    this.initialized = false;
  }

  async newDocument(): Promise<void> {
    this.document.newDocument();
    this.document.selection.clear();
    this.sceneBridge.sync(true);
  }

  async openDocument(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const result = await (window.api as any).invoke('file:open');
    if (!result) return;

    try {
      const ext = result.filePath.split('.').pop()?.toLowerCase();
      if (ext === 'skp') {
        this.emitProgress('Converting SKP file...', -1);
        const converted = await (window.api as any).invoke('file:convert-skp', { filePath: result.filePath, data: result.data });
        if (converted) {
          await this.importOBJ(converted.data, converted.filePath, { rotateSkp: true });
        } else {
          console.error('Failed to convert SKP file');
          return;
        }
      } else if (ext === 'obj') {
        this.emitProgress('Loading file...', 0);
        await this.importOBJ(result.data, result.filePath);
      } else if (ext && ['stl', 'gltf', 'glb', 'fbx', 'dae', 'ply', '3mf', 'dxf'].includes(ext)) {
        await this.importViaThreeJS(result.data, ext, result.filePath);
      } else {
        this.emitProgress('Loading file...', 0);
        await this.importOBJ(result.data, result.filePath);
      }
      this.document.filePath = result.filePath;
      this.document.markClean();
    } finally {
      this.emitProgress('', 0, true);
    }
  }

  async saveDocument(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    if (this.document.filePath) {
      const data = this.document.serialize();
      await window.api.invoke('file:write', { filePath: this.document.filePath, data });
      this.document.markClean();
    } else {
      await this.saveDocumentAs();
    }
  }

  async saveDocumentAs(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const data = this.document.serialize();
    const result = await window.api.invoke('file:save-as', {
      data,
      defaultName: this.document.metadata.name || 'Untitled',
    });
    if (result) {
      this.document.filePath = result.filePath;
      this.document.markClean();
    }
  }

  /** Export current geometry to OBJ format as ArrayBuffer */
  private exportOBJ(mtlFileName?: string): { obj: ArrayBuffer; mtl: ArrayBuffer; textures: Map<string, string> } {
    const mesh = this.document.geometry.getMesh();
    const matMgr = this.document.materials as import('../data.materials/MaterialManager').MaterialManager;
    const lines: string[] = ['# DraftDown OBJ Export'];

    if (mtlFileName) {
      lines.push(`mtllib ${mtlFileName}`);
    }
    lines.push('');

    // Map vertex IDs to OBJ indices (1-based)
    const vertexIndex = new Map<string, number>();
    let vIdx = 1;
    mesh.vertices.forEach((v, id) => {
      lines.push(`v ${v.position.x} ${v.position.y} ${v.position.z}`);
      vertexIndex.set(id, vIdx++);
    });
    lines.push('');

    // Write all UVs — collect them first, map face→uvOffset
    let vtIdx = 1;
    const faceUVOffset = new Map<string, number>();
    mesh.faces.forEach((face) => {
      if (face.uvs && face.uvs.length === face.vertexIds.length) {
        faceUVOffset.set(face.id, vtIdx);
        for (const uv of face.uvs) {
          lines.push(`vt ${uv.u.toFixed(6)} ${uv.v.toFixed(6)}`);
          vtIdx++;
        }
      }
    });
    if (vtIdx > 1) lines.push('');

    // Group faces by material
    const allMats = matMgr.getAllMaterials();
    const matIdToName = new Map<string, string>();
    const textures = new Map<string, string>(); // sanitized filename → data URL
    for (const mat of allMats) {
      matIdToName.set(mat.id, mat.name);
    }

    // Collect faces per material
    const facesByMat = new Map<string, typeof mesh.faces extends Map<string, infer V> ? [string, V][] : never>();
    mesh.faces.forEach((face, faceId) => {
      const matDef = matMgr.getFaceMaterial(faceId);
      const matId = matDef.id;
      if (!facesByMat.has(matId)) facesByMat.set(matId, []);
      facesByMat.get(matId)!.push([faceId, face]);
    });

    // Write faces grouped by material
    for (const [matId, facePairs] of facesByMat) {
      const matName = matIdToName.get(matId) || 'default';
      lines.push(`usemtl ${matName.replace(/\s+/g, '_')}`);

      for (const [faceId, face] of facePairs) {
        const indices = face.vertexIds.map(vid => vertexIndex.get(vid)).filter((v): v is number => v !== undefined);
        if (indices.length < 3) continue;

        // Write hole information so it survives round-trip
        if (face.holeStartIndices && face.holeStartIndices.length > 0) {
          lines.push(`# holes ${face.holeStartIndices.join(' ')}`);
        }

        const uvBase = faceUVOffset.get(faceId);
        if (uvBase !== undefined) {
          const parts = indices.map((vi, i) => `${vi}/${uvBase + i}`);
          lines.push('f ' + parts.join(' '));
        } else {
          lines.push('f ' + indices.join(' '));
        }
      }
      lines.push('');
    }

    // Edges
    mesh.edges.forEach((edge) => {
      const i1 = vertexIndex.get(edge.startVertexId);
      const i2 = vertexIndex.get(edge.endVertexId);
      if (i1 && i2) {
        lines.push(`l ${i1} ${i2}`);
      }
    });

    const objText = lines.join('\n');

    // Build MTL file
    const mtlLines: string[] = ['# DraftDown MTL Export'];
    for (const mat of allMats) {
      const sanitizedName = mat.name.replace(/\s+/g, '_');
      mtlLines.push(`newmtl ${sanitizedName}`);
      mtlLines.push(`Kd ${mat.color.r.toFixed(3)} ${mat.color.g.toFixed(3)} ${mat.color.b.toFixed(3)}`);
      mtlLines.push(`d ${(mat.opacity ?? 1).toFixed(3)}`);
      if (mat.albedoMap) {
        const texFilename = `${sanitizedName}.png`;
        mtlLines.push(`map_Kd ${texFilename}`);
        textures.set(texFilename, mat.albedoMap);
      }
      mtlLines.push('');
    }

    const enc = new TextEncoder();
    return {
      obj: enc.encode(objText).buffer,
      mtl: enc.encode(mtlLines.join('\n')).buffer,
      textures,
    };
  }

  private emitProgress(message: string, progress = -1, done = false) {
    window.dispatchEvent(new CustomEvent('import-progress', {
      detail: { message, progress, done },
    }));
  }

  /** Yield to the event loop so the UI can repaint */
  private yieldUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /** Import OBJ data into the current document using fast bulk import */
  private async importOBJ(data: ArrayBuffer, filePath?: string, opts?: { rotateSkp?: boolean }): Promise<void> {
    this.emitProgress('Parsing file...', 0.1);
    await this.yieldUI();

    const text = new TextDecoder().decode(data);

    // Use the full OBJ parser for proper UV, material, and texture support
    const parsed = importObj(text);

    this.document.newDocument();
    const geo = this.document.geometry;

    // Build vertex and face arrays for bulkImport
    let vertices = parsed.vertices;

    // SKP files use Z-up; rotate -90° around X to convert to Y-up
    if (opts?.rotateSkp) {
      vertices = vertices.map(v => ({ x: v.x, y: v.z, z: -v.y }));
    }

    // Merge coplanar adjacent triangles back into polygons
    // (SketchUp component definitions often store pre-triangulated geometry)
    // Only merge for SKP-converted files — our own OBJ export already has polygons
    if (opts?.rotateSkp) {
      this.emitProgress('Merging coplanar faces...', 0.3);
      await this.yieldUI();
      parsed.faces = mergeCoplanarFaces(vertices, parsed.faces);
    }

    const faces = parsed.faces.map(f => f.vertexIndices);
    const faceHoleStarts = parsed.faces.map(f => f.holeStartIndices);

    console.log(`[import] Parsed OBJ: ${vertices.length} vertices, ${faces.length} faces`);
    this.emitProgress(
      `Building geometry: ${vertices.length.toLocaleString()} vertices, ${faces.length.toLocaleString()} faces...`,
      0.4,
    );
    await this.yieldUI();

    let faceIds: string[] = [];
    let survivingInputIndices: number[] = [];

    try {
      const t0 = performance.now();
      const result = geo.bulkImport(vertices, faces, undefined, faceHoleStarts);
      faceIds = result.faceIds;
      survivingInputIndices = (result as any).survivingInputIndices || [];
      const t1 = performance.now();
      console.log(`[import] bulkImport completed in ${(t1 - t0).toFixed(0)}ms — ${faceIds.length} faces created`);
    } catch (e) {
      console.error('[import] bulkImport FAILED:', e);
      this.emitProgress('Import failed: ' + (e as Error).message, 1, false);
      await this.yieldUI();
      return;
    }

    // ── Load MTL materials and textures ────────────────────────────
    const hasTexCoords = parsed.texCoords.length > 0;
    const hasMaterials = parsed.materialLibraries.length > 0;
    let objMaterials: ObjMaterial[] = [];
    const textureCache = new Map<string, string>(); // filename → data URL

    if (hasMaterials && filePath) {
      this.emitProgress('Loading materials...', 0.55);
      await this.yieldUI();

      const dir = filePath.includes('/') || filePath.includes('\\')
        ? filePath.replace(/[/\\][^/\\]+$/, '')
        : '';
      for (const mtlFile of parsed.materialLibraries) {
        try {
          const mtlPath = `${dir}/${mtlFile}`;
          const mtlData = await window.api.invoke('file:read', { filePath: mtlPath });
          if (mtlData && mtlData.byteLength > 0) {
            const mtlText = new TextDecoder().decode(mtlData);
            const mats = parseMtl(mtlText);
            objMaterials.push(...mats);
            // Load texture images referenced by materials
            for (const mat of mats) {
              const texFiles = [mat.diffuseMap, mat.normalMap].filter(Boolean) as string[];
              for (const texFile of texFiles) {
                if (textureCache.has(texFile)) continue;
                try {
                  const texPath = `${dir}/${texFile}`;
                  const texData = await window.api.invoke('file:read', { filePath: texPath });
                  if (texData && texData.byteLength > 0) {
                    const ext = texFile.split('.').pop()?.toLowerCase() || 'png';
                    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
                    const base64 = this.arrayBufferToBase64(texData);
                    const dataUrl = `data:${mime};base64,${base64}`;
                    textureCache.set(texFile, dataUrl);
                  } else {
                    console.warn(`[import] Texture empty/missing: ${texPath}`);
                  }
                } catch (e) {
                  console.warn(`[import] Failed to load texture: ${texFile}`, e);
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[import] Failed to load MTL: ${mtlFile}`, e);
        }
      }
    }

    // ── Create MaterialDef entries and map OBJ material names ──────
    const matManager = this.document.materials;
    const matNameToId = new Map<string, string>();

    console.log(`[import] Loaded ${textureCache.size}/${objMaterials.filter(m => m.diffuseMap).length} textures`);

    for (const objMat of objMaterials) {
      const albedoMap = objMat.diffuseMap ? textureCache.get(objMat.diffuseMap) : undefined;
      const normalMap = objMat.normalMap ? textureCache.get(objMat.normalMap) : undefined;
      const kd = objMat.diffuseColor || { x: 0.75, y: 0.75, z: 0.75 };
      if (objMat.diffuseMap && !albedoMap) {
        console.warn(`[import] Missing texture for "${objMat.name}": ${objMat.diffuseMap}`);
      }

      const matDef = matManager.addMaterial({
        name: objMat.name,
        color: { r: kd.x, g: kd.y, b: kd.z, a: objMat.opacity ?? 1 },
        opacity: objMat.opacity ?? 1,
        roughness: objMat.shininess ? Math.max(0.05, 1 - (objMat.shininess / 1000)) : 0.7,
        metalness: 0,
        albedoMap,
        normalMap,
      });
      matNameToId.set(objMat.name, matDef.id);
    }

    // ── Assign UVs, materials, and hole indices to faces ────────────
    if (survivingInputIndices.length === faceIds.length) {
      this.emitProgress('Applying materials and UVs...', 0.7);
      await this.yieldUI();

      const mesh = geo.getMesh();
      for (let i = 0; i < faceIds.length; i++) {
        const faceId = faceIds[i];
        const inputIdx = survivingInputIndices[i];
        const objFace = parsed.faces[inputIdx];
        const face = mesh.faces.get(faceId);
        if (!face || !objFace) continue;

        // Assign per-vertex UVs if available
        if (objFace.texCoordIndices.length === objFace.vertexIndices.length && parsed.texCoords.length > 0) {
          const resolvedUVs = objFace.texCoordIndices.map(ti => {
            const tc = parsed.texCoords[ti];
            return tc ? { u: tc.u, v: tc.v } : { u: 0, v: 0 };
          });
          // bulkImport may clean duplicate vertices, so trim UVs to match actual face vertex count
          face.uvs = resolvedUVs.length === face.vertexIds.length
            ? resolvedUVs
            : resolvedUVs.slice(0, face.vertexIds.length);
        }

        // Assign material
        if (objFace.materialName && matNameToId.has(objFace.materialName)) {
          matManager.applyToFace(faceId, matNameToId.get(objFace.materialName)!);
        }

        // Assign hole start indices (faces with inner loops from SKP)
        if (objFace.holeStartIndices && objFace.holeStartIndices.length > 0) {
          face.holeStartIndices = objFace.holeStartIndices;
        }
      }

      // ── Create components from OBJ groups ──────────────────────────
      // Group names may be hierarchical (e.g. "House_1/Room_2/Door_3") for nested components.
      // Parent components include all descendant face/edge IDs so getEntityComponent() picks
      // the innermost (smallest) component.
      const sm = this.document.scene as any;
      if (sm?.createComponent) {
        const groupToFaceIds = new Map<string, string[]>();
        for (let i = 0; i < faceIds.length; i++) {
          const inputIdx = survivingInputIndices[i];
          const objFace = parsed.faces[inputIdx];
          if (objFace?.groupName) {
            let arr = groupToFaceIds.get(objFace.groupName);
            if (!arr) { arr = []; groupToFaceIds.set(objFace.groupName, arr); }
            arr.push(faceIds[i]);
          }
        }

        // Expand hierarchical paths: faces in "A/B/C" also belong to "A/B" and "A"
        const allPaths = new Map<string, Set<string>>();
        for (const [groupName, ids] of groupToFaceIds) {
          const parts = groupName.split('/');
          for (let depth = 0; depth < parts.length; depth++) {
            const path = parts.slice(0, depth + 1).join('/');
            let set = allPaths.get(path);
            if (!set) { set = new Set(); allPaths.set(path, set); }
            for (const id of ids) set.add(id);
          }
        }

        let compCount = 0;
        const mesh = geo.getMesh();

        // Sort paths by depth so parents are created before children
        const sortedPaths = Array.from(allPaths.entries())
          .sort((a, b) => a[0].split('/').length - b[0].split('/').length);

        // Map from path to component ID for parent lookups
        const pathToCompId = new Map<string, string>();

        for (const [path, faceIdSet] of sortedPaths) {
          const ids = Array.from(faceIdSet);
          if (ids.length === 0) continue;

          // Display name: last path segment with counter suffix stripped
          const segments = path.split('/');
          const displayName = segments[segments.length - 1].replace(/_\d+$/, '');

          // Also include edges whose vertices are both in this component
          const vertexSet = new Set<string>();
          for (const fid of ids) {
            const face = mesh.faces.get(fid);
            if (face) for (const vid of face.vertexIds) vertexSet.add(vid);
          }
          const entityIds = [...ids];
          mesh.edges.forEach((edge, edgeId) => {
            if (vertexSet.has(edge.startVertexId) && vertexSet.has(edge.endVertexId)) {
              entityIds.push(edgeId);
            }
          });

          // Find parent path and set editingComponentId so createComponent
          // sets the correct parentComponentId
          const parentPath = segments.slice(0, -1).join('/');
          const parentCompId = parentPath ? pathToCompId.get(parentPath) ?? null : null;
          sm.editingComponentId = parentCompId;

          const compId = sm.createComponent(displayName, entityIds);
          pathToCompId.set(path, compId);
          compCount++;
        }

        // Reset editing state after import
        sm.editingComponentId = null;
        sm.editingComponentStack = [];

        if (compCount > 0) {
          console.log(`[import] Created ${compCount} components from OBJ groups (hierarchy preserved)`);
        }
      }
    }

    this.emitProgress('Rendering scene...', 0.85);
    await this.yieldUI();

    try {
      const faceCount = geo.getMesh().faces.size;
      const t2 = performance.now();
      if (faceCount > 10000) {
        this.sceneBridge.syncBatched();
      } else {
        this.sceneBridge.sync(true);
      }
      console.log(`[import] Scene sync completed in ${(performance.now() - t2).toFixed(0)}ms, ${faceCount} faces`);
    } catch (e) {
      console.error('[import] scene sync FAILED:', e);
    }
  }

  /** Convert ArrayBuffer to base64 string */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    // Process in chunks to avoid call stack issues with large buffers
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      const end = Math.min(i + CHUNK, bytes.byteLength);
      binary += String.fromCharCode(...bytes.subarray(i, end));
    }
    return btoa(binary);
  }

  /** Load a SKP file from a URL (for example models). */
  async loadSkpFromUrl(url: string): Promise<void> {
    try {
      this.emitProgress('Downloading example model...', -1);
      console.log('[loadSkpFromUrl] Fetching:', url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const skpData = await resp.arrayBuffer();
      console.log(`[loadSkpFromUrl] Downloaded ${(skpData.byteLength / 1024).toFixed(0)}KB`);

      this.emitProgress('Converting SKP file...', -1);
      const converted = await window.api.invoke('file:convert-skp', { filePath: url.split('/').pop() || 'model.skp', data: skpData });
      if (!converted) {
        console.error('[loadSkpFromUrl] SKP conversion returned null');
        return;
      }
      console.log(`[loadSkpFromUrl] Converted, OBJ size: ${(converted.data.byteLength / 1024).toFixed(0)}KB`);

      await this.importOBJ(converted.data, converted.filePath, { rotateSkp: true });
      this.document.markClean();
    } catch (err) {
      console.error('[loadSkpFromUrl] Error:', err);
    } finally {
      this.emitProgress('', 0, true);
    }
  }

  async importFile(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const result = await window.api.invoke('file:import', {
      formats: ['.skp', '.obj', '.stl', '.gltf', '.glb', '.fbx', '.dae', '.ply', '.3mf', '.dxf'],
    });
    if (!result) return;

    const ext = result.format?.toLowerCase() || result.filePath?.split('.').pop()?.toLowerCase();
    try {
      if (ext === 'skp') {
        this.emitProgress('Converting SKP file...', -1);
        const converted = await (window.api as any).invoke('file:convert-skp', { filePath: result.filePath, data: result.data });
        if (converted) {
          await this.importOBJ(converted.data, converted.filePath, { rotateSkp: true });
        }
      } else if (ext === 'obj') {
        this.emitProgress('Loading OBJ file...', 0);
        await this.importOBJ(result.data, result.filePath);
      } else {
        await this.importViaThreeJS(result.data, ext || '', result.filePath);
      }
    } finally {
      this.emitProgress('', 0, true);
    }
  }

  /** Import non-OBJ formats by loading with Three.js, converting to OBJ, then importing. */
  private async importViaThreeJS(data: ArrayBuffer, ext: string, filePath?: string): Promise<void> {
    this.emitProgress(`Loading ${ext.toUpperCase()} file...`, -1);

    let object: THREE.Object3D;

    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const loader = new STLLoader();
      const geometry = loader.parse(data);
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    } else if (ext === 'gltf' || ext === 'glb') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(data, '', resolve, reject);
      });
      object = gltf.scene;
    } else if (ext === 'fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const loader = new FBXLoader();
      object = loader.parse(data, '');
    } else if (ext === 'dae') {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      const loader = new ColladaLoader();
      const text = new TextDecoder().decode(data);
      const collada = loader.parse(text, '');
      object = collada.scene;
    } else if (ext === 'ply') {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const loader = new PLYLoader();
      const geometry = loader.parse(data);
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    } else if (ext === '3mf') {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      const loader = new ThreeMFLoader();
      object = loader.parse(data);
    } else if (ext === 'dxf') {
      const text = new TextDecoder().decode(data);
      const geometry = this.parseDXFToGeometry(text);
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    } else {
      console.warn(`[import] Unsupported format: ${ext}`);
      return;
    }

    this.emitProgress('Converting to geometry...', 0.5);
    await this.yieldUI();

    // Convert loaded Three.js object to OBJ text via OBJExporter
    const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
    const exporter = new OBJExporter();
    const objText = exporter.parse(object);
    const objData = new TextEncoder().encode(objText).buffer;

    await this.importOBJ(objData as ArrayBuffer, filePath);
  }

  async exportFile(format: string): Promise<void> {
    if (format === 'stl' || format === 'gltf' || format === 'glb' || format === 'ply' || format === 'dxf' || format === 'usdz' || format === 'dae') {
      await this.exportViaThreeJS(format);
      return;
    }

    if (typeof window.api === 'undefined') return;

    if (format === 'obj') {
      // Use a placeholder mtllib name — we'll fix it once we know the actual filename
      const exported = this.exportOBJ('__MTLLIB__');
      const result = await window.api.invoke('file:export', {
        data: exported.obj,
        format,
        defaultName: this.document.metadata.name,
      });
      if (result?.filePath) {
        const dir = result.filePath.replace(/[/\\][^/\\]+$/, '');
        const objBaseName = result.filePath.replace(/^.*[/\\]/, '').replace(/\.obj$/i, '');
        const mtlFileName = objBaseName + '.mtl';

        // Rewrite OBJ with correct mtllib reference
        const objText = new TextDecoder().decode(exported.obj);
        const fixedObj = objText.replace('mtllib __MTLLIB__', `mtllib ${mtlFileName}`);
        const fixedObjBuf = new TextEncoder().encode(fixedObj).buffer;
        await window.api.invoke('file:write', { filePath: result.filePath, data: fixedObjBuf });

        // Write MTL file
        const mtlPath = `${dir}/${mtlFileName}`;
        await window.api.invoke('file:write', { filePath: mtlPath, data: exported.mtl });
        // Write texture files
        for (const [filename, dataUrl] of exported.textures) {
          try {
            // Convert data URL to ArrayBuffer without fetch (more reliable in Electron)
            const base64 = dataUrl.split(',')[1];
            if (!base64) { console.warn(`[export] No base64 data for ${filename}`); continue; }
            const binaryStr = atob(base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            await window.api.invoke('file:write', { filePath: `${dir}/${filename}`, data: bytes.buffer });
            console.log(`[export] Wrote texture: ${filename} (${bytes.length} bytes)`);
          } catch (e) {
            console.warn(`[export] Failed to write texture ${filename}:`, e);
          }
        }
      }
    } else {
      const data = this.document.serialize();
      await window.api.invoke('file:export', {
        data,
        format,
        defaultName: this.document.metadata.name,
      });
    }
  }

  /** Export using Three.js built-in exporters (STL, glTF, PLY). */
  private async exportViaThreeJS(format: string): Promise<void> {
    const scene = this.sceneBridge.getScene();

    let data: ArrayBuffer;
    let defaultExt: string;

    if (format === 'stl') {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
      const exporter = new STLExporter();
      const result = exporter.parse(scene, { binary: true });
      data = (result as DataView).buffer.slice(0) as ArrayBuffer;
      defaultExt = 'stl';
    } else if (format === 'gltf' || format === 'glb') {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const exporter = new GLTFExporter();
      const binary = format === 'glb';
      const result = await new Promise<ArrayBuffer | object>((resolve, reject) => {
        exporter.parse(scene, (res) => resolve(res as any), reject, { binary });
      });
      if (binary) {
        data = result as ArrayBuffer;
      } else {
        const json = JSON.stringify(result, null, 2);
        data = new TextEncoder().encode(json).buffer;
      }
      defaultExt = format;
    } else if (format === 'ply') {
      const { PLYExporter } = await import('three/examples/jsm/exporters/PLYExporter.js');
      const exporter = new PLYExporter();
      const result = await new Promise<string>((resolve) => {
        exporter.parse(scene, (res: string) => resolve(res), {});
      });
      data = new TextEncoder().encode(result).buffer;
      defaultExt = 'ply';
    } else if (format === 'dxf') {
      data = new TextEncoder().encode(this.exportSceneToDXF(scene)).buffer;
      defaultExt = 'dxf';
    } else if (format === 'usdz') {
      const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
      const exporter = new USDZExporter();
      const result = await exporter.parse(scene);
      const u8 = result as unknown as Uint8Array;
      data = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      defaultExt = 'usdz';
    } else if (format === 'dae') {
      data = new TextEncoder().encode(this.exportSceneToCollada(scene)).buffer;
      defaultExt = 'dae';
    } else {
      return;
    }

    // Save via file dialog (Electron) or download (web)
    if (typeof window.api !== 'undefined') {
      await window.api.invoke('file:export', {
        data,
        format: defaultExt,
        defaultName: (this.document.metadata.name || 'Untitled') + '.' + defaultExt,
      });
    } else {
      // Web fallback: trigger download
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (this.document.metadata.name || 'Untitled') + '.' + defaultExt;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  /** Parse DXF text into a Three.js BufferGeometry (3DFACE, LINE, POLYLINE entities). */
  private parseDXFToGeometry(text: string): THREE.BufferGeometry {
    const lines = text.split(/\r?\n/);
    const vertices: number[] = [];
    const indices: number[] = [];

    let i = 0;
    const next = (): [number, string] => {
      const code = parseInt(lines[i++]?.trim() || '0', 10);
      const val = lines[i++]?.trim() || '';
      return [code, val];
    };

    // Scan for ENTITIES section
    while (i < lines.length) {
      const [code, val] = next();
      if (code === 2 && val === 'ENTITIES') break;
    }

    // Parse entities
    while (i < lines.length) {
      const [code, val] = next();
      if (code === 0 && val === 'ENDSEC') break;

      if (code === 0 && val === '3DFACE') {
        const pts: number[][] = [[], [], [], []];
        while (i < lines.length) {
          const [c, v] = next();
          if (c === 0) { i -= 2; break; } // next entity
          const f = parseFloat(v);
          // Group codes: 10-13 = X, 20-23 = Y, 30-33 = Z for vertices 0-3
          if (c >= 10 && c <= 13) pts[c - 10][0] = f;
          if (c >= 20 && c <= 23) pts[c - 20][1] = f;
          if (c >= 30 && c <= 33) pts[c - 30][2] = f;
        }
        // Triangle 1: 0-1-2
        const base = vertices.length / 3;
        for (let p = 0; p < 3; p++) {
          vertices.push(pts[p][0] || 0, pts[p][1] || 0, pts[p][2] || 0);
        }
        indices.push(base, base + 1, base + 2);
        // Triangle 2 if quad (vertex 3 differs from vertex 2)
        const p2 = pts[2], p3 = pts[3];
        if (p3[0] !== undefined && (p3[0] !== p2[0] || p3[1] !== p2[1] || p3[2] !== p2[2])) {
          vertices.push(p3[0] || 0, p3[1] || 0, p3[2] || 0);
          indices.push(base, base + 2, base + 3);
        }
      }

      if (code === 0 && val === 'LINE') {
        const p0: number[] = [0, 0, 0];
        const p1: number[] = [0, 0, 0];
        while (i < lines.length) {
          const [c, v] = next();
          if (c === 0) { i -= 2; break; }
          const f = parseFloat(v);
          if (c === 10) p0[0] = f; if (c === 20) p0[1] = f; if (c === 30) p0[2] = f;
          if (c === 11) p1[0] = f; if (c === 21) p1[1] = f; if (c === 31) p1[2] = f;
        }
        // Create a degenerate triangle for the line so it appears in the mesh
        const base = vertices.length / 3;
        vertices.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p1[0], p1[1], p1[2]);
        indices.push(base, base + 1, base + 2);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** Export Three.js scene to DXF format using 3DFACE entities. */
  private exportSceneToDXF(scene: THREE.Scene): string {
    const lines: string[] = [];
    const w = (code: number, value: string | number) => {
      lines.push(`  ${code}`);
      lines.push(`${value}`);
    };

    // Header
    w(0, 'SECTION'); w(2, 'HEADER');
    w(9, '$ACADVER'); w(1, 'AC1015'); // AutoCAD 2000
    w(0, 'ENDSEC');

    // Entities section
    w(0, 'SECTION'); w(2, 'ENTITIES');

    let handle = 100;
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry;
      if (!geom) return;

      // Get world-space positions
      const posAttr = geom.getAttribute('position');
      if (!posAttr) return;
      const index = geom.getIndex();

      const worldMatrix = mesh.matrixWorld;
      const v = new THREE.Vector3();

      const getVertex = (i: number): [number, number, number] => {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        v.applyMatrix4(worldMatrix);
        return [v.x, v.y, v.z];
      };

      const triCount = index ? index.count / 3 : posAttr.count / 3;
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

        const p0 = getVertex(i0);
        const p1 = getVertex(i1);
        const p2 = getVertex(i2);

        w(0, '3DFACE');
        w(5, (handle++).toString(16).toUpperCase());
        w(8, '0'); // layer
        // Vertex 0
        w(10, p0[0]); w(20, p0[1]); w(30, p0[2]);
        // Vertex 1
        w(11, p1[0]); w(21, p1[1]); w(31, p1[2]);
        // Vertex 2
        w(12, p2[0]); w(22, p2[1]); w(32, p2[2]);
        // Vertex 3 (repeat vertex 2 for triangular face)
        w(13, p2[0]); w(23, p2[1]); w(33, p2[2]);
      }
    });

    w(0, 'ENDSEC');
    w(0, 'EOF');
    return lines.join('\n');
  }

  /** Export Three.js scene to COLLADA (.dae) XML format. */
  private exportSceneToCollada(scene: THREE.Scene): string {
    const meshes: { positions: number[]; normals: number[]; indices: number[]; name: string }[] = [];

    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry;
      if (!geom) return;

      const posAttr = geom.getAttribute('position');
      const normAttr = geom.getAttribute('normal');
      if (!posAttr) return;

      const index = geom.getIndex();
      const worldMatrix = mesh.matrixWorld;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();

      const positions: number[] = [];
      const normals: number[] = [];
      const indices: number[] = [];

      const vertCount = posAttr.count;
      for (let i = 0; i < vertCount; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(worldMatrix);
        positions.push(v.x, v.y, v.z);
        if (normAttr) {
          n.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i)).applyMatrix3(normalMatrix).normalize();
          normals.push(n.x, n.y, n.z);
        } else {
          normals.push(0, 1, 0);
        }
      }

      if (index) {
        for (let i = 0; i < index.count; i++) indices.push(index.getX(i));
      } else {
        for (let i = 0; i < vertCount; i++) indices.push(i);
      }

      meshes.push({ positions, normals, indices, name: mesh.name || `mesh_${meshes.length}` });
    });

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
    lines.push('  <asset><created>' + new Date().toISOString() + '</created><up_axis>Y_UP</up_axis></asset>');

    // Geometry library
    lines.push('  <library_geometries>');
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi];
      const id = `geom_${mi}`;
      lines.push(`    <geometry id="${id}" name="${esc(m.name)}">`);
      lines.push('      <mesh>');
      // Positions
      lines.push(`        <source id="${id}_pos">`);
      lines.push(`          <float_array id="${id}_pos_arr" count="${m.positions.length}">${m.positions.join(' ')}</float_array>`);
      lines.push(`          <technique_common><accessor source="#${id}_pos_arr" count="${m.positions.length / 3}" stride="3">`);
      lines.push('            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>');
      lines.push('          </accessor></technique_common>');
      lines.push('        </source>');
      // Normals
      lines.push(`        <source id="${id}_norm">`);
      lines.push(`          <float_array id="${id}_norm_arr" count="${m.normals.length}">${m.normals.join(' ')}</float_array>`);
      lines.push(`          <technique_common><accessor source="#${id}_norm_arr" count="${m.normals.length / 3}" stride="3">`);
      lines.push('            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>');
      lines.push('          </accessor></technique_common>');
      lines.push('        </source>');
      // Vertices
      lines.push(`        <vertices id="${id}_vtx"><input semantic="POSITION" source="#${id}_pos"/></vertices>`);
      // Triangles
      lines.push(`        <triangles count="${m.indices.length / 3}">`);
      lines.push(`          <input semantic="VERTEX" source="#${id}_vtx" offset="0"/>`);
      lines.push(`          <input semantic="NORMAL" source="#${id}_norm" offset="0"/>`);
      lines.push(`          <p>${m.indices.join(' ')}</p>`);
      lines.push('        </triangles>');
      lines.push('      </mesh>');
      lines.push('    </geometry>');
    }
    lines.push('  </library_geometries>');

    // Visual scenes
    lines.push('  <library_visual_scenes><visual_scene id="Scene" name="Scene">');
    for (let mi = 0; mi < meshes.length; mi++) {
      lines.push(`    <node id="node_${mi}" name="${esc(meshes[mi].name)}" type="NODE">`);
      lines.push(`      <instance_geometry url="#geom_${mi}"/>`);
      lines.push('    </node>');
    }
    lines.push('  </visual_scene></library_visual_scenes>');
    lines.push('  <scene><instance_visual_scene url="#Scene"/></scene>');
    lines.push('</COLLADA>');

    return lines.join('\n');
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

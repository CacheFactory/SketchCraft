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
        case 'export': this.exportFile('obj'); break;
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
  syncScene(dirtyVertexIds?: Iterable<string>): void {
    if (dirtyVertexIds) {
      this.sceneBridge.markVerticesDirty(dirtyVertexIds);
    }
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
    const t0 = performance.now();
    const sel = this.document.selection;
    const ids = Array.from(sel.state.entityIds);
    const sm = this.document.scene as any;

    // In batched/view-only mode, don't extract faces — just highlight in place.
    // Extraction creates individual Three.js objects per face which kills performance.
    const MAX_HIGHLIGHT_FACES = 500; // Cap to prevent freezing on large components

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
          if (comp && comp.entityIds.size <= MAX_HIGHLIGHT_FACES) {
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

    // Resolve component IDs to their member face/edge IDs for highlighting
    const highlightIds: string[] = [];
    for (const id of ids) {
      if (sm?.components?.has(id)) {
        const comp = sm.components.get(id);
        if (comp && comp.entityIds.size <= MAX_HIGHLIGHT_FACES) {
          for (const eid of comp.entityIds) highlightIds.push(eid);
        }
        // Skip highlighting for components with too many faces
      } else {
        highlightIds.push(id);
      }
    }

    // Update 3D selection highlights
    const t1 = performance.now();
    this.viewport.renderer.setSelectionHighlight(highlightIds);
    const dt1 = performance.now() - t1;

    // Pre-selection: resolve all pre-selected IDs (supports curve multi-select)
    const preSelIds = sel.getPreSelectionIds();
    const preSelHighlightIds: string[] = [];
    for (const pid of preSelIds) {
      if (sm?.components?.has(pid)) {
        const comp = sm.components.get(pid);
        if (comp && comp.entityIds.size <= MAX_HIGHLIGHT_FACES) {
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
      } else {
        this.emitProgress('Loading file...', 0);
        await this.importOBJ(result.data, result.filePath);
      }
      this.document.filePath = result.filePath;
      this.document.markClean();
      // Scene sync is now handled inside importOBJ
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
        for (const [path, faceIdSet] of allPaths) {
          const ids = Array.from(faceIdSet);
          if (ids.length > 0) {
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
            sm.createComponent(displayName, entityIds);
            compCount++;
          }
        }
        if (compCount > 0) {
          console.log(`[import] Created ${compCount} components from OBJ groups`);
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
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const skpData = await resp.arrayBuffer();

      this.emitProgress('Converting SKP file...', -1);
      const converted = await window.api.invoke('file:convert-skp', { filePath: url.split('/').pop() || 'model.skp', data: skpData });
      if (!converted) {
        console.error('Failed to convert SKP file');
        return;
      }

      await this.importOBJ(converted.data, converted.filePath, { rotateSkp: true });
      this.document.markClean();
    } finally {
      this.emitProgress('', 0, true);
    }
  }

  async importFile(): Promise<void> {
    if (typeof window.api === 'undefined') return;
    const result = await window.api.invoke('file:import', {
      formats: ['.skp', '.obj', '.stl', '.gltf', '.glb', '.dxf', '.step', '.stp', '.fbx'],
    });
    if (!result) return;

    const ext = result.format?.toLowerCase() || result.filePath?.split('.').pop()?.toLowerCase();
    try {
      if (ext === 'skp') {
        this.emitProgress('Converting SKP file...', -1);
        console.log('[import] Starting SKP conversion...');
        const converted = await (window.api as any).invoke('file:convert-skp', { filePath: result.filePath, data: result.data });
        if (converted) {
          console.log(`[import] SKP converted, OBJ size: ${(converted.data.byteLength / 1024 / 1024).toFixed(1)}MB`);
          await this.importOBJ(converted.data, converted.filePath, { rotateSkp: true });
        }
      } else if (ext === 'obj') {
        this.emitProgress('Loading OBJ file...', 0);
        await this.importOBJ(result.data, result.filePath);
      } else {
        console.log(`Importing ${result.format} file: ${result.filePath}`);
      }
    } finally {
      this.emitProgress('', 0, true);
    }
  }

  async exportFile(format: string): Promise<void> {
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

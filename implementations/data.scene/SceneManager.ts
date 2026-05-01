// @archigraph svc.scene_manager
// Scene management: entities, groups, components, layers, scene pages

import { v4 as uuid } from 'uuid';
import { SimpleEventEmitter } from '../../src/core/events';
import {
  Entity, EntityType, Transform, Color, Vec3, Quaternion,
} from '../../src/core/types';
import {
  IGroup, IComponentDefinition, IComponentInstance,
  ILayer, IScenePage, IEditingContext, ISceneManager,
} from '../../src/core/interfaces';

// ─── Event map ───────────────────────────────────────────────────

type SceneEvents = {
  'entity-added': [Entity];
  'entity-removed': [Entity];
  'entity-moved': [string, string]; // entityId, newParentId
  'group-created': [IGroup];
  'group-exploded': [string]; // groupId
  'editing-context-changed': [IEditingContext];
  'component-defined': [IComponentDefinition];
  'component-placed': [IComponentInstance];
  'layer-added': [ILayer];
  'layer-removed': [string];
  'layer-updated': [ILayer];
  'scene-page-added': [IScenePage];
  'scene-page-removed': [string];
  'changed': [];
};

// ─── Helpers ─────────────────────────────────────────────────────

function identityTransform(): Transform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

const DEFAULT_LAYER_ID = 'layer0';

// ─── SceneManager ────────────────────────────────────────────────

export class SceneManager implements ISceneManager {
  root: IGroup;
  editingContext: IEditingContext;
  layers: Map<string, ILayer>;
  componentDefinitions: Map<string, IComponentDefinition>;
  scenePages: IScenePage[];

  /** The active layer — new geometry goes here. */
  activeLayerId: string = DEFAULT_LAYER_ID;

  /** Maps geometry entity IDs (faces/edges) to layer IDs. */
  geometryLayerMap: Map<string, string> = new Map();

  /**
   * Component system: groups of face/edge IDs that act as a single unit.
   * Component internals can't be selected or modified from the main scene.
   */
  components: Map<string, { id: string; name: string; entityIds: Set<string> }> = new Map();

  /** Which component is currently being edited (null = main scene). */
  editingComponentId: string | null = null;

  /** Stack of component IDs for nested editing (outermost first). */
  editingComponentStack: string[] = [];

  private entities: Map<string, Entity> = new Map();
  private emitter = new SimpleEventEmitter<SceneEvents>();

  constructor() {
    // Default layer
    this.layers = new Map();
    const defaultLayer: ILayer = {
      id: DEFAULT_LAYER_ID,
      name: 'Layer0',
      visible: true,
      locked: false,
      color: { r: 0, g: 0, b: 0 },
    };
    this.layers.set(DEFAULT_LAYER_ID, defaultLayer);

    // Root group
    this.root = {
      id: uuid(),
      type: 'group',
      name: 'Root',
      visible: true,
      locked: false,
      layerId: DEFAULT_LAYER_ID,
      parentId: null,
      transform: identityTransform(),
      children: [],
      meshId: '',
    };
    this.entities.set(this.root.id, this.root);

    this.editingContext = { path: [], activeGroupId: null };
    this.componentDefinitions = new Map();
    this.scenePages = [];
  }

  // ── Entity CRUD ──────────────────────────────────────────────

  addEntity(entity: Entity, parentId?: string): void {
    const pid = parentId ?? this.editingContext.activeGroupId ?? this.root.id;
    entity.parentId = pid;
    if (!entity.layerId) {
      entity.layerId = DEFAULT_LAYER_ID;
    }
    this.entities.set(entity.id, entity);

    const parent = this.entities.get(pid) as IGroup | undefined;
    if (parent && parent.type === 'group') {
      parent.children.push(entity.id);
    }

    this.emitter.emit('entity-added', entity);
    this.emitter.emit('changed');
  }

  removeEntity(id: string): void {
    if (id === this.root.id) return;
    const entity = this.entities.get(id);
    if (!entity) return;

    // Remove from parent
    if (entity.parentId) {
      const parent = this.entities.get(entity.parentId) as IGroup | undefined;
      if (parent && parent.type === 'group') {
        parent.children = parent.children.filter(cid => cid !== id);
      }
    }

    // Recursively remove children if group
    if (entity.type === 'group') {
      const group = entity as IGroup;
      for (const childId of [...group.children]) {
        this.removeEntity(childId);
      }
    }

    // Clean up component instance reference
    if (entity.type === 'component_instance') {
      const inst = entity as IComponentInstance;
      const def = this.componentDefinitions.get(inst.definitionId);
      if (def) {
        def.instanceIds = def.instanceIds.filter(iid => iid !== id);
      }
    }

    this.entities.delete(id);
    this.emitter.emit('entity-removed', entity);
    this.emitter.emit('changed');
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  findEntitiesByType(type: EntityType): Entity[] {
    return this.getAllEntities().filter(e => e.type === type);
  }

  moveEntity(id: string, newParentId: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    // Remove from old parent
    if (entity.parentId) {
      const oldParent = this.entities.get(entity.parentId) as IGroup | undefined;
      if (oldParent && oldParent.type === 'group') {
        oldParent.children = oldParent.children.filter(cid => cid !== id);
      }
    }

    // Add to new parent
    entity.parentId = newParentId;
    const newParent = this.entities.get(newParentId) as IGroup | undefined;
    if (newParent && newParent.type === 'group') {
      newParent.children.push(id);
    }

    this.emitter.emit('entity-moved', id, newParentId);
    this.emitter.emit('changed');
  }

  // ── Groups ───────────────────────────────────────────────────

  createGroup(name: string, childIds: string[]): IGroup {
    const group: IGroup = {
      id: uuid(),
      type: 'group',
      name,
      visible: true,
      locked: false,
      layerId: DEFAULT_LAYER_ID,
      parentId: this.editingContext.activeGroupId ?? this.root.id,
      transform: identityTransform(),
      children: [],
      meshId: '',
    };

    this.entities.set(group.id, group);

    // Reparent children into the new group
    for (const childId of childIds) {
      const child = this.entities.get(childId);
      if (!child) continue;

      // Remove from old parent
      if (child.parentId) {
        const oldParent = this.entities.get(child.parentId) as IGroup | undefined;
        if (oldParent && oldParent.type === 'group') {
          oldParent.children = oldParent.children.filter(cid => cid !== childId);
        }
      }

      child.parentId = group.id;
      group.children.push(childId);
    }

    // Add group to its parent
    const parent = this.entities.get(group.parentId!) as IGroup | undefined;
    if (parent && parent.type === 'group') {
      parent.children.push(group.id);
    }

    this.emitter.emit('group-created', group);
    this.emitter.emit('changed');
    return group;
  }

  explodeGroup(groupId: string): void {
    const group = this.entities.get(groupId) as IGroup | undefined;
    if (!group || group.type !== 'group') return;
    if (groupId === this.root.id) return;

    const parentId = group.parentId ?? this.root.id;
    const parent = this.entities.get(parentId) as IGroup | undefined;

    // Move children up to parent
    for (const childId of group.children) {
      const child = this.entities.get(childId);
      if (!child) continue;
      child.parentId = parentId;
      if (parent && parent.type === 'group') {
        parent.children.push(childId);
      }
    }

    // Remove the group itself (without recursively removing children)
    group.children = [];
    if (parent && parent.type === 'group') {
      parent.children = parent.children.filter(cid => cid !== groupId);
    }
    this.entities.delete(groupId);

    this.emitter.emit('group-exploded', groupId);
    this.emitter.emit('changed');
  }

  enterGroup(groupId: string): void {
    const group = this.entities.get(groupId) as IGroup | undefined;
    if (!group || group.type !== 'group') return;

    this.editingContext.path.push(groupId);
    this.editingContext.activeGroupId = groupId;

    this.emitter.emit('editing-context-changed', { ...this.editingContext });
    this.emitter.emit('changed');
  }

  exitGroup(): void {
    if (this.editingContext.path.length === 0) return;

    this.editingContext.path.pop();
    this.editingContext.activeGroupId =
      this.editingContext.path.length > 0
        ? this.editingContext.path[this.editingContext.path.length - 1]
        : null;

    this.emitter.emit('editing-context-changed', { ...this.editingContext });
    this.emitter.emit('changed');
  }

  // ── Components ───────────────────────────────────────────────

  createComponentDefinition(name: string, meshId: string): IComponentDefinition {
    const def: IComponentDefinition = {
      id: uuid(),
      name,
      description: '',
      meshId,
      instanceIds: [],
    };
    this.componentDefinitions.set(def.id, def);
    this.emitter.emit('component-defined', def);
    this.emitter.emit('changed');
    return def;
  }

  placeComponentInstance(defId: string, transform: Transform): IComponentInstance {
    const def = this.componentDefinitions.get(defId);
    if (!def) {
      throw new Error(`Component definition '${defId}' not found`);
    }

    const instance: IComponentInstance = {
      id: uuid(),
      type: 'component_instance',
      name: def.name,
      visible: true,
      locked: false,
      layerId: DEFAULT_LAYER_ID,
      parentId: this.editingContext.activeGroupId ?? this.root.id,
      definitionId: defId,
      transform,
    };

    def.instanceIds.push(instance.id);
    this.entities.set(instance.id, instance);

    const parent = this.entities.get(instance.parentId!) as IGroup | undefined;
    if (parent && parent.type === 'group') {
      parent.children.push(instance.id);
    }

    this.emitter.emit('component-placed', instance);
    this.emitter.emit('changed');
    return instance;
  }

  // ── Layers ───────────────────────────────────────────────────

  addLayer(name: string): ILayer {
    const layer: ILayer = {
      id: uuid(),
      name,
      visible: true,
      locked: false,
      color: { r: 0, g: 0, b: 0 },
    };
    this.layers.set(layer.id, layer);
    this.emitter.emit('layer-added', layer);
    this.emitter.emit('changed');
    return layer;
  }

  removeLayer(id: string): void {
    if (id === DEFAULT_LAYER_ID) return; // cannot remove default layer
    if (!this.layers.has(id)) return;

    // Reassign entities on this layer to default
    for (const entity of this.entities.values()) {
      if (entity.layerId === id) {
        entity.layerId = DEFAULT_LAYER_ID;
      }
    }

    this.layers.delete(id);
    this.emitter.emit('layer-removed', id);
    this.emitter.emit('changed');
  }

  setLayerVisibility(id: string, visible: boolean): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.visible = visible;
    this.emitter.emit('layer-updated', layer);
    this.emitter.emit('changed');
  }

  setLayerLocked(id: string, locked: boolean): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.locked = locked;
    this.emitter.emit('changed');
  }

  setActiveLayer(id: string): void {
    if (!this.layers.has(id)) return;
    this.activeLayerId = id;
    this.emitter.emit('changed');
  }

  /** Get the layer ID for a geometry entity (face/edge). Falls back to active layer. */
  getEntityLayerId(entityId: string): string {
    return this.geometryLayerMap.get(entityId) ?? DEFAULT_LAYER_ID;
  }

  /** Check if a geometry entity's layer is visible. */
  isEntityVisible(entityId: string): boolean {
    const layerId = this.getEntityLayerId(entityId);
    const layer = this.layers.get(layerId);
    return layer ? layer.visible : true;
  }

  /** Check if a geometry entity's layer is locked. */
  isEntityLocked(entityId: string): boolean {
    const layerId = this.getEntityLayerId(entityId);
    const layer = this.layers.get(layerId);
    return layer ? layer.locked : false;
  }

  // ── Components ─────────────────────────────────────────────

  /** Create a component from a set of face/edge IDs. */
  createComponent(name: string, entityIds: string[]): string {
    const id = uuid();
    this.components.set(id, { id, name, entityIds: new Set(entityIds) });
    this.emitter.emit('changed');
    return id;
  }

  /** Explode a component back to loose geometry. */
  explodeComponent(componentId: string): void {
    this.components.delete(componentId);
    if (this.editingComponentId === componentId) {
      this.exitComponent();
    }
    this.editingComponentStack = this.editingComponentStack.filter(id => id !== componentId);
    this.emitter.emit('changed');
  }

  /** Get the component that contains this entity ID, or null.
   *  Respects the component hierarchy like SketchUp:
   *  - At the top level, returns the outermost (largest) component
   *  - When editing a component, returns the direct child component
   *    (smallest component that still contains entities not in deeper sub-components)
   *  This means first click selects the top-level component, double-click enters it,
   *  then you can select its direct children, and so on down the hierarchy. */
  getEntityComponent(entityId: string): string | null {
    const editingComp = this.editingComponentId
      ? this.components.get(this.editingComponentId) : null;

    // Collect all components containing this entity
    const containing: Array<{ id: string; size: number }> = [];
    for (const [compId, comp] of this.components) {
      if (!comp.entityIds.has(entityId)) continue;
      if (compId === this.editingComponentId) continue;
      containing.push({ id: compId, size: comp.entityIds.size });
    }
    if (containing.length === 0) return null;

    if (!editingComp) {
      // Top level: return the outermost (largest) component
      let best = containing[0];
      for (let i = 1; i < containing.length; i++) {
        if (containing[i].size > best.size) best = containing[i];
      }
      return best.id;
    }

    // Editing a component: find the direct child component.
    // Filter to only components that are subsets of the editing component.
    const children: Array<{ id: string; size: number }> = [];
    for (const c of containing) {
      if (c.size >= editingComp.entityIds.size) continue;
      const comp = this.components.get(c.id)!;
      // Verify it's actually a subset
      let isSubset = true;
      for (const eid of comp.entityIds) {
        if (!editingComp.entityIds.has(eid)) { isSubset = false; break; }
      }
      if (isSubset) children.push(c);
    }
    if (children.length === 0) return null;

    // Return the largest child — this is the "direct" child in the hierarchy.
    // (A direct child component is larger than its own sub-components.)
    let best = children[0];
    for (let i = 1; i < children.length; i++) {
      if (children[i].size > best.size) best = children[i];
    }
    return best.id;
  }

  /** Check if an entity is inside a component and NOT currently being edited. */
  isEntityProtected(entityId: string): boolean {
    const compId = this.getEntityComponent(entityId);
    if (!compId) return false; // Not in a component — freely editable
    return true; // getEntityComponent already excludes the editing component
  }

  /** Enter component editing mode (supports nesting). */
  enterComponent(componentId: string): void {
    if (!this.components.has(componentId)) return;
    if (this.editingComponentId) {
      this.editingComponentStack.push(this.editingComponentId);
    }
    this.editingComponentId = componentId;
    this.emitter.emit('changed');
  }

  /** Exit component editing mode (pops one level, or exits to main scene). */
  exitComponent(): void {
    if (this.editingComponentStack.length > 0) {
      this.editingComponentId = this.editingComponentStack.pop()!;
    } else {
      this.editingComponentId = null;
    }
    this.emitter.emit('changed');
  }

  /** Check if we're currently editing a component. */
  get isEditingComponent(): boolean {
    return this.editingComponentId !== null;
  }

  /** Get the entity IDs that are editable in the current context. */
  isEntityEditable(entityId: string): boolean {
    if (this.editingComponentId) {
      const comp = this.components.get(this.editingComponentId);
      if (!comp || !comp.entityIds.has(entityId)) return false;
      // Entity is in the editing component, but check if it's also in a child component
      return !this.isEntityProtected(entityId);
    }
    // In main scene, entities NOT in any component are editable
    return !this.getEntityComponent(entityId);
  }

  assignToLayer(entityId: string, layerId: string): void {
    // Check scene entities
    const entity = this.entities.get(entityId);
    if (entity) {
      if (!this.layers.has(layerId)) return;
      entity.layerId = layerId;
    }
    // Also works for geometry entities (faces/edges)
    if (this.layers.has(layerId)) {
      this.geometryLayerMap.set(entityId, layerId);
    }
    this.emitter.emit('changed');
  }

  // ── Scene Pages ──────────────────────────────────────────────

  addScenePage(page: Omit<IScenePage, 'id'>): IScenePage {
    const scenePage: IScenePage = { id: uuid(), ...page };
    this.scenePages.push(scenePage);
    this.emitter.emit('scene-page-added', scenePage);
    this.emitter.emit('changed');
    return scenePage;
  }

  removeScenePage(id: string): void {
    const idx = this.scenePages.findIndex(p => p.id === id);
    if (idx === -1) return;
    this.scenePages.splice(idx, 1);
    this.emitter.emit('scene-page-removed', id);
    this.emitter.emit('changed');
  }

  // ── Events ───────────────────────────────────────────────────

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.emitter.on(event as keyof SceneEvents, handler as never);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.emitter.off(event as keyof SceneEvents, handler as never);
  }
}

// @archigraph test.integration.scene
// Integration tests for the scene manager

import { SceneManager } from '../../src/data/SceneManager';
import { SelectionManager } from '../../src/data/SelectionManager';
import type { Entity } from '../../src/core/types';

describe('Scene Manager', () => {
  let scene: SceneManager;

  beforeEach(() => {
    scene = new SceneManager();
  });

  describe('Entity management', () => {
    test('should add entity to root', () => {
      const entity: Entity = {
        id: 'test-1',
        type: 'group',
        visible: true,
        locked: false,
        layerId: 'default',
        parentId: null,
      };
      scene.addEntity(entity);
      expect(scene.getEntity('test-1')).toBeDefined();
    });

    test('should remove entity', () => {
      const entity: Entity = {
        id: 'test-1',
        type: 'face',
        visible: true,
        locked: false,
        layerId: 'default',
        parentId: null,
      };
      scene.addEntity(entity);
      scene.removeEntity('test-1');
      expect(scene.getEntity('test-1')).toBeUndefined();
    });

    test('should find entities by type', () => {
      scene.addEntity({ id: 'f1', type: 'face', visible: true, locked: false, layerId: 'default', parentId: null });
      scene.addEntity({ id: 'e1', type: 'edge', visible: true, locked: false, layerId: 'default', parentId: null });
      scene.addEntity({ id: 'f2', type: 'face', visible: true, locked: false, layerId: 'default', parentId: null });
      const faces = scene.findEntitiesByType('face');
      expect(faces).toHaveLength(2);
    });
  });

  describe('Layer management', () => {
    test('should add a layer', () => {
      const layer = scene.addLayer('Test Layer');
      expect(layer.name).toBe('Test Layer');
      expect(layer.visible).toBe(true);
    });

    test('should toggle layer visibility', () => {
      const layer = scene.addLayer('Test');
      scene.setLayerVisibility(layer.id, false);
      expect(scene.layers.get(layer.id)?.visible).toBe(false);
    });

    test('should remove a layer', () => {
      const layer = scene.addLayer('Test');
      scene.removeLayer(layer.id);
      expect(scene.layers.get(layer.id)).toBeUndefined();
    });
  });

  describe('Group management', () => {
    test('should create a group', () => {
      scene.addEntity({ id: 'e1', type: 'face', visible: true, locked: false, layerId: 'default', parentId: null });
      const group = scene.createGroup('My Group', ['e1']);
      expect(group.type).toBe('group');
      expect(group.children).toContain('e1');
    });

    test('should enter and exit group editing', () => {
      const group = scene.createGroup('G1', []);
      scene.enterGroup(group.id);
      expect(scene.editingContext.activeGroupId).toBe(group.id);
      scene.exitGroup();
      expect(scene.editingContext.activeGroupId).toBeNull();
    });
  });

  describe('Scene pages', () => {
    test('should add a scene page', () => {
      const page = scene.addScenePage({
        name: 'Front View',
        cameraPosition: { x: 0, y: 0, z: 10 },
        cameraTarget: { x: 0, y: 0, z: 0 },
        cameraFov: 45,
        projection: 'perspective',
        renderMode: 'shaded',
        layerVisibility: {},
      });
      expect(page.name).toBe('Front View');
      expect(scene.scenePages).toHaveLength(1);
    });
  });
});

describe('Selection Manager', () => {
  let selection: SelectionManager;

  beforeEach(() => {
    selection = new SelectionManager();
  });

  test('should select an entity', () => {
    selection.select('e1');
    expect(selection.isSelected('e1')).toBe(true);
    expect(selection.count).toBe(1);
  });

  test('should add to selection', () => {
    selection.select('e1');
    selection.add('e2');
    expect(selection.count).toBe(2);
  });

  test('should toggle selection', () => {
    selection.select('e1');
    selection.toggle('e1');
    expect(selection.isEmpty).toBe(true);
  });

  test('should clear selection', () => {
    selection.select('e1');
    selection.add('e2');
    selection.clear();
    expect(selection.isEmpty).toBe(true);
  });

  test('should set pre-selection', () => {
    selection.setPreSelection('e1');
    expect(selection.state.preSelectionId).toBe('e1');
  });

  test('should change selection mode', () => {
    selection.setMode('face');
    expect(selection.state.mode).toBe('face');
  });
});

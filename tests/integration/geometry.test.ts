// @archigraph test.integration.geometry
// Integration tests for the geometry engine

import { GeometryEngine } from '../../src/engine/geometry/GeometryEngine';
import { vec3 } from '../../src/core/math';
import type { IGeometryEngine } from '../../src/core/interfaces';

describe('Geometry Engine', () => {
  let engine: IGeometryEngine;

  beforeEach(() => {
    engine = new GeometryEngine();
  });

  describe('Vertex operations', () => {
    test('should create a vertex', () => {
      const v = engine.createVertex(vec3.create(1, 2, 3));
      expect(v).toBeDefined();
      expect(v.position.x).toBe(1);
      expect(v.position.y).toBe(2);
      expect(v.position.z).toBe(3);
    });

    test('should retrieve a created vertex', () => {
      const v = engine.createVertex(vec3.create(0, 0, 0));
      const retrieved = engine.getVertex(v.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(v.id);
    });

    test('should delete a vertex', () => {
      const v = engine.createVertex(vec3.create(0, 0, 0));
      engine.deleteVertex(v.id);
      expect(engine.getVertex(v.id)).toBeUndefined();
    });
  });

  describe('Edge operations', () => {
    test('should create an edge between two vertices', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const edge = engine.createEdge(v1.id, v2.id);
      expect(edge).toBeDefined();
      expect(edge.startVertexId).toBe(v1.id);
      expect(edge.endVertexId).toBe(v2.id);
    });

    test('should compute edge length', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(3, 4, 0));
      const edge = engine.createEdge(v1.id, v2.id);
      expect(engine.computeEdgeLength(edge.id)).toBeCloseTo(5);
    });

    test('should find edge between vertices', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const edge = engine.createEdge(v1.id, v2.id);
      const found = engine.findEdgeBetween(v1.id, v2.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(edge.id);
    });
  });

  describe('Face operations', () => {
    test('should create a triangular face', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(0, 1, 0));
      const face = engine.createFace([v1.id, v2.id, v3.id]);
      expect(face).toBeDefined();
      expect(face.vertexIds).toHaveLength(3);
    });

    test('should create a rectangular face', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(1, 0, 1));
      const v4 = engine.createVertex(vec3.create(0, 0, 1));
      const face = engine.createFace([v1.id, v2.id, v3.id, v4.id]);
      expect(face).toBeDefined();
      expect(face.vertexIds).toHaveLength(4);
    });

    test('should compute face normal', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(0, 0, 1));
      const face = engine.createFace([v1.id, v2.id, v3.id]);
      const normal = engine.computeFaceNormal(face.id);
      expect(normal.y).toBeCloseTo(-1, 5); // XZ plane, normal points down
    });

    test('should compute face area', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(2, 0, 0));
      const v3 = engine.createVertex(vec3.create(2, 0, 2));
      const v4 = engine.createVertex(vec3.create(0, 0, 2));
      const face = engine.createFace([v1.id, v2.id, v3.id, v4.id]);
      expect(engine.computeFaceArea(face.id)).toBeCloseTo(4);
    });

    test('should check coplanarity', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(0, 0, 1));
      const v4 = engine.createVertex(vec3.create(1, 0, 1));
      expect(engine.checkCoplanar([v1.id, v2.id, v3.id, v4.id])).toBe(true);
    });
  });

  describe('Topology queries', () => {
    test('should get edges connected to vertex', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(0, 1, 0));
      engine.createEdge(v1.id, v2.id);
      engine.createEdge(v1.id, v3.id);
      const edges = engine.getVertexEdges(v1.id);
      expect(edges).toHaveLength(2);
    });

    test('should get connected faces', () => {
      const v1 = engine.createVertex(vec3.create(0, 0, 0));
      const v2 = engine.createVertex(vec3.create(1, 0, 0));
      const v3 = engine.createVertex(vec3.create(1, 1, 0));
      const v4 = engine.createVertex(vec3.create(0, 1, 0));
      const f1 = engine.createFace([v1.id, v2.id, v3.id]);
      const f2 = engine.createFace([v1.id, v3.id, v4.id]);
      const connected = engine.getConnectedFaces(f1.id);
      expect(connected.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Bounding box', () => {
    test('should compute bounding box', () => {
      engine.createVertex(vec3.create(-1, 0, -1));
      engine.createVertex(vec3.create(2, 3, 4));
      const box = engine.getBoundingBox();
      expect(box.min.x).toBe(-1);
      expect(box.max.x).toBe(2);
      expect(box.max.y).toBe(3);
    });
  });

  describe('Serialization', () => {
    test('should serialize and deserialize', () => {
      const v1 = engine.createVertex(vec3.create(1, 2, 3));
      const v2 = engine.createVertex(vec3.create(4, 5, 6));
      engine.createEdge(v1.id, v2.id);

      const buffer = engine.serialize();
      expect(buffer.byteLength).toBeGreaterThan(0);

      const engine2 = new GeometryEngine();
      engine2.deserialize(buffer);
      const mesh = engine2.getMesh();
      expect(mesh.vertices.size).toBe(2);
      expect(mesh.edges.size).toBe(1);
    });
  });
});

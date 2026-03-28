// @archigraph test.perf.geometry
// Performance benchmarks for geometry operations

import { GeometryEngine } from '../../src/engine/geometry/GeometryEngine';
import { vec3 } from '../../src/core/math';

describe('Geometry Performance', () => {
  test('should create 10,000 vertices in under 100ms', () => {
    const engine = new GeometryEngine();
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      engine.createVertex(vec3.create(Math.random(), Math.random(), Math.random()));
    }
    const elapsed = performance.now() - start;
    console.log(`10,000 vertices: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  test('should create 1,000 faces in under 200ms', () => {
    const engine = new GeometryEngine();
    const vertices = [];
    for (let i = 0; i < 4000; i++) {
      vertices.push(engine.createVertex(vec3.create(
        Math.random() * 100, Math.random() * 100, Math.random() * 100
      )));
    }

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const base = i * 3;
      if (base + 2 < vertices.length) {
        engine.createFace([vertices[base].id, vertices[base + 1].id, vertices[base + 2].id]);
      }
    }
    const elapsed = performance.now() - start;
    console.log(`1,000 faces: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  test('should compute bounding box of 100K vertices in under 50ms', () => {
    const engine = new GeometryEngine();
    for (let i = 0; i < 100000; i++) {
      engine.createVertex(vec3.create(
        Math.random() * 1000, Math.random() * 1000, Math.random() * 1000
      ));
    }

    const start = performance.now();
    engine.getBoundingBox();
    const elapsed = performance.now() - start;
    console.log(`Bounding box 100K verts: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(50);
  });

  test('should serialize/deserialize 10K entities in under 500ms', () => {
    const engine = new GeometryEngine();
    for (let i = 0; i < 10000; i++) {
      engine.createVertex(vec3.create(Math.random(), Math.random(), Math.random()));
    }

    const startSerialize = performance.now();
    const buffer = engine.serialize();
    const serializeTime = performance.now() - startSerialize;

    const engine2 = new GeometryEngine();
    const startDeserialize = performance.now();
    engine2.deserialize(buffer);
    const deserializeTime = performance.now() - startDeserialize;

    console.log(`Serialize 10K: ${serializeTime.toFixed(1)}ms, Deserialize: ${deserializeTime.toFixed(1)}ms`);
    expect(serializeTime + deserializeTime).toBeLessThan(500);
  });
});

// @archigraph file.dxf-format
// AutoCAD DXF import/export for DraftDown

import { Vec3 } from '../../src/core/types';
import { IMesh } from '../../src/core/interfaces';

// ─── Types ──────────────────────────────────────────────────────

export interface DxfImportResult {
  lines: Array<{ start: Vec3; end: Vec3; layer: string }>;
  faces3d: Array<{ vertices: [Vec3, Vec3, Vec3] | [Vec3, Vec3, Vec3, Vec3]; layer: string }>;
  polylines: Array<{ vertices: Vec3[]; closed: boolean; layer: string }>;
}

export interface DxfExportOptions {
  /** DXF layer name for geometry */
  layerName?: string;
  /** Decimal precision for coordinates */
  precision?: number;
}

// ─── DXF Writer Helpers ─────────────────────────────────────────

function dxfPair(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function dxfSection(name: string, content: string): string {
  return [
    dxfPair(0, 'SECTION'),
    dxfPair(2, name),
    content,
    dxfPair(0, 'ENDSEC'),
  ].join('\n');
}

function dxfVertex(groupBase: number, v: Vec3, precision: number): string {
  return [
    dxfPair(groupBase, v.x.toFixed(precision)),
    dxfPair(groupBase + 10, v.y.toFixed(precision)),
    dxfPair(groupBase + 20, v.z.toFixed(precision)),
  ].join('\n');
}

// ─── Export ─────────────────────────────────────────────────────

export function exportDxf(mesh: IMesh, options: DxfExportOptions = {}): string {
  const {
    layerName = '0',
    precision = 6,
  } = options;

  const entities: string[] = [];

  // Export edges as LINE entities
  for (const edge of mesh.edges.values()) {
    const startVertex = mesh.vertices.get(edge.startVertexId);
    const endVertex = mesh.vertices.get(edge.endVertexId);
    if (!startVertex || !endVertex) continue;

    entities.push([
      dxfPair(0, 'LINE'),
      dxfPair(8, layerName),
      dxfVertex(10, startVertex.position, precision),
      dxfVertex(11, endVertex.position, precision),
    ].join('\n'));
  }

  // Export faces as 3DFACE entities
  for (const face of mesh.faces.values()) {
    const vids = face.vertexIds;
    if (vids.length < 3) continue;

    // Fan-triangulate n-gons into 3DFACEs (3 or 4 vertex faces)
    const positions: Vec3[] = [];
    for (const vid of vids) {
      const v = mesh.vertices.get(vid);
      if (v) positions.push(v.position);
    }

    if (positions.length === 3) {
      // 3-vertex face: emit one 3DFACE with 4th vertex = 3rd vertex
      entities.push([
        dxfPair(0, '3DFACE'),
        dxfPair(8, layerName),
        dxfVertex(10, positions[0], precision),
        dxfVertex(11, positions[1], precision),
        dxfVertex(12, positions[2], precision),
        dxfVertex(13, positions[2], precision), // duplicate last for triangle
      ].join('\n'));
    } else if (positions.length === 4) {
      entities.push([
        dxfPair(0, '3DFACE'),
        dxfPair(8, layerName),
        dxfVertex(10, positions[0], precision),
        dxfVertex(11, positions[1], precision),
        dxfVertex(12, positions[2], precision),
        dxfVertex(13, positions[3], precision),
      ].join('\n'));
    } else {
      // Fan-triangulate into 3DFACE triangles
      for (let i = 1; i < positions.length - 1; i++) {
        entities.push([
          dxfPair(0, '3DFACE'),
          dxfPair(8, layerName),
          dxfVertex(10, positions[0], precision),
          dxfVertex(11, positions[i], precision),
          dxfVertex(12, positions[i + 1], precision),
          dxfVertex(13, positions[i + 1], precision),
        ].join('\n'));
      }
    }
  }

  // Build HEADER section (minimal)
  const header = [
    dxfPair(9, '$ACADVER'),
    dxfPair(1, 'AC1015'), // AutoCAD 2000
    dxfPair(9, '$INSUNITS'),
    dxfPair(70, 6), // meters
  ].join('\n');

  // Build TABLES section with a layer table
  const tables = [
    dxfPair(0, 'TABLE'),
    dxfPair(2, 'LAYER'),
    dxfPair(70, 1),
    dxfPair(0, 'LAYER'),
    dxfPair(2, layerName),
    dxfPair(70, 0),
    dxfPair(62, 7), // white
    dxfPair(6, 'CONTINUOUS'),
    dxfPair(0, 'ENDTAB'),
  ].join('\n');

  const dxf = [
    dxfSection('HEADER', header),
    dxfSection('TABLES', tables),
    dxfSection('ENTITIES', entities.join('\n')),
    dxfPair(0, 'EOF'),
  ].join('\n');

  return dxf;
}

// ─── Import ─────────────────────────────────────────────────────

export function importDxf(text: string): DxfImportResult {
  const lines: DxfImportResult['lines'] = [];
  const faces3d: DxfImportResult['faces3d'] = [];
  const polylines: DxfImportResult['polylines'] = [];

  // Parse DXF into group code/value pairs
  const rawLines = text.split(/\r?\n/);
  const pairs: Array<{ code: number; value: string }> = [];
  for (let i = 0; i < rawLines.length - 1; i += 2) {
    const code = parseInt(rawLines[i].trim(), 10);
    const value = rawLines[i + 1]?.trim() ?? '';
    if (!isNaN(code)) {
      pairs.push({ code, value });
    }
  }

  // Find ENTITIES section
  let inEntities = false;
  let i = 0;

  while (i < pairs.length) {
    const { code, value } = pairs[i];

    if (code === 0 && value === 'SECTION') {
      if (i + 1 < pairs.length && pairs[i + 1].code === 2 && pairs[i + 1].value === 'ENTITIES') {
        inEntities = true;
        i += 2;
        continue;
      }
    }

    if (code === 0 && value === 'ENDSEC') {
      inEntities = false;
      i++;
      continue;
    }

    if (!inEntities) {
      i++;
      continue;
    }

    // Parse LINE entity
    if (code === 0 && value === 'LINE') {
      const entity: Record<number, number> = {};
      let layer = '0';
      i++;
      while (i < pairs.length && !(pairs[i].code === 0)) {
        if (pairs[i].code === 8) layer = pairs[i].value;
        entity[pairs[i].code] = parseFloat(pairs[i].value);
        i++;
      }
      lines.push({
        start: { x: entity[10] ?? 0, y: entity[20] ?? 0, z: entity[30] ?? 0 },
        end: { x: entity[11] ?? 0, y: entity[21] ?? 0, z: entity[31] ?? 0 },
        layer,
      });
      continue;
    }

    // Parse 3DFACE entity
    if (code === 0 && value === '3DFACE') {
      const entity: Record<number, number> = {};
      let layer = '0';
      i++;
      while (i < pairs.length && !(pairs[i].code === 0)) {
        if (pairs[i].code === 8) layer = pairs[i].value;
        entity[pairs[i].code] = parseFloat(pairs[i].value);
        i++;
      }
      const v0: Vec3 = { x: entity[10] ?? 0, y: entity[20] ?? 0, z: entity[30] ?? 0 };
      const v1: Vec3 = { x: entity[11] ?? 0, y: entity[21] ?? 0, z: entity[31] ?? 0 };
      const v2: Vec3 = { x: entity[12] ?? 0, y: entity[22] ?? 0, z: entity[32] ?? 0 };
      const v3: Vec3 = { x: entity[13] ?? 0, y: entity[23] ?? 0, z: entity[33] ?? 0 };

      // Check if v3 == v2 (triangle, not quad)
      const isTriangle =
        Math.abs(v3.x - v2.x) < 1e-10 &&
        Math.abs(v3.y - v2.y) < 1e-10 &&
        Math.abs(v3.z - v2.z) < 1e-10;

      if (isTriangle) {
        faces3d.push({ vertices: [v0, v1, v2], layer });
      } else {
        faces3d.push({ vertices: [v0, v1, v2, v3], layer });
      }
      continue;
    }

    // Parse POLYLINE entity (simplified)
    if (code === 0 && value === 'POLYLINE') {
      let layer = '0';
      let closed = false;
      const verts: Vec3[] = [];
      i++;
      // Read polyline flags
      while (i < pairs.length && pairs[i].code !== 0) {
        if (pairs[i].code === 8) layer = pairs[i].value;
        if (pairs[i].code === 70) closed = (parseInt(pairs[i].value) & 1) !== 0;
        i++;
      }
      // Read VERTEX entities until SEQEND
      while (i < pairs.length) {
        if (pairs[i].code === 0 && pairs[i].value === 'SEQEND') {
          i++;
          break;
        }
        if (pairs[i].code === 0 && pairs[i].value === 'VERTEX') {
          const vent: Record<number, number> = {};
          i++;
          while (i < pairs.length && pairs[i].code !== 0) {
            vent[pairs[i].code] = parseFloat(pairs[i].value);
            i++;
          }
          verts.push({ x: vent[10] ?? 0, y: vent[20] ?? 0, z: vent[30] ?? 0 });
          continue;
        }
        i++;
      }
      if (verts.length > 0) {
        polylines.push({ vertices: verts, closed, layer });
      }
      continue;
    }

    i++;
  }

  return { lines, faces3d, polylines };
}

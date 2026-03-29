// @archigraph file.skp
// SketchUp (.skp) file importer — reads binary SKP format and extracts geometry.
// The SKP format is proprietary; this parser extracts header info and uses
// heuristics to locate vertex/edge/face data from the serialized stream.

import { Vec3 } from '../../src/core/types';

// ─── Types ──────────────────────────────────────────────────────

export interface SkpClassEntry {
  name: string;
  version: number;
}

export interface SkpHeader {
  version: string;          // e.g. "20.2.171"
  filePath: string;         // original save path (UTF-16LE)
  classes: SkpClassEntry[]; // CVersionMap entries
}

export interface SkpImportResult {
  header: SkpHeader;
  vertices: Vec3[];
  faces: Array<number[]>;   // each face is an array of vertex indices
  edges: Array<[number, number]>;
}

// ─── UTF-16LE Helpers ───────────────────────────────────────────

function readUtf16LE(data: Uint8Array, offset: number, charCount: number): string {
  const view = new DataView(data.buffer, data.byteOffset + offset, charCount * 2);
  let str = '';
  for (let i = 0; i < charCount; i++) {
    str += String.fromCharCode(view.getUint16(i * 2, true));
  }
  return str;
}

// ─── Header Parsing ─────────────────────────────────────────────

function parseHeader(data: Uint8Array): SkpHeader {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate magic: ff fe ff 0e
  if (data[0] !== 0xff || data[1] !== 0xfe || data[2] !== 0xff || data[3] !== 0x0e) {
    throw new Error('Not a valid SketchUp file — missing magic header');
  }

  // Read "SketchUp Model" (14 chars UTF-16LE) starting at offset 4
  const modelLabel = readUtf16LE(data, 4, 14);
  if (modelLabel !== 'SketchUp Model') {
    throw new Error('Not a valid SketchUp file — missing model label');
  }

  // After the label: ff fe ff 0a then version string in UTF-16LE
  // Find the version string between { and }
  let version = '';
  let filePath = '';

  // Scan for version: look for '{' in UTF-16LE after the model label
  let pos = 32;
  while (pos < Math.min(data.length, 200)) {
    if (data[pos] === 0xff && data[pos + 1] === 0xfe && data[pos + 2] === 0xff) {
      const charCount = data[pos + 3];
      if (charCount > 0 && charCount < 100 && pos + 4 + charCount * 2 <= data.length) {
        const str = readUtf16LE(data, pos + 4, charCount);
        if (str.startsWith('{') && str.endsWith('}')) {
          version = str.slice(1, -1);
        } else if (str.includes('/') || str.includes('\\')) {
          filePath = str;
        }
        pos += 4 + charCount * 2;
        continue;
      }
    }
    pos++;
  }

  // Parse CVersionMap
  const classes: SkpClassEntry[] = [];
  const versionMapMarker = findBytes(data, stringToBytes('CVersionMap'));
  if (versionMapMarker >= 0) {
    let p = versionMapMarker + 11; // skip "CVersionMap"
    while (p < data.length - 10) {
      // Pattern: ff feff <len> <utf16le-name> <version-4bytes>
      if (data[p] === 0xff && data[p + 1] === 0xfe && data[p + 2] === 0xff) {
        const nameLen = data[p + 3];
        if (nameLen > 0 && nameLen <= 50 && p + 4 + nameLen * 2 + 4 <= data.length) {
          const name = readUtf16LE(data, p + 4, nameLen);
          const ver = view.getUint32(p + 4 + nameLen * 2, true);
          if (name === 'End-Of-Version-Map') break;
          classes.push({ name, version: ver });
          p = p + 4 + nameLen * 2 + 4;
          continue;
        }
      }
      p++;
    }
  }

  return { version, filePath, classes };
}

function findBytes(data: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─── Geometry Extraction (Heuristic) ────────────────────────────

/**
 * Extract vertex positions from the SKP binary by scanning for clusters
 * of 3 consecutive IEEE-754 doubles that look like 3D coordinates.
 * SketchUp stores positions in inches.
 */
function extractVertices(data: Uint8Array, startOffset: number): Vec3[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const candidates: Array<{ offset: number; pos: Vec3 }> = [];

  // Scan for Point3d values (3 consecutive doubles = 24 bytes)
  // Look for values in a reasonable range for architectural models (±5000 inches)
  for (let i = startOffset; i <= data.length - 24; i += 8) {
    try {
      const x = view.getFloat64(i, true);
      const y = view.getFloat64(i + 8, true);
      const z = view.getFloat64(i + 16, true);

      // Filter: reasonable range, at least 2 non-zero coords, not NaN/Inf
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      if (Math.abs(x) > 5000 || Math.abs(y) > 5000 || Math.abs(z) > 5000) continue;

      const nonZero = (Math.abs(x) > 0.001 ? 1 : 0)
                    + (Math.abs(y) > 0.001 ? 1 : 0)
                    + (Math.abs(z) > 0.001 ? 1 : 0);
      if (nonZero < 2) continue;

      candidates.push({ offset: i, pos: { x, y, z } });
    } catch {
      continue;
    }
  }

  // De-duplicate vertices that are very close (within 0.001 inches)
  const unique: Vec3[] = [];
  const seen = new Set<string>();

  for (const { pos } of candidates) {
    const key = `${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(pos);
    }
  }

  return unique;
}

/**
 * Try to form faces from extracted vertices by finding coplanar groups
 * of 3-4 vertices that are close together and form convex shapes.
 */
function inferFaces(vertices: Vec3[]): Array<number[]> {
  if (vertices.length < 3) return [];

  const faces: Array<number[]> = [];
  const used = new Set<number>();

  // Build a spatial index for finding nearby vertices
  const TOLERANCE = 0.01;

  // Group vertices by proximity — find rectangular faces
  for (let i = 0; i < vertices.length && faces.length < 10000; i++) {
    if (used.has(i)) continue;

    // Find vertices that share two coordinate values with vertex i
    // (they'd form edges of axis-aligned rectangles)
    const coplanar: number[] = [i];

    for (let j = i + 1; j < vertices.length; j++) {
      if (used.has(j)) continue;
      const a = vertices[i];
      const b = vertices[j];

      // Check if they share at least one axis value (coplanar check)
      const sharedX = Math.abs(a.x - b.x) < TOLERANCE;
      const sharedY = Math.abs(a.y - b.y) < TOLERANCE;
      const sharedZ = Math.abs(a.z - b.z) < TOLERANCE;

      if ((sharedX ? 1 : 0) + (sharedY ? 1 : 0) + (sharedZ ? 1 : 0) >= 1) {
        // Check distance — vertices in the same face should be reasonably close
        const dist = Math.sqrt(
          (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2,
        );
        if (dist < 200 && dist > TOLERANCE) {
          coplanar.push(j);
        }
      }
    }

    // If we found 3+ coplanar vertices, try to form a face
    if (coplanar.length >= 3 && coplanar.length <= 8) {
      // Sort vertices to form a proper polygon (convex hull in 2D on the shared plane)
      const sorted = sortCoplanarVertices(vertices, coplanar);
      if (sorted.length >= 3) {
        faces.push(sorted);
        for (const idx of sorted) used.add(idx);
      }
    }
  }

  return faces;
}

function sortCoplanarVertices(vertices: Vec3[], indices: number[]): number[] {
  if (indices.length < 3) return indices;

  // Find the centroid
  let cx = 0, cy = 0, cz = 0;
  for (const i of indices) {
    cx += vertices[i].x;
    cy += vertices[i].y;
    cz += vertices[i].z;
  }
  cx /= indices.length;
  cy /= indices.length;
  cz /= indices.length;

  // Determine the dominant plane by finding which axis has least variance
  let varX = 0, varY = 0, varZ = 0;
  for (const i of indices) {
    varX += (vertices[i].x - cx) ** 2;
    varY += (vertices[i].y - cy) ** 2;
    varZ += (vertices[i].z - cz) ** 2;
  }

  // Sort by angle around centroid on the dominant plane
  const sorted = [...indices];
  if (varX <= varY && varX <= varZ) {
    // YZ plane
    sorted.sort((a, b) => {
      const angleA = Math.atan2(vertices[a].z - cz, vertices[a].y - cy);
      const angleB = Math.atan2(vertices[b].z - cz, vertices[b].y - cy);
      return angleA - angleB;
    });
  } else if (varY <= varX && varY <= varZ) {
    // XZ plane
    sorted.sort((a, b) => {
      const angleA = Math.atan2(vertices[a].z - cz, vertices[a].x - cx);
      const angleB = Math.atan2(vertices[b].z - cz, vertices[b].x - cx);
      return angleA - angleB;
    });
  } else {
    // XY plane
    sorted.sort((a, b) => {
      const angleA = Math.atan2(vertices[a].y - cy, vertices[a].x - cx);
      const angleB = Math.atan2(vertices[b].y - cy, vertices[b].x - cx);
      return angleA - angleB;
    });
  }

  return sorted;
}

/**
 * Infer edges from face vertex lists.
 */
function inferEdges(faces: Array<number[]>): Array<[number, number]> {
  const edgeSet = new Set<string>();
  const edges: Array<[number, number]> = [];

  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([a, b]);
      }
    }
  }

  return edges;
}

// ─── Main Import Function ───────────────────────────────────────

export function importSkp(buffer: ArrayBuffer): SkpImportResult {
  const data = new Uint8Array(buffer);
  const header = parseHeader(data);

  // Find where geometry data starts (after thumbnail PNG)
  const pngEnd = findPngEnd(data);
  const geometryStart = pngEnd > 0 ? pngEnd : 2200;

  console.log(`[SKP] Version: ${header.version}`);
  console.log(`[SKP] Classes: ${header.classes.length}`);
  console.log(`[SKP] Geometry scan starting at offset ${geometryStart}`);

  const vertices = extractVertices(data, geometryStart);
  console.log(`[SKP] Extracted ${vertices.length} unique vertices`);

  const faces = inferFaces(vertices);
  console.log(`[SKP] Inferred ${faces.length} faces`);

  const edges = inferEdges(faces);
  console.log(`[SKP] Inferred ${edges.length} edges`);

  return { header, vertices, faces, edges };
}

function findPngEnd(data: Uint8Array): number {
  // PNG files end with IEND chunk: 00 00 00 00 49 45 4e 44 ae 42 60 82
  const iend = stringToBytes('IEND');
  const pos = findBytes(data, iend);
  if (pos > 0) {
    return pos + 8; // IEND + CRC32
  }
  return -1;
}

/**
 * Convert SketchUp inches to meters (for Three.js default units).
 * SketchUp stores all coords in inches.
 */
export function inchesToMeters(v: Vec3): Vec3 {
  const INCH_TO_METER = 0.0254;
  return {
    x: v.x * INCH_TO_METER,
    y: v.y * INCH_TO_METER,
    z: v.z * INCH_TO_METER,
  };
}

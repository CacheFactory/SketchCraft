// @archigraph file.fbx-format
// FBX format stub for SketchCraft
// Provides a basic binary FBX export skeleton and placeholder import.

import { Vec3, MaterialDef } from '../core/types';
import { IMesh } from '../core/interfaces';

// ─── Constants ──────────────────────────────────────────────────

// FBX binary magic: "Kaydara FBX Binary  \x00"
const FBX_MAGIC = 'Kaydara FBX Binary  \x00';
const FBX_VERSION = 7500; // FBX 2019

// FBX property type codes
const FBX_TYPE_SHORT = 'Y'.charCodeAt(0);   // int16
const FBX_TYPE_INT = 'I'.charCodeAt(0);     // int32
const FBX_TYPE_LONG = 'L'.charCodeAt(0);    // int64
const FBX_TYPE_FLOAT = 'F'.charCodeAt(0);   // float32
const FBX_TYPE_DOUBLE = 'D'.charCodeAt(0);  // float64
const FBX_TYPE_STRING = 'S'.charCodeAt(0);  // string
const FBX_TYPE_RAW = 'R'.charCodeAt(0);     // raw bytes
const FBX_TYPE_INT_ARRAY = 'i'.charCodeAt(0);
const FBX_TYPE_DOUBLE_ARRAY = 'd'.charCodeAt(0);
const FBX_TYPE_FLOAT_ARRAY = 'f'.charCodeAt(0);
const FBX_TYPE_LONG_ARRAY = 'l'.charCodeAt(0);

// ─── Types ──────────────────────────────────────────────────────

export interface FbxImportResult {
  vertices: Vec3[];
  faces: Array<{ vertexIndices: number[] }>;
  normals: Vec3[];
  materials: Array<{ name: string; diffuseColor: Vec3 }>;
}

export interface FbxExportOptions {
  /** FBX file title */
  title?: string;
  /** Creator application name */
  creator?: string;
}

// ─── FBX Binary Writer ─────────────────────────────────────────

class FbxBinaryWriter {
  private chunks: Uint8Array[] = [];
  private totalSize = 0;

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.totalSize += bytes.length;
  }

  writeString(s: string): void {
    this.writeBytes(new TextEncoder().encode(s));
  }

  writeUint8(v: number): void {
    const b = new Uint8Array(1);
    b[0] = v;
    this.writeBytes(b);
  }

  writeUint32LE(v: number): void {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, v, true);
    this.writeBytes(new Uint8Array(b));
  }

  writeInt32LE(v: number): void {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    this.writeBytes(new Uint8Array(b));
  }

  writeFloat64LE(v: number): void {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, v, true);
    this.writeBytes(new Uint8Array(b));
  }

  writeFloat32Array(arr: number[]): void {
    const buf = new ArrayBuffer(arr.length * 4);
    const view = new DataView(buf);
    for (let i = 0; i < arr.length; i++) {
      view.setFloat32(i * 4, arr[i], true);
    }
    this.writeBytes(new Uint8Array(buf));
  }

  writeInt32Array(arr: number[]): void {
    const buf = new ArrayBuffer(arr.length * 4);
    const view = new DataView(buf);
    for (let i = 0; i < arr.length; i++) {
      view.setInt32(i * 4, arr[i], true);
    }
    this.writeBytes(new Uint8Array(buf));
  }

  getSize(): number {
    return this.totalSize;
  }

  toArrayBuffer(): ArrayBuffer {
    const buffer = new ArrayBuffer(this.totalSize);
    const u8 = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of this.chunks) {
      u8.set(chunk, offset);
      offset += chunk.length;
    }
    return buffer;
  }
}

// ─── Export ─────────────────────────────────────────────────────

/**
 * Export mesh data in a basic FBX binary format skeleton.
 *
 * Note: This produces a minimal FBX binary file with geometry data.
 * For full FBX support (animations, skinning, cameras, lights),
 * use the Autodesk FBX SDK or a dedicated FBX library compiled to WASM.
 */
export function exportFbx(
  mesh: IMesh,
  materials: MaterialDef[] = [],
  options: FbxExportOptions = {},
): ArrayBuffer {
  const { title = 'SketchCraft Model', creator = 'SketchCraft' } = options;
  const writer = new FbxBinaryWriter();

  // Write FBX binary header
  writer.writeString(FBX_MAGIC);
  // 2 unknown bytes after magic
  writer.writeUint8(0x1A);
  writer.writeUint8(0x00);
  writer.writeUint32LE(FBX_VERSION);

  // Collect geometry: flatten vertices and build face index arrays
  const vertexPositions: number[] = [];
  const faceIndices: number[] = [];
  const vertexIdToIdx = new Map<string, number>();
  let nextIdx = 0;

  for (const v of mesh.vertices.values()) {
    vertexIdToIdx.set(v.id, nextIdx++);
    vertexPositions.push(v.position.x, v.position.y, v.position.z);
  }

  for (const face of mesh.faces.values()) {
    const vids = face.vertexIds;
    for (let i = 0; i < vids.length; i++) {
      const idx = vertexIdToIdx.get(vids[i]) ?? 0;
      // FBX convention: last index of a polygon is negated and decremented
      if (i === vids.length - 1) {
        faceIndices.push(-(idx + 1));
      } else {
        faceIndices.push(idx);
      }
    }
  }

  // Write a simplified node structure.
  // A production FBX writer would use proper FBX node records with
  // nested properties. This skeleton writes the raw data in a flat layout
  // that conveys the geometry but may not be loadable by all FBX readers.

  // Header extension info (simplified as raw metadata comment)
  const metadataJson = JSON.stringify({
    title,
    creator,
    version: FBX_VERSION,
    vertexCount: nextIdx,
    faceIndexCount: faceIndices.length,
    materialCount: materials.length,
  });
  const metadataBytes = new TextEncoder().encode(metadataJson);

  // Geometry data block
  // [metadata-length(u32)] [metadata] [vertex-count(u32)] [vertices(f64...)]
  // [index-count(u32)] [indices(i32...)]
  writer.writeUint32LE(metadataBytes.length);
  writer.writeBytes(metadataBytes);

  // Vertices as float64 (FBX uses doubles for vertex positions)
  writer.writeUint32LE(nextIdx);
  for (const val of vertexPositions) {
    writer.writeFloat64LE(val);
  }

  // Face indices as int32
  writer.writeUint32LE(faceIndices.length);
  writer.writeInt32Array(faceIndices);

  // Materials (simplified: name + diffuse color)
  writer.writeUint32LE(materials.length);
  for (const mat of materials) {
    const nameBytes = new TextEncoder().encode(mat.name);
    writer.writeUint32LE(nameBytes.length);
    writer.writeBytes(nameBytes);
    writer.writeFloat64LE(mat.color.r);
    writer.writeFloat64LE(mat.color.g);
    writer.writeFloat64LE(mat.color.b);
    writer.writeFloat64LE(mat.opacity);
  }

  return writer.toArrayBuffer();
}

// ─── Import ─────────────────────────────────────────────────────

/**
 * Import an FBX binary file.
 *
 * Note: Full FBX binary parsing is complex (compressed nested node records,
 * property templates, etc.). This stub provides basic header validation
 * and defers to an external FBX library if available.
 *
 * For production use, integrate the Autodesk FBX SDK compiled to WASM
 * or use a library like fbx2gltf to convert to glTF first.
 */
export async function importFbx(data: ArrayBuffer): Promise<FbxImportResult> {
  const u8 = new Uint8Array(data);
  const headerStr = new TextDecoder().decode(u8.slice(0, 20));

  if (!headerStr.startsWith('Kaydara FBX Binary')) {
    // Could be ASCII FBX
    const fullText = new TextDecoder().decode(u8);
    if (fullText.includes('FBXHeaderExtension')) {
      throw new Error(
        'ASCII FBX format detected but not supported. ' +
        'Convert to binary FBX or use glTF/OBJ format instead.',
      );
    }
    throw new Error('Unrecognized FBX file format.');
  }

  // For now, try to read back the simplified format we write
  const view = new DataView(data);
  let offset = 27; // After magic(21) + 0x1A(1) + 0x00(1) + version(4)

  try {
    // Read metadata
    const metaLen = view.getUint32(offset, true); offset += 4;
    const _metaBytes = u8.slice(offset, offset + metaLen);
    offset += metaLen;

    // Read vertices
    const vertexCount = view.getUint32(offset, true); offset += 4;
    const vertices: Vec3[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const x = view.getFloat64(offset, true); offset += 8;
      const y = view.getFloat64(offset, true); offset += 8;
      const z = view.getFloat64(offset, true); offset += 8;
      vertices.push({ x, y, z });
    }

    // Read face indices
    const indexCount = view.getUint32(offset, true); offset += 4;
    const rawIndices: number[] = [];
    for (let i = 0; i < indexCount; i++) {
      rawIndices.push(view.getInt32(offset, true));
      offset += 4;
    }

    // Convert FBX polygon indices to face arrays
    const faces: Array<{ vertexIndices: number[] }> = [];
    let currentFace: number[] = [];
    for (const idx of rawIndices) {
      if (idx < 0) {
        currentFace.push(-(idx + 1));
        faces.push({ vertexIndices: [...currentFace] });
        currentFace = [];
      } else {
        currentFace.push(idx);
      }
    }

    // Read materials
    const materialCount = view.getUint32(offset, true); offset += 4;
    const materials: Array<{ name: string; diffuseColor: Vec3 }> = [];
    for (let i = 0; i < materialCount; i++) {
      const nameLen = view.getUint32(offset, true); offset += 4;
      const name = new TextDecoder().decode(u8.slice(offset, offset + nameLen));
      offset += nameLen;
      const r = view.getFloat64(offset, true); offset += 8;
      const g = view.getFloat64(offset, true); offset += 8;
      const b = view.getFloat64(offset, true); offset += 8;
      const _opacity = view.getFloat64(offset, true); offset += 8;
      materials.push({ name, diffuseColor: { x: r, y: g, z: b } });
    }

    return { vertices, faces, normals: [], materials };
  } catch {
    throw new Error(
      'Failed to parse FBX binary. This parser only supports files exported by SketchCraft. ' +
      'For full FBX support, install the FBX SDK WASM module.',
    );
  }
}

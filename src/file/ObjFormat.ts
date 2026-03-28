// @archigraph file.obj-format
// Wavefront .obj import/export for SketchCraft

import { Vec3 } from '../core/types';
import { IVertex, IFace, IMesh } from '../core/interfaces';

// ─── Types ──────────────────────────────────────────────────────

export interface ObjExportOptions {
  /** Include normals in export */
  normals?: boolean;
  /** Include texture coordinates (if available) */
  texCoords?: boolean;
  /** Material library filename (e.g. "model.mtl") */
  mtlLib?: string;
  /** Flip winding order */
  flipWinding?: boolean;
  /** Scale factor applied to all vertices */
  scale?: number;
}

export interface ObjMaterial {
  name: string;
  diffuseColor?: Vec3;
  specularColor?: Vec3;
  ambientColor?: Vec3;
  opacity?: number;
  shininess?: number;
  diffuseMap?: string;
  normalMap?: string;
}

export interface ObjImportResult {
  vertices: Vec3[];
  normals: Vec3[];
  texCoords: Array<{ u: number; v: number }>;
  faces: Array<{
    vertexIndices: number[];
    normalIndices: number[];
    texCoordIndices: number[];
    materialName: string | null;
  }>;
  materialLibraries: string[];
  objectNames: string[];
  groupNames: string[];
}

// ─── Export ─────────────────────────────────────────────────────

export function exportObj(
  mesh: IMesh,
  materialNames?: Map<number, string>,
  options: ObjExportOptions = {},
): string {
  const {
    normals: includeNormals = true,
    mtlLib,
    flipWinding = false,
    scale = 1.0,
  } = options;

  const lines: string[] = [];
  lines.push('# Exported from SketchCraft');
  lines.push(`# Vertices: ${mesh.vertices.size}, Faces: ${mesh.faces.size}`);
  lines.push('');

  if (mtlLib) {
    lines.push(`mtllib ${mtlLib}`);
    lines.push('');
  }

  // Build vertex index map: vertex id -> 1-based index
  const vertexIndexMap = new Map<string, number>();
  let vIdx = 1;

  // Write vertices
  for (const vertex of mesh.vertices.values()) {
    vertexIndexMap.set(vertex.id, vIdx++);
    const p = vertex.position;
    lines.push(`v ${(p.x * scale).toFixed(6)} ${(p.y * scale).toFixed(6)} ${(p.z * scale).toFixed(6)}`);
  }
  lines.push('');

  // Write normals
  const normalIndexMap = new Map<string, number>();
  if (includeNormals) {
    let nIdx = 1;
    for (const face of mesh.faces.values()) {
      normalIndexMap.set(face.id, nIdx++);
      const n = face.normal;
      lines.push(`vn ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}`);
    }
    lines.push('');
  }

  // Group faces by material
  const facesByMaterial = new Map<number, IFace[]>();
  for (const face of mesh.faces.values()) {
    const mi = face.materialIndex;
    if (!facesByMaterial.has(mi)) {
      facesByMaterial.set(mi, []);
    }
    facesByMaterial.get(mi)!.push(face);
  }

  // Write faces grouped by material
  for (const [matIdx, faces] of facesByMaterial) {
    if (materialNames?.has(matIdx)) {
      lines.push(`usemtl ${materialNames.get(matIdx)}`);
    }

    for (const face of faces) {
      const vids = flipWinding ? [...face.vertexIds].reverse() : face.vertexIds;
      const nIdx = normalIndexMap.get(face.id);
      const faceTokens = vids.map(vid => {
        const vi = vertexIndexMap.get(vid);
        if (!vi) return '';
        if (includeNormals && nIdx !== undefined) {
          return `${vi}//${nIdx}`;
        }
        return `${vi}`;
      });
      lines.push(`f ${faceTokens.join(' ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── MTL Export ─────────────────────────────────────────────────

export function exportMtl(materials: ObjMaterial[]): string {
  const lines: string[] = [];
  lines.push('# Material Library exported from SketchCraft');
  lines.push('');

  for (const mat of materials) {
    lines.push(`newmtl ${mat.name}`);
    if (mat.ambientColor) {
      lines.push(`Ka ${mat.ambientColor.x.toFixed(4)} ${mat.ambientColor.y.toFixed(4)} ${mat.ambientColor.z.toFixed(4)}`);
    }
    if (mat.diffuseColor) {
      lines.push(`Kd ${mat.diffuseColor.x.toFixed(4)} ${mat.diffuseColor.y.toFixed(4)} ${mat.diffuseColor.z.toFixed(4)}`);
    }
    if (mat.specularColor) {
      lines.push(`Ks ${mat.specularColor.x.toFixed(4)} ${mat.specularColor.y.toFixed(4)} ${mat.specularColor.z.toFixed(4)}`);
    }
    if (mat.shininess !== undefined) {
      lines.push(`Ns ${mat.shininess.toFixed(4)}`);
    }
    if (mat.opacity !== undefined) {
      lines.push(`d ${mat.opacity.toFixed(4)}`);
    } else {
      lines.push('d 1.0000');
    }
    lines.push('illum 2');
    if (mat.diffuseMap) {
      lines.push(`map_Kd ${mat.diffuseMap}`);
    }
    if (mat.normalMap) {
      lines.push(`map_bump ${mat.normalMap}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Import ─────────────────────────────────────────────────────

export function importObj(text: string): ObjImportResult {
  const vertices: Vec3[] = [];
  const normals: Vec3[] = [];
  const texCoords: Array<{ u: number; v: number }> = [];
  const faces: ObjImportResult['faces'] = [];
  const materialLibraries: string[] = [];
  const objectNames: string[] = [];
  const groupNames: string[] = [];

  let currentMaterial: string | null = null;

  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0];

    switch (keyword) {
      case 'v': {
        vertices.push({
          x: parseFloat(parts[1]) || 0,
          y: parseFloat(parts[2]) || 0,
          z: parseFloat(parts[3]) || 0,
        });
        break;
      }

      case 'vn': {
        normals.push({
          x: parseFloat(parts[1]) || 0,
          y: parseFloat(parts[2]) || 0,
          z: parseFloat(parts[3]) || 0,
        });
        break;
      }

      case 'vt': {
        texCoords.push({
          u: parseFloat(parts[1]) || 0,
          v: parseFloat(parts[2]) || 0,
        });
        break;
      }

      case 'f': {
        const vertexIndices: number[] = [];
        const normalIndices: number[] = [];
        const texCoordIndices: number[] = [];

        for (let i = 1; i < parts.length; i++) {
          const segments = parts[i].split('/');
          // OBJ indices are 1-based; convert to 0-based
          const vi = parseInt(segments[0], 10);
          vertexIndices.push(vi > 0 ? vi - 1 : vertices.length + vi);

          if (segments.length > 1 && segments[1] !== '') {
            const ti = parseInt(segments[1], 10);
            texCoordIndices.push(ti > 0 ? ti - 1 : texCoords.length + ti);
          }

          if (segments.length > 2 && segments[2] !== '') {
            const ni = parseInt(segments[2], 10);
            normalIndices.push(ni > 0 ? ni - 1 : normals.length + ni);
          }
        }

        faces.push({
          vertexIndices,
          normalIndices,
          texCoordIndices,
          materialName: currentMaterial,
        });
        break;
      }

      case 'mtllib': {
        materialLibraries.push(parts.slice(1).join(' '));
        break;
      }

      case 'usemtl': {
        currentMaterial = parts.slice(1).join(' ');
        break;
      }

      case 'o': {
        objectNames.push(parts.slice(1).join(' '));
        break;
      }

      case 'g': {
        groupNames.push(parts.slice(1).join(' '));
        break;
      }

      // Ignore: s (smoothing groups), l (lines), etc.
      default:
        break;
    }
  }

  return {
    vertices,
    normals,
    texCoords,
    faces,
    materialLibraries,
    objectNames,
    groupNames,
  };
}

// ─── Parse MTL ──────────────────────────────────────────────────

export function parseMtl(text: string): ObjMaterial[] {
  const materials: ObjMaterial[] = [];
  let current: ObjMaterial | null = null;

  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0];

    switch (keyword) {
      case 'newmtl':
        if (current) materials.push(current);
        current = { name: parts.slice(1).join(' ') };
        break;

      case 'Ka':
        if (current) {
          current.ambientColor = {
            x: parseFloat(parts[1]) || 0,
            y: parseFloat(parts[2]) || 0,
            z: parseFloat(parts[3]) || 0,
          };
        }
        break;

      case 'Kd':
        if (current) {
          current.diffuseColor = {
            x: parseFloat(parts[1]) || 0,
            y: parseFloat(parts[2]) || 0,
            z: parseFloat(parts[3]) || 0,
          };
        }
        break;

      case 'Ks':
        if (current) {
          current.specularColor = {
            x: parseFloat(parts[1]) || 0,
            y: parseFloat(parts[2]) || 0,
            z: parseFloat(parts[3]) || 0,
          };
        }
        break;

      case 'Ns':
        if (current) current.shininess = parseFloat(parts[1]) || 0;
        break;

      case 'd':
        if (current) current.opacity = parseFloat(parts[1]) || 1;
        break;

      case 'Tr':
        if (current) current.opacity = 1 - (parseFloat(parts[1]) || 0);
        break;

      case 'map_Kd':
        if (current) current.diffuseMap = parts.slice(1).join(' ');
        break;

      case 'map_bump':
      case 'bump':
        if (current) current.normalMap = parts.slice(1).join(' ');
        break;

      default:
        break;
    }
  }

  if (current) materials.push(current);

  return materials;
}

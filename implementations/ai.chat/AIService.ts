// @archigraph ai.chat
// AI service — builds context, defines tools, and executes tool calls against ModelAPI

import type { IModelAPI, ShapeResult, FaceInfo, MeasureResult, EntityInfo } from '../api.model/ModelAPI';
import type { Vec3, Color, BoundingBox } from '../../src/core/types';

// ─── Message Types ───────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls the assistant made (for display) */
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: string }>;
}

// ─── Tool Definitions (Claude API format) ────────────────────────

export function getToolDefinitions() {
  return [
    {
      name: 'createBox',
      description: 'Create a box (rectangular prism) at the given origin with specified dimensions. Origin is the bottom-front-left corner. Y is up.',
      input_schema: {
        type: 'object' as const,
        properties: {
          origin: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          width: { type: 'number' as const, description: 'Size along X axis' },
          depth: { type: 'number' as const, description: 'Size along Z axis' },
          height: { type: 'number' as const, description: 'Size along Y axis' },
        },
        required: ['origin', 'width', 'depth', 'height'],
      },
    },
    {
      name: 'createCylinder',
      description: 'Create a cylinder at the given center (bottom face center) with specified radius and height. Y is up.',
      input_schema: {
        type: 'object' as const,
        properties: {
          center: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          radius: { type: 'number' as const },
          height: { type: 'number' as const },
          segments: { type: 'number' as const, description: 'Number of sides (default 24)' },
        },
        required: ['center', 'radius', 'height'],
      },
    },
    {
      name: 'createSphere',
      description: 'Create a UV sphere at the given center with specified radius.',
      input_schema: {
        type: 'object' as const,
        properties: {
          center: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          radius: { type: 'number' as const },
          rings: { type: 'number' as const, description: 'Vertical subdivisions (default 12)' },
          segments: { type: 'number' as const, description: 'Horizontal subdivisions (default 24)' },
        },
        required: ['center', 'radius'],
      },
    },
    {
      name: 'createPlane',
      description: 'Create a flat rectangular plane centered at origin with specified dimensions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          origin: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          width: { type: 'number' as const },
          depth: { type: 'number' as const },
          normal: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, description: 'Face normal direction (default: up/Y+)' },
        },
        required: ['origin', 'width', 'depth'],
      },
    },
    {
      name: 'createPolygon',
      description: 'Create a regular polygon (triangle, pentagon, hexagon, etc.) at center with given radius and number of sides.',
      input_schema: {
        type: 'object' as const,
        properties: {
          center: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          radius: { type: 'number' as const },
          sides: { type: 'number' as const },
          normal: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } } },
        },
        required: ['center', 'radius', 'sides'],
      },
    },
    {
      name: 'extrudeFace',
      description: 'Extrude (push/pull) a face along its normal by the given distance. Positive = outward, negative = inward.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const, description: 'The face ID to extrude' },
          distance: { type: 'number' as const, description: 'Distance to extrude (positive = outward along normal)' },
        },
        required: ['faceId', 'distance'],
      },
    },
    {
      name: 'moveEntities',
      description: 'Move entities (faces, edges, vertices) by an offset vector.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'IDs of entities to move' },
          offset: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
        },
        required: ['entityIds', 'offset'],
      },
    },
    {
      name: 'rotateEntities',
      description: 'Rotate entities around an axis by a given angle in degrees.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          axis: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Rotation axis (e.g. {x:0,y:1,z:0} for Y-axis)' },
          angleDeg: { type: 'number' as const, description: 'Rotation angle in degrees' },
          pivot: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, description: 'Pivot point (default: centroid of entities)' },
        },
        required: ['entityIds', 'axis', 'angleDeg'],
      },
    },
    {
      name: 'scaleEntities',
      description: 'Scale entities by a factor vector relative to a pivot point.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          factor: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Scale factor per axis (1 = no change)' },
          pivot: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, description: 'Pivot point (default: centroid)' },
        },
        required: ['entityIds', 'factor'],
      },
    },
    {
      name: 'copyEntities',
      description: 'Duplicate entities with an offset.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          offset: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
        },
        required: ['entityIds', 'offset'],
      },
    },
    {
      name: 'deleteEntities',
      description: 'Delete faces, edges, or vertices by their IDs.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['entityIds'],
      },
    },
    {
      name: 'setFaceColor',
      description: 'Set the color of one or more faces. RGB values are 0-1.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceIds: { oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'string' as const } }] },
          r: { type: 'number' as const, minimum: 0, maximum: 1 },
          g: { type: 'number' as const, minimum: 0, maximum: 1 },
          b: { type: 'number' as const, minimum: 0, maximum: 1 },
        },
        required: ['faceIds', 'r', 'g', 'b'],
      },
    },
    {
      name: 'setFaceMaterial',
      description: 'Apply an existing material to one or more faces by material ID.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceIds: { oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'string' as const } }] },
          materialId: { type: 'string' as const },
        },
        required: ['faceIds', 'materialId'],
      },
    },
    {
      name: 'getFaceInfo',
      description: 'Get information about a face: area, normal, vertices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const },
        },
        required: ['faceId'],
      },
    },
    {
      name: 'measureDistance',
      description: 'Measure the distance between two 3D points.',
      input_schema: {
        type: 'object' as const,
        properties: {
          a: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          b: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
        },
        required: ['a', 'b'],
      },
    },
    {
      name: 'getBoundingBox',
      description: 'Get the bounding box of specific entities, or the entire model if no IDs given.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Optional entity IDs (omit for whole model)' },
        },
      },
    },
    {
      name: 'select',
      description: 'Select entities by their IDs (replaces current selection).',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['entityIds'],
      },
    },
    {
      name: 'clearSelection',
      description: 'Clear the current selection.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'setView',
      description: 'Set the camera to a named view.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] },
        },
        required: ['name'],
      },
    },
    {
      name: 'zoomExtents',
      description: 'Zoom the camera to fit the entire model in view.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'listMaterials',
      description: 'List all available materials with their IDs, names, and colors.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'insetFace',
      description: 'Inset (offset) a face inward, creating a smaller inner face surrounded by ring faces. Useful for window frames, trim, panel details.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const },
          distance: { type: 'number' as const, description: 'Inset distance (how far toward face center)' },
        },
        required: ['faceId', 'distance'],
      },
    },
    {
      name: 'createWall',
      description: 'Create a 3D wall with thickness between two points. The wall stands vertically (Y up) with proper thickness.',
      input_schema: {
        type: 'object' as const,
        properties: {
          start: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          end: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          height: { type: 'number' as const },
          thickness: { type: 'number' as const },
        },
        required: ['start', 'end', 'height', 'thickness'],
      },
    },
    {
      name: 'cutOpening',
      description: 'Cut a rectangular opening (window/door hole) in a face. The opening is centered on the face with optional offset.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const, description: 'Face to cut the opening in (typically a wall face)' },
          width: { type: 'number' as const },
          height: { type: 'number' as const },
          offsetX: { type: 'number' as const, description: 'Horizontal offset from face center (default 0)' },
          offsetY: { type: 'number' as const, description: 'Vertical offset from face center (default 0)' },
        },
        required: ['faceId', 'width', 'height'],
      },
    },
    {
      name: 'arrayLinear',
      description: 'Create multiple copies of entities in a line with equal spacing. Great for repeating windows, columns, fence posts.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          direction: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Direction of the array' },
          count: { type: 'number' as const, description: 'Number of copies to create' },
          spacing: { type: 'number' as const, description: 'Distance between each copy' },
        },
        required: ['entityIds', 'direction', 'count', 'spacing'],
      },
    },
    {
      name: 'arrayRadial',
      description: 'Create copies of entities arranged in a circle around a center point. Great for columns around a rotunda, clock markings.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          center: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          axis: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Rotation axis (typically {x:0,y:1,z:0} for Y-up)' },
          count: { type: 'number' as const, description: 'Total number of instances (including original)' },
        },
        required: ['entityIds', 'center', 'axis', 'count'],
      },
    },
    {
      name: 'mirrorEntities',
      description: 'Create a mirrored copy of entities across a plane. Great for symmetric buildings.',
      input_schema: {
        type: 'object' as const,
        properties: {
          entityIds: { type: 'array' as const, items: { type: 'string' as const } },
          planePoint: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'A point on the mirror plane' },
          planeNormal: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Normal of the mirror plane (e.g. {x:1,y:0,z:0} for YZ plane)' },
        },
        required: ['entityIds', 'planePoint', 'planeNormal'],
      },
    },
    {
      name: 'createRoof',
      description: 'Create a gable roof on top of a face (typically the top face of a building). Automatically determines ridge direction from face shape.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const, description: 'The top face to build the roof on' },
          pitch: { type: 'number' as const, description: 'Roof pitch in degrees (30-45 typical)' },
          overhang: { type: 'number' as const, description: 'Eave overhang distance (default 0)' },
        },
        required: ['faceId', 'pitch'],
      },
    },
    {
      name: 'createStairs',
      description: 'Create a staircase from a starting point in a direction. Each step is a box with specified rise and tread.',
      input_schema: {
        type: 'object' as const,
        properties: {
          start: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          direction: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Horizontal direction the stairs go (will be normalized)' },
          riseHeight: { type: 'number' as const, description: 'Height of each step (0.18 typical)' },
          treadDepth: { type: 'number' as const, description: 'Depth of each step (0.28 typical)' },
          width: { type: 'number' as const, description: 'Width of the staircase (0.9-1.2 typical)' },
          numSteps: { type: 'number' as const },
        },
        required: ['start', 'direction', 'riseHeight', 'treadDepth', 'width', 'numSteps'],
      },
    },
    {
      name: 'createArch',
      description: 'Create a semicircular arch with thickness. Useful for doorways, windows, decorative elements.',
      input_schema: {
        type: 'object' as const,
        properties: {
          center: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'], description: 'Center of the arch base' },
          radius: { type: 'number' as const, description: 'Outer radius of the arch' },
          height: { type: 'number' as const, description: 'Thickness of the arch ring (radius - inner radius)' },
          thickness: { type: 'number' as const, description: 'Depth of the arch (how far it extends in Z)' },
          segments: { type: 'number' as const, description: 'Smoothness (default 12)' },
        },
        required: ['center', 'radius', 'height', 'thickness'],
      },
    },
    {
      name: 'batch',
      description: 'Execute multiple operations as a single undoable action. ALWAYS use this for multi-step builds (e.g. creating a building with walls + openings + roof).',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Name for the undo step' },
          operations: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                tool: { type: 'string' as const },
                input: { type: 'object' as const },
              },
              required: ['tool', 'input'],
            },
          },
        },
        required: ['name', 'operations'],
      },
    },
  ];
}

// ─── System Prompt ───────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return `You are an expert 3D architect embedded in SketchCraft, a 3D CAD application. You create detailed, professional-quality architectural models by composing operations methodically.

## Coordinate System
- Y is UP (vertical), X is right, Z is forward
- Units are in meters. Origin (0,0,0) is at ground level center.

## Your Role
- You operate ONLY on what the user has selected or explicitly describes
- When the user says "this face" or "the selected face", use the face IDs from the selection context
- Use the batch tool to group related operations into a single undo step
- Be concise — describe what you did, not how the tools work
- If you need more information, ask the user

## Modeling Approach — ALWAYS follow these steps for complex models:
1. **Plan first**: Break the model into logical parts (foundation, walls, openings, roof, details)
2. **Build bottom-up**: Foundation/floor -> walls -> openings -> roof -> details
3. **Use compound tools**: createWall, cutOpening, createRoof, createStairs — NOT manual vertex math
4. **Add detail progressively**: Basic form first, then insetFace for trim/frames, extrudeFace for depth
5. **Use arrays for repetition**: arrayLinear for windows/columns, arrayRadial for circular patterns
6. **Use mirror for symmetry**: Build one half, mirror for the other

## Standard Architectural Dimensions (meters)
- Exterior door: 0.9w x 2.1h, interior: 0.8w x 2.0h
- Window: 1.2w x 1.5h, sill height 0.9 from floor
- Ceiling height: 2.7 (residential), 3.0-4.0 (commercial)
- Wall thickness: 0.15 (interior), 0.25 (exterior)
- Stair rise: 0.18, tread depth: 0.28, width: 0.9-1.2
- Roof pitch: 30-45 degrees typical
- Column: 0.3-0.5 diameter
- Floor slab: 0.15-0.2 thick

## Techniques for Professional Results
- **Walls**: Use createWall(start, end, height, thickness) — gives proper 3D walls with thickness
- **Windows/Doors**: Use cutOpening on a wall face, then insetFace on the opening for a frame, then extrudeFace the frame inward for depth
- **Roof**: Use createRoof on the top face with appropriate pitch and overhang
- **Stairs**: Use createStairs with standard rise/tread dimensions
- **Moldings/Trim**: insetFace then extrudeFace the inset slightly for relief detail
- **Arches**: Use createArch for doorways and windows
- **Repetitive elements**: arrayLinear for evenly spaced windows, columns, balusters
- **Symmetry**: Build one side, mirrorEntities for the other

## Important
- Face/edge/vertex IDs are strings like "f0", "e0", "v0" or UUIDs
- RGB color values are 0-1 (not 0-255)
- Extrude distance: positive = outward along face normal, negative = inward
- Always use batch for multi-step operations so the user can undo with one Ctrl+Z`;
}

// ─── Selection Context Builder ───────────────────────────────────

export interface SelectionContext {
  selectedFaces: Array<{ id: string; area: number; normal: Vec3; vertexCount: number; vertices: Vec3[] }>;
  selectedEdges: string[];
  selectedVertices: string[];
  totalFaces: number;
  totalEdges: number;
  modelBounds: BoundingBox | null;
  materials: Array<{ id: string; name: string; color: Color }>;
}

export function buildSelectionContext(api: IModelAPI): SelectionContext {
  const selected = api.getSelectedEntities();

  const selectedFaces = selected.faces.map(id => {
    const info = api.getFaceInfo(id);
    return info || { id, area: 0, normal: { x: 0, y: 1, z: 0 }, vertexCount: 0, vertices: [] };
  });

  let modelBounds: BoundingBox | null = null;
  try {
    const allFaces = api.getAllFaces();
    if (allFaces.length > 0) {
      modelBounds = api.getBoundingBox();
    }
  } catch { /* empty model */ }

  return {
    selectedFaces,
    selectedEdges: selected.edges,
    selectedVertices: selected.vertices,
    totalFaces: api.getAllFaces().length,
    totalEdges: api.getAllEdges().length,
    modelBounds,
    materials: api.listMaterials(),
  };
}

export function contextToMessage(ctx: SelectionContext): string {
  const lines: string[] = ['## Current Selection'];

  if (ctx.selectedFaces.length === 0 && ctx.selectedEdges.length === 0 && ctx.selectedVertices.length === 0) {
    lines.push('Nothing is selected.');
  } else {
    if (ctx.selectedFaces.length > 0) {
      lines.push(`**${ctx.selectedFaces.length} face(s) selected:**`);
      for (const f of ctx.selectedFaces.slice(0, 20)) {
        const n = f.normal;
        lines.push(`- \`${f.id}\`: area=${f.area.toFixed(3)}m\u00B2, normal=(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}), ${f.vertexCount} vertices`);
        if (f.vertices.length > 0 && f.vertices.length <= 8) {
          const vStrs = f.vertices.map(v => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
          lines.push(`  vertices: ${vStrs.join(', ')}`);
        }
      }
      if (ctx.selectedFaces.length > 20) {
        lines.push(`  ... and ${ctx.selectedFaces.length - 20} more faces`);
      }
    }
    if (ctx.selectedEdges.length > 0) {
      lines.push(`**${ctx.selectedEdges.length} edge(s) selected:** ${ctx.selectedEdges.slice(0, 10).map(id => `\`${id}\``).join(', ')}${ctx.selectedEdges.length > 10 ? ' ...' : ''}`);
    }
    if (ctx.selectedVertices.length > 0) {
      lines.push(`**${ctx.selectedVertices.length} vertex/vertices selected:** ${ctx.selectedVertices.slice(0, 10).map(id => `\`${id}\``).join(', ')}${ctx.selectedVertices.length > 10 ? ' ...' : ''}`);
    }
  }

  lines.push('');
  lines.push(`## Model Overview`);
  lines.push(`Total: ${ctx.totalFaces} faces, ${ctx.totalEdges} edges`);
  if (ctx.modelBounds) {
    const b = ctx.modelBounds;
    const size = {
      x: (b.max.x - b.min.x).toFixed(2),
      y: (b.max.y - b.min.y).toFixed(2),
      z: (b.max.z - b.min.z).toFixed(2),
    };
    lines.push(`Bounds: (${b.min.x.toFixed(2)}, ${b.min.y.toFixed(2)}, ${b.min.z.toFixed(2)}) to (${b.max.x.toFixed(2)}, ${b.max.y.toFixed(2)}, ${b.max.z.toFixed(2)})`);
    lines.push(`Size: ${size.x} x ${size.y} x ${size.z} meters`);
  }

  if (ctx.materials.length > 0) {
    lines.push('');
    lines.push(`## Materials (${ctx.materials.length})`);
    for (const m of ctx.materials.slice(0, 10)) {
      lines.push(`- \`${m.id}\`: "${m.name}" rgb(${m.color.r.toFixed(2)}, ${m.color.g.toFixed(2)}, ${m.color.b.toFixed(2)})`);
    }
  }

  return lines.join('\n');
}

// ─── Tool Executor ───────────────────────────────────────────────

export function executeTool(api: IModelAPI, name: string, input: Record<string, unknown>): string {
  try {
    switch (name) {
      case 'createBox': {
        const r = api.createBox(input.origin as Vec3, input.width as number, input.depth as number, input.height as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, vertexIds: r.vertexIds.length });
      }
      case 'createCylinder': {
        const r = api.createCylinder(input.center as Vec3, input.radius as number, input.height as number, input.segments as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, vertexIds: r.vertexIds.length });
      }
      case 'createSphere': {
        const r = api.createSphere(input.center as Vec3, input.radius as number, input.rings as number, input.segments as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, vertexIds: r.vertexIds.length });
      }
      case 'createPlane': {
        const r = api.createPlane(input.origin as Vec3, input.width as number, input.depth as number, input.normal as Vec3 | undefined);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      case 'createPolygon': {
        const r = api.createPolygon(input.center as Vec3, input.radius as number, input.sides as number, input.normal as Vec3 | undefined);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      case 'extrudeFace': {
        const r = api.extrudeFace(input.faceId as string, input.distance as number);
        return JSON.stringify({ ok: true, newFaceIds: r.faceIds, newVertexIds: r.vertexIds.length });
      }
      case 'insetFace': {
        const r = api.insetFace(input.faceId as string, input.distance as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, innerFaceId: r.faceIds[r.faceIds.length - 1] });
      }
      case 'createWall': {
        const r = api.createWall(input.start as Vec3, input.end as Vec3, input.height as number, input.thickness as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, vertexCount: r.vertexIds.length });
      }
      case 'cutOpening': {
        const r = api.cutOpening(input.faceId as string, input.width as number, input.height as number, input.offsetX as number, input.offsetY as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, openingVertexIds: r.vertexIds });
      }
      case 'arrayLinear': {
        const r = api.arrayLinear(input.entityIds as string[], input.direction as Vec3, input.count as number, input.spacing as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, copies: input.count });
      }
      case 'arrayRadial': {
        const r = api.arrayRadial(input.entityIds as string[], input.center as Vec3, input.axis as Vec3, input.count as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, copies: (input.count as number) - 1 });
      }
      case 'mirrorEntities': {
        const r = api.mirrorEntities(input.entityIds as string[], input.planePoint as Vec3, input.planeNormal as Vec3);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, edgeIds: r.edgeIds });
      }
      case 'createRoof': {
        const r = api.createRoof(input.faceId as string, input.pitch as number, input.overhang as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      case 'createStairs': {
        const r = api.createStairs(input.start as Vec3, input.direction as Vec3, input.riseHeight as number, input.treadDepth as number, input.width as number, input.numSteps as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, steps: input.numSteps });
      }
      case 'createArch': {
        const r = api.createArch(input.center as Vec3, input.radius as number, input.height as number, input.thickness as number, input.segments as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length });
      }
      case 'moveEntities': {
        api.moveEntities(input.entityIds as string[], input.offset as Vec3);
        return JSON.stringify({ ok: true });
      }
      case 'rotateEntities': {
        api.rotateEntities(input.entityIds as string[], input.axis as Vec3, input.angleDeg as number, input.pivot as Vec3 | undefined);
        return JSON.stringify({ ok: true });
      }
      case 'scaleEntities': {
        api.scaleEntities(input.entityIds as string[], input.factor as Vec3, input.pivot as Vec3 | undefined);
        return JSON.stringify({ ok: true });
      }
      case 'copyEntities': {
        const r = api.copyEntities(input.entityIds as string[], input.offset as Vec3);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, edgeIds: r.edgeIds });
      }
      case 'deleteEntities': {
        api.deleteEntities(input.entityIds as string[]);
        return JSON.stringify({ ok: true });
      }
      case 'setFaceColor': {
        const matId = api.setFaceColor(input.faceIds as string | string[], input.r as number, input.g as number, input.b as number);
        return JSON.stringify({ ok: true, materialId: matId });
      }
      case 'setFaceMaterial': {
        api.setFaceMaterial(input.faceIds as string | string[], input.materialId as string);
        return JSON.stringify({ ok: true });
      }
      case 'getFaceInfo': {
        const info = api.getFaceInfo(input.faceId as string);
        return JSON.stringify(info || { error: 'Face not found' });
      }
      case 'measureDistance': {
        const r = api.measureDistance(input.a as Vec3, input.b as Vec3);
        return JSON.stringify(r);
      }
      case 'getBoundingBox': {
        const r = api.getBoundingBox(input.entityIds as string[] | undefined);
        return JSON.stringify(r);
      }
      case 'select': {
        api.select(input.entityIds as string[]);
        return JSON.stringify({ ok: true });
      }
      case 'clearSelection': {
        api.clearSelection();
        return JSON.stringify({ ok: true });
      }
      case 'setView': {
        api.setView(input.name as 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso');
        return JSON.stringify({ ok: true });
      }
      case 'zoomExtents': {
        api.zoomExtents();
        return JSON.stringify({ ok: true });
      }
      case 'listMaterials': {
        return JSON.stringify(api.listMaterials());
      }
      case 'batch': {
        const ops = input.operations as Array<{ tool: string; input: Record<string, unknown> }>;
        api.batch(input.name as string, (batchApi) => {
          for (const op of ops) {
            executeTool(batchApi, op.tool, op.input);
          }
        });
        return JSON.stringify({ ok: true, operationCount: ops.length });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

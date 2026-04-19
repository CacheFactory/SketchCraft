// @archigraph ai.chat
// AI service — builds context, defines tools, and executes tool calls against ModelAPI

import type { IModelAPI, ShapeResult, FaceInfo, EdgeInfo, MeasureResult, EntityInfo } from '../api.model/ModelAPI';
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
    // ── Edge Operations ──
    {
      name: 'chamferEdge',
      description: 'Chamfer (bevel) a sharp edge, replacing it with a flat angled cut. The edge must have exactly 2 adjacent faces.',
      input_schema: {
        type: 'object' as const,
        properties: {
          edgeId: { type: 'string' as const, description: 'Edge to chamfer' },
          distance: { type: 'number' as const, description: 'Chamfer distance from the edge' },
        },
        required: ['edgeId', 'distance'],
      },
    },
    {
      name: 'filletEdge',
      description: 'Fillet (round) a sharp edge with a smooth arc of faces. The edge must have exactly 2 adjacent faces.',
      input_schema: {
        type: 'object' as const,
        properties: {
          edgeId: { type: 'string' as const, description: 'Edge to fillet' },
          radius: { type: 'number' as const, description: 'Fillet radius' },
          segments: { type: 'number' as const, description: 'Arc smoothness (default 8)' },
        },
        required: ['edgeId', 'radius'],
      },
    },
    // ── Face Operations ──
    {
      name: 'offsetFace',
      description: 'Offset a face boundary inward or outward within its plane, creating connecting ring faces. Positive = inset, negative = outset. More precise than insetFace.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const },
          distance: { type: 'number' as const, description: 'Offset distance (positive = inset, negative = outset)' },
        },
        required: ['faceId', 'distance'],
      },
    },
    {
      name: 'subdivideFaces',
      description: 'Subdivide faces into smaller sub-faces for mesh refinement or smooth surfaces.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Faces to subdivide (empty = all)' },
          method: { type: 'string' as const, enum: ['midpoint', 'catmull-clark'], description: 'Subdivision method (default: midpoint)' },
          iterations: { type: 'number' as const, description: 'Number of subdivision passes (default: 1)' },
        },
        required: ['faceIds'],
      },
    },
    {
      name: 'triangulateFaces',
      description: 'Convert polygon faces into triangles. Useful for export or rendering.',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Faces to triangulate (empty = all non-triangles)' },
        },
        required: ['faceIds'],
      },
    },
    // ── Sweep ──
    {
      name: 'sweep',
      description: 'Sweep a profile face along a path of connected edges (follow-me). Creates a 3D solid by extruding the profile along the path. Great for moldings, railings, gutters, and complex curved forms.',
      input_schema: {
        type: 'object' as const,
        properties: {
          profileFaceId: { type: 'string' as const, description: 'The face to use as the sweep profile' },
          pathEdgeIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Ordered edge IDs forming the sweep path' },
          alignToPath: { type: 'boolean' as const, description: 'Rotate profile to follow path curvature (default: true)' },
        },
        required: ['profileFaceId', 'pathEdgeIds'],
      },
    },
    // ── Boolean CSG ──
    {
      name: 'booleanUnion',
      description: 'CSG Union: merge two sets of faces into one solid, removing internal geometry. Both regions must be closed solids.',
      input_schema: {
        type: 'object' as const,
        properties: {
          regionAIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the first solid' },
          regionBIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the second solid' },
        },
        required: ['regionAIds', 'regionBIds'],
      },
    },
    {
      name: 'booleanSubtract',
      description: 'CSG Subtract: cut the volume of solid B out of solid A. Use for carving holes, niches, or complex cutouts.',
      input_schema: {
        type: 'object' as const,
        properties: {
          regionAIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the solid to subtract FROM' },
          regionBIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the solid to subtract' },
        },
        required: ['regionAIds', 'regionBIds'],
      },
    },
    {
      name: 'booleanIntersect',
      description: 'CSG Intersect: keep only the overlapping volume of two solids.',
      input_schema: {
        type: 'object' as const,
        properties: {
          regionAIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the first solid' },
          regionBIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Face IDs of the second solid' },
        },
        required: ['regionAIds', 'regionBIds'],
      },
    },
    // ── Advanced Queries ──
    {
      name: 'getEdgeInfo',
      description: 'Get information about an edge: length, start/end vertex positions, midpoint, and adjacent face IDs.',
      input_schema: {
        type: 'object' as const,
        properties: {
          edgeId: { type: 'string' as const },
        },
        required: ['edgeId'],
      },
    },
    {
      name: 'getConnectedFaces',
      description: 'Get all faces that share an edge with the given face (adjacent/neighboring faces).',
      input_schema: {
        type: 'object' as const,
        properties: {
          faceId: { type: 'string' as const },
        },
        required: ['faceId'],
      },
    },
    {
      name: 'getEdgeFaces',
      description: 'Get the faces adjacent to an edge (0, 1, or 2 faces).',
      input_schema: {
        type: 'object' as const,
        properties: {
          edgeId: { type: 'string' as const },
        },
        required: ['edgeId'],
      },
    },
    // ── Section Plane ──
    {
      name: 'setSectionPlane',
      description: 'Set a section cutting plane to see inside the model. The plane is defined by a point and a normal direction.',
      input_schema: {
        type: 'object' as const,
        properties: {
          point: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
          normal: { type: 'object' as const, properties: { x: { type: 'number' as const }, y: { type: 'number' as const }, z: { type: 'number' as const } }, required: ['x', 'y', 'z'] },
        },
        required: ['point', 'normal'],
      },
    },
    {
      name: 'clearSectionPlane',
      description: 'Remove the section cutting plane to show the full model.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    // ── Groups ──
    {
      name: 'createGroup',
      description: 'Group entities together into a named group for organization. Groups can be entered/exited for editing.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Display name for the group' },
          entityIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Entity IDs to include in the group' },
        },
        required: ['name', 'entityIds'],
      },
    },
    // ── Materials (extended) ──
    {
      name: 'createMaterial',
      description: 'Create a named material with color and PBR properties (opacity, roughness, metalness).',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          color: { type: 'object' as const, properties: { r: { type: 'number' as const }, g: { type: 'number' as const }, b: { type: 'number' as const } }, required: ['r', 'g', 'b'] },
          opacity: { type: 'number' as const, description: '0-1, default 1' },
          roughness: { type: 'number' as const, description: '0-1, default 0.5' },
          metalness: { type: 'number' as const, description: '0-1, default 0' },
        },
        required: ['name', 'color'],
      },
    },
    // ── Selection (extended) ──
    {
      name: 'selectAll',
      description: 'Select all entities in the model.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'getSelectedEntities',
      description: 'Get the currently selected entity IDs, categorized by type (faces, edges, vertices).',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'getAllFaces',
      description: 'Get all face IDs in the model.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'getAllEdges',
      description: 'Get all edge IDs in the model.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'getVertexPosition',
      description: 'Get the 3D position of a vertex by its ID.',
      input_schema: {
        type: 'object' as const,
        properties: {
          vertexId: { type: 'string' as const },
        },
        required: ['vertexId'],
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
  return `You are an expert 3D architect embedded in DraftDown, a 3D CAD application. You create detailed, professional-quality architectural models by composing operations methodically.

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
- **Moldings/Trim**: Create a profile face, then sweep it along edges for crown molding, baseboards, railings
- **Edge Detail**: chamferEdge for beveled edges, filletEdge for rounded edges — adds realism
- **Arches**: Use createArch for doorways and windows
- **Repetitive elements**: arrayLinear for evenly spaced windows, columns, balusters
- **Symmetry**: Build one side, mirrorEntities for the other
- **Boolean operations**: booleanSubtract to carve holes, booleanUnion to merge solids, booleanIntersect for overlap
- **Sweep/Follow-me**: sweep a profile face along a path for gutters, cornices, complex profiles
- **Section planes**: setSectionPlane to cut through the model for visualization
- **Mesh refinement**: subdivideFaces for smoother surfaces, triangulateFaces for export

## Important
- Face/edge/vertex IDs are strings like "f0", "e0", "v0" or UUIDs
- RGB color values are 0-1 (not 0-255)
- Extrude distance: positive = outward along face normal, negative = inward
- Always use batch for multi-step operations so the user can undo with one Ctrl+Z
- Use getEdgeInfo and getConnectedFaces to explore model topology before operations
- Use createMaterial for PBR materials (glass, metal, wood) with opacity/roughness/metalness
- Use createGroup to organize parts of your model (walls, roof, furniture, etc.)`;
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

export async function executeTool(api: IModelAPI, name: string, input: Record<string, unknown>): Promise<string> {
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
      // ── Edge Operations ──
      case 'chamferEdge': {
        const r = api.chamferEdge(input.edgeId as string, input.distance as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, edgeIds: r.edgeIds, vertexIds: r.vertexIds });
      }
      case 'filletEdge': {
        const r = api.filletEdge(input.edgeId as string, input.radius as number, input.segments as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, edgeIds: r.edgeIds, vertexIds: r.vertexIds });
      }
      // ── Face Operations ──
      case 'offsetFace': {
        const r = api.offsetFace(input.faceId as string, input.distance as number);
        return JSON.stringify({ ok: true, faceIds: r.faceIds, edgeIds: r.edgeIds, vertexIds: r.vertexIds });
      }
      case 'subdivideFaces': {
        const r = api.subdivideFaces(
          input.faceIds as string[],
          input.method as 'midpoint' | 'catmull-clark' | undefined,
          input.iterations as number | undefined,
        );
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, newFaces: r.faceIds });
      }
      case 'triangulateFaces': {
        const r = api.triangulateFaces(input.faceIds as string[]);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length });
      }
      // ── Sweep ──
      case 'sweep': {
        const r = api.sweep(input.profileFaceId as string, input.pathEdgeIds as string[], input.alignToPath as boolean);
        return JSON.stringify({ ok: true, faceIds: r.faceIds.length, edgeIds: r.edgeIds.length });
      }
      // ── Boolean CSG ──
      case 'booleanUnion': {
        const r = await api.booleanUnion(input.regionAIds as string[], input.regionBIds as string[]);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      case 'booleanSubtract': {
        const r = await api.booleanSubtract(input.regionAIds as string[], input.regionBIds as string[]);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      case 'booleanIntersect': {
        const r = await api.booleanIntersect(input.regionAIds as string[], input.regionBIds as string[]);
        return JSON.stringify({ ok: true, faceIds: r.faceIds });
      }
      // ── Advanced Queries ──
      case 'getEdgeInfo': {
        const info = api.getEdgeInfo(input.edgeId as string);
        return JSON.stringify(info || { error: 'Edge not found' });
      }
      case 'getConnectedFaces': {
        const ids = api.getConnectedFaces(input.faceId as string);
        return JSON.stringify({ faceIds: ids });
      }
      case 'getEdgeFaces': {
        const ids = api.getEdgeFaces(input.edgeId as string);
        return JSON.stringify({ faceIds: ids });
      }
      // ── Section Plane ──
      case 'setSectionPlane': {
        api.setSectionPlane(input.point as Vec3, input.normal as Vec3);
        return JSON.stringify({ ok: true });
      }
      case 'clearSectionPlane': {
        api.clearSectionPlane();
        return JSON.stringify({ ok: true });
      }
      // ── Groups ──
      case 'createGroup': {
        const id = api.createGroup(input.name as string, input.entityIds as string[]);
        return JSON.stringify({ ok: true, groupId: id });
      }
      // ── Materials (extended) ──
      case 'createMaterial': {
        const c = input.color as { r: number; g: number; b: number };
        const id = api.createMaterial(input.name as string, c, {
          opacity: input.opacity as number,
          roughness: input.roughness as number,
          metalness: input.metalness as number,
        });
        return JSON.stringify({ ok: true, materialId: id });
      }
      // ── Selection/Query (extended) ──
      case 'selectAll': {
        api.selectAll();
        return JSON.stringify({ ok: true });
      }
      case 'getSelectedEntities': {
        return JSON.stringify(api.getSelectedEntities());
      }
      case 'getAllFaces': {
        return JSON.stringify({ faceIds: api.getAllFaces() });
      }
      case 'getAllEdges': {
        return JSON.stringify({ edgeIds: api.getAllEdges() });
      }
      case 'getVertexPosition': {
        const pos = api.getVertexPosition(input.vertexId as string);
        return JSON.stringify(pos || { error: 'Vertex not found' });
      }
      case 'batch': {
        const ops = input.operations as Array<{ tool: string; input: Record<string, unknown> }>;
        api.batch(input.name as string, (batchApi) => {
          for (const op of ops) {
            // Batch operations are sync-only; boolean CSG ops should not be
            // used inside batch (they are async). Non-async tools resolve
            // immediately so the returned promise is already fulfilled.
            void executeTool(batchApi, op.tool, op.input);
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

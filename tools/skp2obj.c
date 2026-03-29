// skp2obj — Converts SketchUp .skp to Wavefront OBJ using the SketchUp C API.
// Uses original face polygons (no triangulation) to preserve quads/rectangles.
// Usage: skp2obj input.skp output.obj

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ─── Minimal SketchUp C API type declarations ───────────────────

typedef int SUResult;
#define SU_ERROR_NONE 0

typedef struct { void *ptr; } SURef;
typedef SURef SUModelRef;
typedef SURef SUEntitiesRef;
typedef SURef SUFaceRef;
typedef SURef SUEdgeRef;
typedef SURef SUVertexRef;
typedef SURef SUGroupRef;
typedef SURef SUComponentInstanceRef;
typedef SURef SUComponentDefinitionRef;
typedef SURef SULoopRef;

#define SU_INVALID (SURef){NULL}
#define SUIsInvalid(ref) ((ref).ptr == NULL)

typedef struct { double x, y, z; } SUPoint3D;
typedef struct { double values[16]; } SUTransformation;

// ─── API function declarations ──────────────────────────────────

extern void SUInitialize(void);
extern void SUTerminate(void);

extern SUResult SUModelCreateFromFile(SUModelRef *model, const char *path);
extern SUResult SUModelRelease(SUModelRef *model);
extern SUResult SUModelGetEntities(SUModelRef model, SUEntitiesRef *entities);

extern SUResult SUEntitiesGetNumFaces(SUEntitiesRef entities, size_t *count);
extern SUResult SUEntitiesGetFaces(SUEntitiesRef entities, size_t len, SUFaceRef *faces, size_t *count);
extern SUResult SUEntitiesGetNumEdges(SUEntitiesRef entities, int standalone_only, size_t *count);
extern SUResult SUEntitiesGetEdges(SUEntitiesRef entities, int standalone_only, size_t len, SUEdgeRef *edges, size_t *count);
extern SUResult SUEntitiesGetNumGroups(SUEntitiesRef entities, size_t *count);
extern SUResult SUEntitiesGetGroups(SUEntitiesRef entities, size_t len, SUGroupRef *groups, size_t *count);
extern SUResult SUEntitiesGetNumInstances(SUEntitiesRef entities, size_t *count);
extern SUResult SUEntitiesGetInstances(SUEntitiesRef entities, size_t len, SUComponentInstanceRef *instances, size_t *count);

extern SUResult SUFaceGetNumVertices(SUFaceRef face, size_t *count);
extern SUResult SUFaceGetVertices(SUFaceRef face, size_t len, SUVertexRef *vertices, size_t *count);
extern SUResult SUFaceGetOuterLoop(SUFaceRef face, SULoopRef *loop);
extern SUResult SUFaceGetNumInnerLoops(SUFaceRef face, size_t *count);
extern SUResult SUFaceGetInnerLoops(SUFaceRef face, size_t len, SULoopRef *loops, size_t *count);

extern SUResult SULoopGetNumVertices(SULoopRef loop, size_t *count);
extern SUResult SULoopGetVertices(SULoopRef loop, size_t len, SUVertexRef *vertices, size_t *count);

extern SUResult SUVertexGetPosition(SUVertexRef vertex, SUPoint3D *position);

extern SUResult SUEdgeGetStartVertex(SUEdgeRef edge, SUVertexRef *vertex);
extern SUResult SUEdgeGetEndVertex(SUEdgeRef edge, SUVertexRef *vertex);

extern SUResult SUGroupGetEntities(SUGroupRef group, SUEntitiesRef *entities);
extern SUComponentInstanceRef SUGroupToComponentInstance(SUGroupRef group);

extern SUResult SUComponentInstanceGetTransform(SUComponentInstanceRef instance, SUTransformation *transform);
extern SUResult SUComponentInstanceGetDefinition(SUComponentInstanceRef instance, SUComponentDefinitionRef *def);
extern SUResult SUComponentDefinitionGetEntities(SUComponentDefinitionRef def, SUEntitiesRef *entities);

// ─── Globals ────────────────────────────────────────────────────

static int g_vertex_offset = 1; // OBJ is 1-based

// ─── Transform helpers ──────────────────────────────────────────

static void apply_transform(SUPoint3D *pt, SUTransformation *t) {
    if (!t) return;
    double x = pt->x, y = pt->y, z = pt->z;
    pt->x = t->values[0]*x + t->values[4]*y + t->values[8]*z  + t->values[12];
    pt->y = t->values[1]*x + t->values[5]*y + t->values[9]*z  + t->values[13];
    pt->z = t->values[2]*x + t->values[6]*y + t->values[10]*z + t->values[14];
}

static void multiply_transforms(SUTransformation *out, SUTransformation *a, SUTransformation *b) {
    for (int r = 0; r < 4; r++) {
        for (int c = 0; c < 4; c++) {
            out->values[c*4+r] = 0;
            for (int k = 0; k < 4; k++) {
                out->values[c*4+r] += a->values[k*4+r] * b->values[c*4+k];
            }
        }
    }
}

// ─── Write a single face using original polygon vertices ────────

static void write_face(FILE *out, SUFaceRef face, SUTransformation *transform) {
    // Get the outer loop (preserves original polygon, no triangulation)
    SULoopRef loop = SU_INVALID;
    if (SUFaceGetOuterLoop(face, &loop) != SU_ERROR_NONE) return;

    size_t num_verts = 0;
    SULoopGetNumVertices(loop, &num_verts);
    if (num_verts < 3) return;

    SUVertexRef *vertices = (SUVertexRef *)malloc(num_verts * sizeof(SUVertexRef));
    SULoopGetVertices(loop, num_verts, vertices, &num_verts);

    // Write vertex positions
    for (size_t i = 0; i < num_verts; i++) {
        SUPoint3D pt;
        SUVertexGetPosition(vertices[i], &pt);
        apply_transform(&pt, transform);
        // Convert inches to meters
        fprintf(out, "v %.6f %.6f %.6f\n",
                pt.x * 0.0254, pt.y * 0.0254, pt.z * 0.0254);
    }

    // Write face (single polygon)
    fprintf(out, "f");
    for (size_t i = 0; i < num_verts; i++) {
        fprintf(out, " %d", (int)(g_vertex_offset + i));
    }
    fprintf(out, "\n");

    g_vertex_offset += (int)num_verts;
    free(vertices);

    // Handle inner loops (holes) — write as separate faces if present
    size_t num_inner = 0;
    SUFaceGetNumInnerLoops(face, &num_inner);
    if (num_inner > 0) {
        SULoopRef *inner_loops = (SULoopRef *)malloc(num_inner * sizeof(SULoopRef));
        SUFaceGetInnerLoops(face, num_inner, inner_loops, &num_inner);
        for (size_t li = 0; li < num_inner; li++) {
            size_t nv = 0;
            SULoopGetNumVertices(inner_loops[li], &nv);
            if (nv < 3) continue;

            SUVertexRef *iverts = (SUVertexRef *)malloc(nv * sizeof(SUVertexRef));
            SULoopGetVertices(inner_loops[li], nv, iverts, &nv);

            for (size_t i = 0; i < nv; i++) {
                SUPoint3D pt;
                SUVertexGetPosition(iverts[i], &pt);
                apply_transform(&pt, transform);
                fprintf(out, "v %.6f %.6f %.6f\n",
                        pt.x * 0.0254, pt.y * 0.0254, pt.z * 0.0254);
            }
            // Write as line loop (l) since holes aren't faces
            fprintf(out, "l");
            for (size_t i = 0; i < nv; i++) {
                fprintf(out, " %d", (int)(g_vertex_offset + i));
            }
            fprintf(out, " %d\n", g_vertex_offset); // close the loop
            g_vertex_offset += (int)nv;

            free(iverts);
        }
        free(inner_loops);
    }
}

// ─── Write all entities recursively ─────────────────────────────

static void write_entities(FILE *out, SUEntitiesRef entities, SUTransformation *parent_transform) {
    // Faces
    size_t num_faces = 0;
    SUEntitiesGetNumFaces(entities, &num_faces);
    if (num_faces > 0) {
        SUFaceRef *faces = (SUFaceRef *)malloc(num_faces * sizeof(SUFaceRef));
        SUEntitiesGetFaces(entities, num_faces, faces, &num_faces);
        for (size_t i = 0; i < num_faces; i++) {
            write_face(out, faces[i], parent_transform);
        }
        free(faces);
    }

    // Standalone edges (not part of faces)
    size_t num_edges = 0;
    SUEntitiesGetNumEdges(entities, 1, &num_edges);
    if (num_edges > 0) {
        SUEdgeRef *edges = (SUEdgeRef *)malloc(num_edges * sizeof(SUEdgeRef));
        SUEntitiesGetEdges(entities, 1, num_edges, edges, &num_edges);
        for (size_t i = 0; i < num_edges; i++) {
            SUVertexRef sv = SU_INVALID, ev = SU_INVALID;
            SUEdgeGetStartVertex(edges[i], &sv);
            SUEdgeGetEndVertex(edges[i], &ev);
            SUPoint3D p1, p2;
            SUVertexGetPosition(sv, &p1);
            SUVertexGetPosition(ev, &p2);
            apply_transform(&p1, parent_transform);
            apply_transform(&p2, parent_transform);
            fprintf(out, "v %.6f %.6f %.6f\n", p1.x*0.0254, p1.y*0.0254, p1.z*0.0254);
            fprintf(out, "v %.6f %.6f %.6f\n", p2.x*0.0254, p2.y*0.0254, p2.z*0.0254);
            fprintf(out, "l %d %d\n", g_vertex_offset, g_vertex_offset+1);
            g_vertex_offset += 2;
        }
        free(edges);
    }

    // Groups
    size_t num_groups = 0;
    SUEntitiesGetNumGroups(entities, &num_groups);
    if (num_groups > 0) {
        SUGroupRef *groups = (SUGroupRef *)malloc(num_groups * sizeof(SUGroupRef));
        SUEntitiesGetGroups(entities, num_groups, groups, &num_groups);
        for (size_t i = 0; i < num_groups; i++) {
            SUTransformation local;
            SUComponentInstanceRef inst = SUGroupToComponentInstance(groups[i]);
            SUComponentInstanceGetTransform(inst, &local);

            SUTransformation combined;
            if (parent_transform) {
                multiply_transforms(&combined, parent_transform, &local);
            } else {
                combined = local;
            }

            SUEntitiesRef grp_ents = SU_INVALID;
            SUGroupGetEntities(groups[i], &grp_ents);
            write_entities(out, grp_ents, &combined);
        }
        free(groups);
    }

    // Component instances
    size_t num_instances = 0;
    SUEntitiesGetNumInstances(entities, &num_instances);
    if (num_instances > 0) {
        SUComponentInstanceRef *instances = (SUComponentInstanceRef *)malloc(
            num_instances * sizeof(SUComponentInstanceRef));
        SUEntitiesGetInstances(entities, num_instances, instances, &num_instances);
        for (size_t i = 0; i < num_instances; i++) {
            SUTransformation local;
            SUComponentInstanceGetTransform(instances[i], &local);

            SUTransformation combined;
            if (parent_transform) {
                multiply_transforms(&combined, parent_transform, &local);
            } else {
                combined = local;
            }

            SUComponentDefinitionRef def = SU_INVALID;
            SUComponentInstanceGetDefinition(instances[i], &def);
            SUEntitiesRef def_ents = SU_INVALID;
            SUComponentDefinitionGetEntities(def, &def_ents);
            write_entities(out, def_ents, &combined);
        }
        free(instances);
    }
}

// ─── Main ───────────────────────────────────────────────────────

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: skp2obj input.skp output.obj\n");
        return 1;
    }

    SUInitialize();

    SUModelRef model = SU_INVALID;
    FILE *out = NULL;
    int ret = 0;

    SUResult res = SUModelCreateFromFile(&model, argv[1]);
    if (res != SU_ERROR_NONE) {
        fprintf(stderr, "Failed to open SKP file (error %d): %s\n", res, argv[1]);
        ret = 1;
        goto done;
    }

    out = fopen(argv[2], "w");
    if (!out) {
        fprintf(stderr, "Cannot create output file: %s\n", argv[2]);
        ret = 1;
        goto done;
    }

    fprintf(out, "# Converted from SketchUp by skp2obj\n");

    SUEntitiesRef entities = SU_INVALID;
    SUModelGetEntities(model, &entities);
    write_entities(out, entities, NULL);

    fprintf(stderr, "OK: %d vertices written to %s\n", g_vertex_offset - 1, argv[2]);

done:
    if (out) fclose(out);
    if (!SUIsInvalid(model)) SUModelRelease(&model);
    SUTerminate();
    return ret;
}

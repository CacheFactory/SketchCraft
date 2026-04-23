// skp2obj — Converts SketchUp .skp to Wavefront OBJ+MTL using the SketchUp C API.
// Exports geometry with materials (colors + textures) and UV coordinates.
// Usage: skp2obj input.skp output.obj

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libgen.h>
#include <sys/stat.h>

// ─── Minimal SketchUp C API type declarations ────────────���──────

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
typedef SURef SUMaterialRef;
typedef SURef SUTextureRef;
typedef SURef SUStringRef;
typedef SURef SUUVHelperRef;
typedef SURef SUTextureWriterRef;
typedef SURef SUModelRef;

#define SU_INVALID (SURef){NULL}
#define SUIsInvalid(ref) ((ref).ptr == NULL)

typedef unsigned char SUByte;
typedef struct { SUByte red, green, blue, alpha; } SUColor;
typedef struct { double x, y, z; } SUPoint3D;
typedef struct { double values[16]; } SUTransformation;
typedef struct { double x, y, z, w; } SUUVQ;

// ─── API function declarations ──────────────────────────────────

extern void SUInitialize(void);
extern void SUTerminate(void);

extern SUResult SUModelCreateFromFile(SUModelRef *model, const char *path);
extern SUResult SUModelRelease(SUModelRef *model);
extern SUResult SUModelGetEntities(SUModelRef model, SUEntitiesRef *entities);
extern SUResult SUModelGetNumMaterials(SUModelRef model, size_t *count);
extern SUResult SUModelGetMaterials(SUModelRef model, size_t len, SUMaterialRef *mats, size_t *count);

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
extern SUResult SUFaceGetFrontMaterial(SUFaceRef face, SUMaterialRef *material);
extern SUResult SUFaceGetUVHelper(SUFaceRef face, int front, int back, SUTextureWriterRef tw, SUUVHelperRef *uvh);

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

extern SUResult SUMaterialGetName(SUMaterialRef material, SUStringRef *name);
extern SUResult SUMaterialGetColor(SUMaterialRef material, SUColor *color);
extern SUResult SUMaterialGetTexture(SUMaterialRef material, SUTextureRef *texture);
extern SUResult SUMaterialGetColorizeType(SUMaterialRef material, int *type);

extern SUResult SUTextureGetFileName(SUTextureRef texture, SUStringRef *file_name);
extern SUResult SUTextureWriteToFile(SUTextureRef texture, const char *file_path);

extern SUResult SUStringCreate(SUStringRef *out_string_ref);
extern SUResult SUStringRelease(SUStringRef *string_ref);
extern SUResult SUStringGetUTF8Length(SUStringRef string_ref, size_t *out_length);
extern SUResult SUStringGetUTF8(SUStringRef string_ref, size_t max_length, char *out_char_array, size_t *out_length);

extern SUResult SUUVHelperRelease(SUUVHelperRef *uvh);
extern SUResult SUUVHelperGetFrontUVQ(SUUVHelperRef uvh, SUPoint3D *point, SUUVQ *uvq);

extern SUResult SUTextureWriterCreate(SUTextureWriterRef *writer);
extern SUResult SUTextureWriterRelease(SUTextureWriterRef *writer);

// ─── Globals ────────────────────────────────────────────────────

static int g_vertex_offset = 1;  // OBJ is 1-based
static int g_uv_offset = 1;
static char g_out_dir[4096] = "";
static char g_mtl_name[256] = "";

// Material tracking — simple list for deduplication
#define MAX_MATERIALS 4096
static struct {
    char name[256];
    int written;
} g_materials[MAX_MATERIALS];
static int g_num_materials = 0;

static const char *g_current_material = NULL;

// ─── Helpers ──────────────────────────────────────���─────────────

static char *su_string_to_cstr(SUStringRef str) {
    size_t len = 0;
    SUStringGetUTF8Length(str, &len);
    char *buf = (char *)malloc(len + 1);
    SUStringGetUTF8(str, len + 1, buf, &len);
    buf[len] = '\0';
    return buf;
}

// Sanitize material name for OBJ (replace spaces/special chars with _)
static void sanitize_name(char *dst, const char *src, size_t max) {
    size_t i = 0;
    for (; src[i] && i < max - 1; i++) {
        char c = src[i];
        if (c == ' ' || c == '\t' || c == '/' || c == '\\' || c == '#')
            dst[i] = '_';
        else
            dst[i] = c;
    }
    dst[i] = '\0';
}

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

// ─── Get material name from a face ──────────────────────────────

static const char *get_face_material_name(SUFaceRef face) {
    SUMaterialRef mat = SU_INVALID;
    if (SUFaceGetFrontMaterial(face, &mat) != SU_ERROR_NONE || SUIsInvalid(mat))
        return NULL;

    SUStringRef nameRef = SU_INVALID;
    SUStringCreate(&nameRef);
    if (SUMaterialGetName(mat, &nameRef) != SU_ERROR_NONE) {
        SUStringRelease(&nameRef);
        return NULL;
    }

    char *raw = su_string_to_cstr(nameRef);
    SUStringRelease(&nameRef);

    // Find or add to material list
    static char sanitized[256];
    sanitize_name(sanitized, raw, sizeof(sanitized));
    free(raw);

    for (int i = 0; i < g_num_materials; i++) {
        if (strcmp(g_materials[i].name, sanitized) == 0)
            return g_materials[i].name;
    }
    if (g_num_materials < MAX_MATERIALS) {
        strncpy(g_materials[g_num_materials].name, sanitized, 255);
        g_materials[g_num_materials].written = 0;
        g_num_materials++;
        return g_materials[g_num_materials - 1].name;
    }
    return NULL;
}

// ─── Write a single face ────────────────────────────────────────

static void write_face(FILE *out, SUFaceRef face, SUTransformation *transform) {
    SULoopRef loop = SU_INVALID;
    if (SUFaceGetOuterLoop(face, &loop) != SU_ERROR_NONE) return;

    size_t num_verts = 0;
    SULoopGetNumVertices(loop, &num_verts);
    if (num_verts < 3) return;

    // Emit usemtl if material changed
    const char *matName = get_face_material_name(face);
    if (matName) {
        if (!g_current_material || strcmp(g_current_material, matName) != 0) {
            fprintf(out, "usemtl %s\n", matName);
            g_current_material = matName;
        }
    } else if (g_current_material) {
        fprintf(out, "usemtl default\n");
        g_current_material = NULL;
    }

    SUVertexRef *vertices = (SUVertexRef *)malloc(num_verts * sizeof(SUVertexRef));
    SULoopGetVertices(loop, num_verts, vertices, &num_verts);

    // Try to get UV coordinates — need TextureWriter for proper UV mapping
    SUUVHelperRef uvh = SU_INVALID;
    int has_uvs = 0;

    // Check if face has a textured material before attempting UV extraction
    SUMaterialRef face_mat = SU_INVALID;
    SUTextureRef face_tex = SU_INVALID;
    int face_has_texture = 0;
    if (SUFaceGetFrontMaterial(face, &face_mat) == SU_ERROR_NONE && !SUIsInvalid(face_mat)) {
        if (SUMaterialGetTexture(face_mat, &face_tex) == SU_ERROR_NONE && !SUIsInvalid(face_tex)) {
            face_has_texture = 1;
        }
    }

    if (face_has_texture) {
        // Create a temporary TextureWriter for proper UV mapping
        SUTextureWriterRef tw = SU_INVALID;
        SUTextureWriterCreate(&tw);
        has_uvs = (SUFaceGetUVHelper(face, 1, 0, tw, &uvh) == SU_ERROR_NONE && !SUIsInvalid(uvh));
        if (!SUIsInvalid(tw)) SUTextureWriterRelease(&tw);
    }

    // First pass: collect positions (untransformed for UV query)
    SUPoint3D *positions = (SUPoint3D *)malloc(num_verts * sizeof(SUPoint3D));
    for (size_t i = 0; i < num_verts; i++) {
        SUVertexGetPosition(vertices[i], &positions[i]);
    }

    // Write UVs (query with untransformed positions)
    // SUUVQ layout: x=u, y=v, z=q (divisor), w=unused
    if (has_uvs) {
        for (size_t i = 0; i < num_verts; i++) {
            SUUVQ uvq = {0,0,0,0};
            if (SUUVHelperGetFrontUVQ(uvh, &positions[i], &uvq) == SU_ERROR_NONE
                && uvq.z != 0.0
                && uvq.x == uvq.x && uvq.y == uvq.y) {  // NaN check
                fprintf(out, "vt %.6f %.6f\n", uvq.x / uvq.z, uvq.y / uvq.z);
            } else {
                fprintf(out, "vt 0 0\n");
            }
        }
        SUUVHelperRelease(&uvh);
    }

    // Write vertex positions (transformed)
    for (size_t i = 0; i < num_verts; i++) {
        apply_transform(&positions[i], transform);
        fprintf(out, "v %.6f %.6f %.6f\n",
                positions[i].x * 0.0254, positions[i].y * 0.0254, positions[i].z * 0.0254);
    }

    free(positions);

    // Write face with or without UV indices
    fprintf(out, "f");
    for (size_t i = 0; i < num_verts; i++) {
        if (has_uvs) {
            fprintf(out, " %d/%d", (int)(g_vertex_offset + i), (int)(g_uv_offset + i));
        } else {
            fprintf(out, " %d", (int)(g_vertex_offset + i));
        }
    }
    fprintf(out, "\n");

    g_vertex_offset += (int)num_verts;
    if (has_uvs) g_uv_offset += (int)num_verts;
    free(vertices);

    // Inner loops (holes)
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
            fprintf(out, "l");
            for (size_t i = 0; i < nv; i++)
                fprintf(out, " %d", (int)(g_vertex_offset + i));
            fprintf(out, " %d\n", g_vertex_offset);
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
        for (size_t i = 0; i < num_faces; i++)
            write_face(out, faces[i], parent_transform);
        free(faces);
    }

    // Standalone edges
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
            if (parent_transform)
                multiply_transforms(&combined, parent_transform, &local);
            else
                combined = local;
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
            if (parent_transform)
                multiply_transforms(&combined, parent_transform, &local);
            else
                combined = local;
            SUComponentDefinitionRef def = SU_INVALID;
            SUComponentInstanceGetDefinition(instances[i], &def);
            SUEntitiesRef def_ents = SU_INVALID;
            SUComponentDefinitionGetEntities(def, &def_ents);
            write_entities(out, def_ents, &combined);
        }
        free(instances);
    }
}

// ──�� Write MTL file ─────────────────────────────────────────────

static void write_mtl(SUModelRef model, const char *mtl_path) {
    FILE *mtl = fopen(mtl_path, "w");
    if (!mtl) return;

    fprintf(mtl, "# Materials exported from SketchUp by skp2obj\n\n");

    // Write default material
    fprintf(mtl, "newmtl default\n");
    fprintf(mtl, "Kd 0.800 0.800 0.800\n");
    fprintf(mtl, "d 1.0\n\n");

    // Get all model materials
    size_t num_mats = 0;
    SUModelGetNumMaterials(model, &num_mats);
    if (num_mats == 0) { fclose(mtl); return; }

    SUMaterialRef *mats = (SUMaterialRef *)malloc(num_mats * sizeof(SUMaterialRef));
    SUModelGetMaterials(model, num_mats, mats, &num_mats);

    for (size_t i = 0; i < num_mats; i++) {
        SUStringRef nameRef = SU_INVALID;
        SUStringCreate(&nameRef);
        if (SUMaterialGetName(mats[i], &nameRef) != SU_ERROR_NONE) {
            SUStringRelease(&nameRef);
            continue;
        }
        char *raw = su_string_to_cstr(nameRef);
        SUStringRelease(&nameRef);

        char sanitized[256];
        sanitize_name(sanitized, raw, sizeof(sanitized));
        free(raw);

        fprintf(mtl, "newmtl %s\n", sanitized);

        // Color
        SUColor color;
        if (SUMaterialGetColor(mats[i], &color) == SU_ERROR_NONE) {
            fprintf(mtl, "Kd %.3f %.3f %.3f\n",
                    color.red / 255.0, color.green / 255.0, color.blue / 255.0);
            if (color.alpha < 255)
                fprintf(mtl, "d %.3f\n", color.alpha / 255.0);
            else
                fprintf(mtl, "d 1.0\n");
        } else {
            fprintf(mtl, "Kd 0.800 0.800 0.800\n");
            fprintf(mtl, "d 1.0\n");
        }

        // Texture
        SUTextureRef tex = SU_INVALID;
        if (SUMaterialGetTexture(mats[i], &tex) == SU_ERROR_NONE && !SUIsInvalid(tex)) {
            // Write texture to file next to the MTL
            char tex_filename[512];
            snprintf(tex_filename, sizeof(tex_filename), "%s_%zu.png", sanitized, i);

            char tex_path[4096];
            snprintf(tex_path, sizeof(tex_path), "%s/%s", g_out_dir, tex_filename);

            if (SUTextureWriteToFile(tex, tex_path) == SU_ERROR_NONE) {
                fprintf(mtl, "map_Kd %s\n", tex_filename);
                fprintf(stderr, "[skp2obj] Exported texture: %s\n", tex_filename);
            }
        }

        fprintf(mtl, "\n");
    }

    free(mats);
    fclose(mtl);
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

    // Determine output directory for textures
    {
        char tmp[4096];
        strncpy(tmp, argv[2], sizeof(tmp) - 1);
        tmp[sizeof(tmp) - 1] = '\0';
        char *dir = dirname(tmp);
        strncpy(g_out_dir, dir, sizeof(g_out_dir) - 1);
    }

    // Write MTL file (same name as OBJ but .mtl extension)
    {
        char mtl_path[4096];
        strncpy(mtl_path, argv[2], sizeof(mtl_path) - 1);
        size_t len = strlen(mtl_path);
        if (len > 4 && strcmp(mtl_path + len - 4, ".obj") == 0) {
            strcpy(mtl_path + len - 4, ".mtl");
        } else {
            strcat(mtl_path, ".mtl");
        }

        // Derive MTL filename (basename only) for the mtllib directive
        char tmp[4096];
        strncpy(tmp, mtl_path, sizeof(tmp) - 1);
        tmp[sizeof(tmp) - 1] = '\0';
        char *base = basename(tmp);
        strncpy(g_mtl_name, base, sizeof(g_mtl_name) - 1);

        write_mtl(model, mtl_path);
        fprintf(stderr, "[skp2obj] Wrote MTL: %s\n", mtl_path);
    }

    out = fopen(argv[2], "w");
    if (!out) {
        fprintf(stderr, "Cannot create output file: %s\n", argv[2]);
        ret = 1;
        goto done;
    }

    fprintf(out, "# Converted from SketchUp by skp2obj\n");
    fprintf(out, "mtllib %s\n\n", g_mtl_name);

    SUEntitiesRef entities = SU_INVALID;
    SUModelGetEntities(model, &entities);
    write_entities(out, entities, NULL);

    fprintf(stderr, "[skp2obj] OK: %d vertices, %d UVs written to %s\n",
            g_vertex_offset - 1, g_uv_offset - 1, argv[2]);

done:
    if (out) fclose(out);
    if (!SUIsInvalid(model)) SUModelRelease(&model);
    SUTerminate();
    return ret;
}

// skp2obj — Converts SketchUp .skp to Wavefront OBJ+MTL using the SketchUp C API.
// Exports geometry with materials (colors + textures) and UV coordinates.
// Usage: skp2obj input.skp output.obj
//
// Build (macOS):  cc -o skp2obj skp2obj.c -L/path/to/sdk -lSketchUpAPI -rpath @executable_path
// Build (Windows/MinGW): x86_64-w64-mingw32-gcc -o skp2obj.exe skp2obj.c -L. -lSketchUpAPI

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <math.h>

// ─── Platform-specific path helpers ─────────────────────────────

#ifdef _WIN32

static void get_dirname(char *dst, const char *path, size_t max) {
    strncpy(dst, path, max - 1);
    dst[max - 1] = '\0';
    char *last_fwd = strrchr(dst, '/');
    char *last_bck = strrchr(dst, '\\');
    char *last = last_fwd > last_bck ? last_fwd : last_bck;
    if (last) *last = '\0';
    else strcpy(dst, ".");
}

static void get_basename(char *dst, const char *path, size_t max) {
    const char *last_fwd = strrchr(path, '/');
    const char *last_bck = strrchr(path, '\\');
    const char *last = last_fwd > last_bck ? last_fwd : last_bck;
    const char *base = last ? last + 1 : path;
    strncpy(dst, base, max - 1);
    dst[max - 1] = '\0';
}

#define PATH_SEP "\\"

#else

#include <libgen.h>
#define PATH_SEP "/"

#endif

// ─── Minimal SketchUp C API type declarations ──────────────────

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
typedef SURef SUDrawingElementRef;
typedef SURef SUMeshHelperRef;

#define SU_INVALID (SURef){NULL}
#define SUIsInvalid(ref) ((ref).ptr == NULL)

typedef unsigned char SUByte;
typedef struct { SUByte red, green, blue, alpha; } SUColor;
typedef struct { double x, y, z; } SUPoint3D;
typedef struct { double values[16]; } SUTransformation;
typedef struct { double x, y, z; } SUVector3D;
typedef struct { double u, v, q; } SUUVQ;

// ─── API function declarations ──────────────────────────────────

#ifdef _WIN32
#define SU_API __declspec(dllimport)
#else
#define SU_API extern
#endif

SU_API void SUInitialize(void);
SU_API void SUTerminate(void);

SU_API SUResult SUModelCreateFromFile(SUModelRef *model, const char *path);
SU_API SUResult SUModelRelease(SUModelRef *model);
SU_API SUResult SUModelGetEntities(SUModelRef model, SUEntitiesRef *entities);
SU_API SUResult SUModelGetNumMaterials(SUModelRef model, size_t *count);
SU_API SUResult SUModelGetMaterials(SUModelRef model, size_t len, SUMaterialRef *mats, size_t *count);

SU_API SUResult SUEntitiesGetNumFaces(SUEntitiesRef entities, size_t *count);
SU_API SUResult SUEntitiesGetFaces(SUEntitiesRef entities, size_t len, SUFaceRef *faces, size_t *count);
SU_API SUResult SUEntitiesGetNumEdges(SUEntitiesRef entities, int standalone_only, size_t *count);
SU_API SUResult SUEntitiesGetEdges(SUEntitiesRef entities, int standalone_only, size_t len, SUEdgeRef *edges, size_t *count);
SU_API SUResult SUEntitiesGetNumGroups(SUEntitiesRef entities, size_t *count);
SU_API SUResult SUEntitiesGetGroups(SUEntitiesRef entities, size_t len, SUGroupRef *groups, size_t *count);
SU_API SUResult SUEntitiesGetNumInstances(SUEntitiesRef entities, size_t *count);
SU_API SUResult SUEntitiesGetInstances(SUEntitiesRef entities, size_t len, SUComponentInstanceRef *instances, size_t *count);

SU_API SUResult SUFaceGetNumVertices(SUFaceRef face, size_t *count);
SU_API SUResult SUFaceGetVertices(SUFaceRef face, size_t len, SUVertexRef *vertices, size_t *count);
SU_API SUResult SUFaceGetOuterLoop(SUFaceRef face, SULoopRef *loop);
SU_API SUResult SUFaceGetNumInnerLoops(SUFaceRef face, size_t *count);
SU_API SUResult SUFaceGetInnerLoops(SUFaceRef face, size_t len, SULoopRef *loops, size_t *count);
SU_API SUResult SUFaceGetFrontMaterial(SUFaceRef face, SUMaterialRef *material);
SU_API SUResult SUFaceGetBackMaterial(SUFaceRef face, SUMaterialRef *material);
SU_API SUResult SUFaceGetUVHelper(SUFaceRef face, int front, int back, SUTextureWriterRef tw, SUUVHelperRef *uvh);
SU_API SUResult SUFaceGetNormal(SUFaceRef face, SUVector3D *normal);

SU_API SUResult SULoopGetNumVertices(SULoopRef loop, size_t *count);
SU_API SUResult SULoopGetVertices(SULoopRef loop, size_t len, SUVertexRef *vertices, size_t *count);

SU_API SUResult SUVertexGetPosition(SUVertexRef vertex, SUPoint3D *position);

SU_API SUResult SUEdgeGetStartVertex(SUEdgeRef edge, SUVertexRef *vertex);
SU_API SUResult SUEdgeGetEndVertex(SUEdgeRef edge, SUVertexRef *vertex);

SU_API SUResult SUGroupGetEntities(SUGroupRef group, SUEntitiesRef *entities);
SU_API SUComponentInstanceRef SUGroupToComponentInstance(SUGroupRef group);

SU_API SUResult SUComponentInstanceGetTransform(SUComponentInstanceRef instance, SUTransformation *transform);
SU_API SUResult SUComponentInstanceGetDefinition(SUComponentInstanceRef instance, SUComponentDefinitionRef *def);
SU_API SUResult SUComponentDefinitionGetEntities(SUComponentDefinitionRef def, SUEntitiesRef *entities);
SU_API SUResult SUComponentDefinitionGetName(SUComponentDefinitionRef def, SUStringRef *name);
SU_API SUResult SUComponentInstanceGetName(SUComponentInstanceRef instance, SUStringRef *name);
SU_API SUResult SUGroupGetName(SUGroupRef group, SUStringRef *name);

SU_API SUDrawingElementRef SUComponentInstanceToDrawingElement(SUComponentInstanceRef instance);
SU_API SUResult SUDrawingElementGetMaterial(SUDrawingElementRef elem, SUMaterialRef *material);

SU_API SUResult SUMaterialGetName(SUMaterialRef material, SUStringRef *name);
SU_API SUResult SUMaterialGetColor(SUMaterialRef material, SUColor *color);
SU_API SUResult SUMaterialGetTexture(SUMaterialRef material, SUTextureRef *texture);
SU_API SUResult SUMaterialGetColorizeType(SUMaterialRef material, int *type);

SU_API SUResult SUTextureGetFileName(SUTextureRef texture, SUStringRef *file_name);
SU_API SUResult SUTextureWriteToFile(SUTextureRef texture, const char *file_path);
SU_API SUResult SUTextureGetDimensions(SUTextureRef texture, size_t *width, size_t *height, double *s_scale, double *t_scale);

SU_API SUResult SUStringCreate(SUStringRef *out_string_ref);
SU_API SUResult SUStringRelease(SUStringRef *string_ref);
SU_API SUResult SUStringGetUTF8Length(SUStringRef string_ref, size_t *out_length);
SU_API SUResult SUStringGetUTF8(SUStringRef string_ref, size_t max_length, char *out_char_array, size_t *out_length);

SU_API SUResult SUUVHelperRelease(SUUVHelperRef *uvh);
SU_API SUResult SUUVHelperGetFrontUVQ(SUUVHelperRef uvh, SUPoint3D *point, SUUVQ *uvq);

SU_API SUResult SUTextureWriterCreate(SUTextureWriterRef *writer);
SU_API SUResult SUTextureWriterRelease(SUTextureWriterRef *writer);

SU_API SUResult SUMeshHelperCreate(SUMeshHelperRef *mesh, SUFaceRef face);
SU_API SUResult SUMeshHelperRelease(SUMeshHelperRef *mesh);
SU_API SUResult SUMeshHelperGetNumTriangles(SUMeshHelperRef mesh, size_t *count);
SU_API SUResult SUMeshHelperGetNumVertices(SUMeshHelperRef mesh, size_t *count);
SU_API SUResult SUMeshHelperGetVertices(SUMeshHelperRef mesh, size_t len, SUPoint3D *vertices, size_t *count);
SU_API SUResult SUMeshHelperGetVertexIndices(SUMeshHelperRef mesh, size_t len, size_t *indices, size_t *count);
SU_API SUResult SUMeshHelperGetNormals(SUMeshHelperRef mesh, size_t len, SUPoint3D *normals, size_t *count);
SU_API SUResult SUMeshHelperGetFrontSTQCoords(SUMeshHelperRef mesh, size_t len, SUPoint3D *stq, size_t *count);

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
    int has_texture;
    double tex_s_scale;  // texture width in inches
    double tex_t_scale;  // texture height in inches
} g_materials[MAX_MATERIALS];
static int g_num_materials = 0;
static int g_group_counter = 0;

static const char *g_current_material = NULL;

// Diagnostic counters
static int g_faces_with_front_mat = 0;
static int g_faces_with_back_mat = 0;
static int g_faces_with_inherited_mat = 0;
static int g_faces_with_default_mat = 0;
static int g_instances_with_mat = 0;
static int g_uvhelper_ok = 0;
static int g_uvhelper_fail = 0;
static int g_procedural_uv = 0;
static SUTextureWriterRef g_texture_writer = SU_INVALID;

// ─── Helpers ────────────────────────────────────────────────────

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

// ─── Look up texture scale for a material name ─────────────────

static int get_material_texture_scale(const char *name, double *s_scale, double *t_scale) {
    for (int i = 0; i < g_num_materials; i++) {
        if (strcmp(g_materials[i].name, name) == 0 && g_materials[i].has_texture) {
            *s_scale = g_materials[i].tex_s_scale;
            *t_scale = g_materials[i].tex_t_scale;
            return 1;
        }
    }
    return 0;
}

// ─── Get material name from a face ──────────────────────────────

static const char *get_face_material_name(SUFaceRef face, int *was_back) {
    *was_back = 0;
    SUMaterialRef mat = SU_INVALID;
    if (SUFaceGetFrontMaterial(face, &mat) != SU_ERROR_NONE || SUIsInvalid(mat)) {
        // Try back face material as fallback
        if (SUFaceGetBackMaterial(face, &mat) != SU_ERROR_NONE || SUIsInvalid(mat))
            return NULL;
        *was_back = 1;
    }

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

// ─── Get material name from a component instance ────────────────

static const char *get_instance_material_name(SUComponentInstanceRef instance) {
    SUDrawingElementRef de = SUComponentInstanceToDrawingElement(instance);
    if (SUIsInvalid(de)) return NULL;

    SUMaterialRef mat = SU_INVALID;
    if (SUDrawingElementGetMaterial(de, &mat) != SU_ERROR_NONE || SUIsInvalid(mat))
        return NULL;

    SUStringRef nameRef = SU_INVALID;
    SUStringCreate(&nameRef);
    if (SUMaterialGetName(mat, &nameRef) != SU_ERROR_NONE) {
        SUStringRelease(&nameRef);
        return NULL;
    }

    char *raw = su_string_to_cstr(nameRef);
    SUStringRelease(&nameRef);

    static char sanitized[256];
    sanitize_name(sanitized, raw, sizeof(sanitized));
    free(raw);

    // Register in material list if not already there
    for (int i = 0; i < g_num_materials; i++) {
        if (strcmp(g_materials[i].name, sanitized) == 0) {
            g_instances_with_mat++;
            return g_materials[i].name;
        }
    }
    if (g_num_materials < MAX_MATERIALS) {
        strncpy(g_materials[g_num_materials].name, sanitized, 255);
        g_materials[g_num_materials].written = 0;
        g_num_materials++;
        g_instances_with_mat++;
        return g_materials[g_num_materials - 1].name;
    }
    return NULL;
}

// ─── Write a single face ────────────────────────────────────────

static void write_face(FILE *out, SUFaceRef face, SUTransformation *transform, const char *inherited_material) {
    // Material assignment
    int was_back = 0;
    const char *matName = get_face_material_name(face, &was_back);
    if (matName) {
        if (was_back) g_faces_with_back_mat++;
        else g_faces_with_front_mat++;
    }
    if (!matName && inherited_material) {
        matName = inherited_material;
        g_faces_with_inherited_mat++;
    }
    if (!matName) g_faces_with_default_mat++;
    if (matName) {
        if (!g_current_material || strcmp(g_current_material, matName) != 0) {
            fprintf(out, "usemtl %s\n", matName);
            g_current_material = matName;
        }
    } else if (g_current_material) {
        fprintf(out, "usemtl default\n");
        g_current_material = NULL;
    }

    // Check for inner loops (holes)
    size_t num_inner = 0;
    SUFaceGetNumInnerLoops(face, &num_inner);

    if (num_inner == 0) {
        // ── Simple face: export outer loop as a single polygon ──
        SULoopRef outer = SU_INVALID;
        if (SUFaceGetOuterLoop(face, &outer) != SU_ERROR_NONE) return;

        size_t num_verts = 0;
        SULoopGetNumVertices(outer, &num_verts);
        if (num_verts < 3) return;

        SUVertexRef *verts = (SUVertexRef *)malloc(num_verts * sizeof(SUVertexRef));
        SULoopGetVertices(outer, num_verts, verts, &num_verts);

        // Get UVs via UVHelper if face has a texture
        int has_uvs = 0;
        int procedural_uvs = 0;
        double tex_s = 1.0, tex_t = 1.0;
        SUUVHelperRef uvh = SU_INVALID;
        SUMaterialRef face_mat = SU_INVALID;
        SUTextureRef face_tex = SU_INVALID;
        if (SUFaceGetFrontMaterial(face, &face_mat) == SU_ERROR_NONE && !SUIsInvalid(face_mat)) {
            if (SUMaterialGetTexture(face_mat, &face_tex) == SU_ERROR_NONE && !SUIsInvalid(face_tex)) {
                SUResult uvh_res = SUFaceGetUVHelper(face, 1, 0, g_texture_writer, &uvh);
                if (uvh_res == SU_ERROR_NONE && !SUIsInvalid(uvh)) {
                    // Verify UVs are valid by checking first vertex
                    SUUVQ test_uvq = {0, 0, 0};
                    SUPoint3D test_pt;
                    SUVertexGetPosition(verts[0], &test_pt);
                    SUResult uv_res = SUUVHelperGetFrontUVQ(uvh, &test_pt, &test_uvq);
                    if (uv_res == SU_ERROR_NONE && test_uvq.q != 0.0) {
                        has_uvs = 1;
                        g_uvhelper_ok++;
                    } else {
                        if (g_uvhelper_fail < 3) {
                            fprintf(stderr, "[skp2obj] UVHelper fail: res=%d u=%.6f v=%.6f q=%.6f pt=(%.1f,%.1f,%.1f)\n",
                                    uv_res, test_uvq.u, test_uvq.v, test_uvq.q,
                                    test_pt.x, test_pt.y, test_pt.z);
                        }
                        g_uvhelper_fail++;
                        SUUVHelperRelease(&uvh);
                        uvh = SU_INVALID;
                    }
                }
            }
        }
        // Fallback: if material has a texture but UV helper failed, generate procedural UVs
        if (!has_uvs && matName && get_material_texture_scale(matName, &tex_s, &tex_t)) {
            procedural_uvs = 1;
            has_uvs = 1;
            g_procedural_uv++;
        }

        // Write vertices and UVs
        for (size_t i = 0; i < num_verts; i++) {
            SUPoint3D pos;
            SUVertexGetPosition(verts[i], &pos);
            apply_transform(&pos, transform);

            if (procedural_uvs) {
                // Project world position onto texture plane
                // tex_s/tex_t = physical size in meters (pixels × meters/pixel from API)
                // pos is in inches, convert to meters for consistent units
                double wx = pos.x * 0.0254, wy = pos.y * 0.0254, wz = pos.z * 0.0254;
                double ts_m = tex_s * 0.0254, tt_m = tex_t * 0.0254;  // inches to meters
                if (ts_m <= 0) ts_m = 1.0;
                if (tt_m <= 0) tt_m = 1.0;
                SUVector3D norm;
                SUFaceGetNormal(face, &norm);
                double ay = fabs(norm.y);
                double u, v;
                if (ay > 0.7) {
                    // Mostly horizontal (floor/ceiling) — project XZ
                    u = wx / ts_m;
                    v = wz / tt_m;
                } else {
                    // Vertical/angled surface — V always maps to Y (gravity-aligned)
                    // U = horizontal tangent: cross(normal, Y_up) = (norm.z, 0, -norm.x)
                    double tx = norm.z, tz = -norm.x;
                    double tlen = sqrt(tx * tx + tz * tz);
                    if (tlen < 0.001) { tx = 1; tz = 0; tlen = 1; }
                    tx /= tlen; tz /= tlen;
                    u = (wx * tx + wz * tz) / ts_m;
                    v = wy / tt_m;
                }
                fprintf(out, "vt %.6f %.6f\n", u, v);
            } else if (has_uvs) {
                SUUVQ uvq = {0, 0, 0};
                SUPoint3D sample_pt;
                SUVertexGetPosition(verts[i], &sample_pt);
                if (SUUVHelperGetFrontUVQ(uvh, &sample_pt, &uvq) == SU_ERROR_NONE && uvq.q != 0.0) {
                    fprintf(out, "vt %.6f %.6f\n", uvq.u / uvq.q, uvq.v / uvq.q);
                } else {
                    fprintf(out, "vt 0 0\n");
                }
            }

            fprintf(out, "v %.6f %.6f %.6f\n",
                    pos.x * 0.0254, pos.y * 0.0254, pos.z * 0.0254);
        }

        if (!SUIsInvalid(uvh)) SUUVHelperRelease(&uvh);
        free(verts);

        // Write single polygon face
        fprintf(out, "f");
        for (size_t i = 0; i < num_verts; i++) {
            if (has_uvs) {
                fprintf(out, " %d/%d",
                        (int)(g_vertex_offset + i), (int)(g_uv_offset + i));
            } else {
                fprintf(out, " %d", (int)(g_vertex_offset + i));
            }
        }
        fprintf(out, "\n");

        g_vertex_offset += (int)num_verts;
        if (has_uvs) g_uv_offset += (int)num_verts;

    } else {
        // ── Face with holes: export outer + inner loops as single polygon ──
        SULoopRef outer = SU_INVALID;
        if (SUFaceGetOuterLoop(face, &outer) != SU_ERROR_NONE) return;

        size_t outer_count = 0;
        SULoopGetNumVertices(outer, &outer_count);
        if (outer_count < 3) return;

        SULoopRef *inner_loops = (SULoopRef *)malloc(num_inner * sizeof(SULoopRef));
        SUFaceGetInnerLoops(face, num_inner, inner_loops, &num_inner);

        size_t total_verts = outer_count;
        size_t *inner_counts = (size_t *)malloc(num_inner * sizeof(size_t));
        for (size_t h = 0; h < num_inner; h++) {
            inner_counts[h] = 0;
            SULoopGetNumVertices(inner_loops[h], &inner_counts[h]);
            total_verts += inner_counts[h];
        }

        int has_uvs = 0;
        int procedural_uvs = 0;
        double tex_s = 1.0, tex_t = 1.0;
        SUUVHelperRef uvh = SU_INVALID;
        SUMaterialRef face_mat = SU_INVALID;
        SUTextureRef face_tex = SU_INVALID;
        if (SUFaceGetFrontMaterial(face, &face_mat) == SU_ERROR_NONE && !SUIsInvalid(face_mat)) {
            if (SUMaterialGetTexture(face_mat, &face_tex) == SU_ERROR_NONE && !SUIsInvalid(face_tex)) {
                if (SUFaceGetUVHelper(face, 1, 0, g_texture_writer, &uvh) == SU_ERROR_NONE && !SUIsInvalid(uvh)) {
                    // Verify UVs by checking first outer loop vertex
                    SUVertexRef *outer_verts_check = (SUVertexRef *)malloc(outer_count * sizeof(SUVertexRef));
                    SULoopGetVertices(outer, outer_count, outer_verts_check, &outer_count);
                    SUUVQ test_uvq = {0, 0, 0};
                    SUPoint3D test_pt;
                    SUVertexGetPosition(outer_verts_check[0], &test_pt);
                    if (SUUVHelperGetFrontUVQ(uvh, &test_pt, &test_uvq) == SU_ERROR_NONE && test_uvq.q != 0.0) {
                        has_uvs = 1;
                    } else {
                        SUUVHelperRelease(&uvh);
                        uvh = SU_INVALID;
                    }
                    free(outer_verts_check);
                }
            }
        }
        if (!has_uvs && matName && get_material_texture_scale(matName, &tex_s, &tex_t)) {
            procedural_uvs = 1;
            has_uvs = 1;
        }

        // Helper: compute procedural UV for a vertex position
        SUVector3D face_norm;
        if (procedural_uvs) SUFaceGetNormal(face, &face_norm);

        // Write outer loop vertices
        SUVertexRef *verts = (SUVertexRef *)malloc(outer_count * sizeof(SUVertexRef));
        SULoopGetVertices(outer, outer_count, verts, &outer_count);
        for (size_t i = 0; i < outer_count; i++) {
            SUPoint3D pos;
            SUVertexGetPosition(verts[i], &pos);
            apply_transform(&pos, transform);
            if (procedural_uvs) {
                double wx = pos.x * 0.0254, wy = pos.y * 0.0254, wz = pos.z * 0.0254;
                double ts_m = tex_s * 0.0254, tt_m = tex_t * 0.0254;  // inches to meters
                if (ts_m <= 0) ts_m = 1.0;
                if (tt_m <= 0) tt_m = 1.0;
                double ay_fn = fabs(face_norm.y);
                double u, v;
                if (ay_fn > 0.7) {
                    u = wx / ts_m; v = wz / tt_m;
                } else {
                    double tx = face_norm.z, tz = -face_norm.x;
                    double tlen = sqrt(tx * tx + tz * tz);
                    if (tlen < 0.001) { tx = 1; tz = 0; tlen = 1; }
                    tx /= tlen; tz /= tlen;
                    u = (wx * tx + wz * tz) / ts_m;
                    v = wy / tt_m;
                }
                fprintf(out, "vt %.6f %.6f\n", u, v);
            } else if (has_uvs) {
                SUUVQ uvq = {0, 0, 0};
                SUPoint3D sample_pt;
                SUVertexGetPosition(verts[i], &sample_pt);
                if (SUUVHelperGetFrontUVQ(uvh, &sample_pt, &uvq) == SU_ERROR_NONE && uvq.q != 0.0) {
                    fprintf(out, "vt %.6f %.6f\n", uvq.u / uvq.q, uvq.v / uvq.q);
                } else {
                    fprintf(out, "vt 0 0\n");
                }
            }
            fprintf(out, "v %.6f %.6f %.6f\n",
                    pos.x * 0.0254, pos.y * 0.0254, pos.z * 0.0254);
        }
        free(verts);

        // Write inner loop vertices
        for (size_t h = 0; h < num_inner; h++) {
            size_t hcount = inner_counts[h];
            verts = (SUVertexRef *)malloc(hcount * sizeof(SUVertexRef));
            SULoopGetVertices(inner_loops[h], hcount, verts, &hcount);
            for (size_t i = 0; i < hcount; i++) {
                SUPoint3D pos;
                SUVertexGetPosition(verts[i], &pos);
                apply_transform(&pos, transform);
                if (procedural_uvs) {
                    double wx = pos.x * 0.0254, wy = pos.y * 0.0254, wz = pos.z * 0.0254;
                    double ts_m = tex_s * 0.0254, tt_m = tex_t * 0.0254;  // inches to meters
                    if (ts_m <= 0) ts_m = 1.0;
                    if (tt_m <= 0) tt_m = 1.0;
                    double ay = fabs(face_norm.y);
                    double u, v;
                    if (ay > 0.7) {
                        // Mostly horizontal (floor/ceiling) — project XZ
                        u = wx / ts_m; v = wz / tt_m;
                    } else {
                        // Vertical/angled surface — V always maps to Y (gravity-aligned)
                        // U = horizontal tangent: cross(normal, Y_up) = (norm.z, 0, -norm.x)
                        double tx = face_norm.z, tz = -face_norm.x;
                        double tlen = sqrt(tx * tx + tz * tz);
                        if (tlen < 0.001) { tx = 1; tz = 0; tlen = 1; }
                        tx /= tlen; tz /= tlen;
                        u = (wx * tx + wz * tz) / ts_m;
                        v = wy / tt_m;
                    }
                    fprintf(out, "vt %.6f %.6f\n", u, v);
                } else if (has_uvs) {
                    SUUVQ uvq = {0, 0, 0};
                    SUPoint3D sample_pt;
                    SUVertexGetPosition(verts[i], &sample_pt);
                    if (SUUVHelperGetFrontUVQ(uvh, &sample_pt, &uvq) == SU_ERROR_NONE && uvq.q != 0.0) {
                        fprintf(out, "vt %.6f %.6f\n", uvq.u / uvq.q, uvq.v / uvq.q);
                    } else {
                        fprintf(out, "vt 0 0\n");
                    }
                }
                fprintf(out, "v %.6f %.6f %.6f\n",
                        pos.x * 0.0254, pos.y * 0.0254, pos.z * 0.0254);
            }
            free(verts);
        }

        if (!SUIsInvalid(uvh)) SUUVHelperRelease(&uvh);

        // Write hole start indices comment
        fprintf(out, "# holes");
        size_t offset = outer_count;
        for (size_t h = 0; h < num_inner; h++) {
            fprintf(out, " %d", (int)offset);
            offset += inner_counts[h];
        }
        fprintf(out, "\n");

        // Write single polygon face
        fprintf(out, "f");
        for (size_t i = 0; i < total_verts; i++) {
            if (has_uvs) {
                fprintf(out, " %d/%d",
                        (int)(g_vertex_offset + i), (int)(g_uv_offset + i));
            } else {
                fprintf(out, " %d", (int)(g_vertex_offset + i));
            }
        }
        fprintf(out, "\n");

        free(inner_loops);
        free(inner_counts);

        g_vertex_offset += (int)total_verts;
        if (has_uvs) g_uv_offset += (int)total_verts;
    }
}

// ─── Write all entities recursively ─────────────────────────────

static void write_entities(FILE *out, SUEntitiesRef entities, SUTransformation *parent_transform, const char *inherited_material, const char *group_path) {
    // Faces
    size_t num_faces = 0;
    SUEntitiesGetNumFaces(entities, &num_faces);
    if (num_faces > 0) {
        SUFaceRef *faces = (SUFaceRef *)malloc(num_faces * sizeof(SUFaceRef));
        SUEntitiesGetFaces(entities, num_faces, faces, &num_faces);
        for (size_t i = 0; i < num_faces; i++)
            write_face(out, faces[i], parent_transform, inherited_material);
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

            // Emit OBJ group marker with group name
            SUStringRef nameRef = SU_INVALID;
            SUStringCreate(&nameRef);
            char grp_name[256];
            if (SUGroupGetName(groups[i], &nameRef) == SU_ERROR_NONE) {
                char *raw = su_string_to_cstr(nameRef);
                if (raw && raw[0] != '\0') {
                    char base[256];
                    sanitize_name(base, raw, sizeof(base));
                    snprintf(grp_name, sizeof(grp_name), "%s_%d", base, ++g_group_counter);
                } else {
                    snprintf(grp_name, sizeof(grp_name), "Group_%d", ++g_group_counter);
                }
                free(raw);
            } else {
                snprintf(grp_name, sizeof(grp_name), "Group_%d", ++g_group_counter);
            }
            SUStringRelease(&nameRef);
            char grp_full_path[1024];
            if (group_path && group_path[0])
                snprintf(grp_full_path, sizeof(grp_full_path), "%s/%s", group_path, grp_name);
            else
                snprintf(grp_full_path, sizeof(grp_full_path), "%s", grp_name);
            fprintf(out, "g %s\n", grp_full_path);

            const char *grp_mat = get_instance_material_name(inst);
            if (!grp_mat) grp_mat = inherited_material;
            SUEntitiesRef grp_ents = SU_INVALID;
            SUGroupGetEntities(groups[i], &grp_ents);
            write_entities(out, grp_ents, &combined, grp_mat, grp_full_path);

            fprintf(out, "g default\n");
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

            // Emit OBJ group marker with component definition name
            SUComponentDefinitionRef def = SU_INVALID;
            SUComponentInstanceGetDefinition(instances[i], &def);
            SUStringRef nameRef = SU_INVALID;
            SUStringCreate(&nameRef);
            char comp_name[256];
            if (SUComponentDefinitionGetName(def, &nameRef) == SU_ERROR_NONE) {
                char *raw = su_string_to_cstr(nameRef);
                if (raw && raw[0] != '\0') {
                    char base[256];
                    sanitize_name(base, raw, sizeof(base));
                    snprintf(comp_name, sizeof(comp_name), "%s_%d", base, ++g_group_counter);
                } else {
                    snprintf(comp_name, sizeof(comp_name), "Component_%d", ++g_group_counter);
                }
                free(raw);
            } else {
                snprintf(comp_name, sizeof(comp_name), "Component_%d", ++g_group_counter);
            }
            SUStringRelease(&nameRef);
            char comp_full_path[1024];
            if (group_path && group_path[0])
                snprintf(comp_full_path, sizeof(comp_full_path), "%s/%s", group_path, comp_name);
            else
                snprintf(comp_full_path, sizeof(comp_full_path), "%s", comp_name);
            fprintf(out, "g %s\n", comp_full_path);

            const char *inst_mat = get_instance_material_name(instances[i]);
            if (!inst_mat) inst_mat = inherited_material;
            SUEntitiesRef def_ents = SU_INVALID;
            SUComponentDefinitionGetEntities(def, &def_ents);
            write_entities(out, def_ents, &combined, inst_mat, comp_full_path);

            fprintf(out, "g default\n");
        }
        free(instances);
    }
}

// ─── Write MTL file ─────────────────────────────────────────────

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
            char tex_filename[512];
            snprintf(tex_filename, sizeof(tex_filename), "%s_%zu.png", sanitized, i);

            char tex_path[4096];
            snprintf(tex_path, sizeof(tex_path), "%s" PATH_SEP "%s", g_out_dir, tex_filename);

            SUResult tex_res = SUTextureWriteToFile(tex, tex_path);
            if (tex_res == SU_ERROR_NONE) {
                fprintf(mtl, "map_Kd %s\n", tex_filename);
                fprintf(stderr, "[skp2obj] Exported texture: %s -> %s\n", tex_filename, tex_path);
            } else {
                fprintf(stderr, "[skp2obj] FAILED to write texture: %s (error %d, path: %s)\n",
                        tex_filename, tex_res, tex_path);
            }

            // Record texture dimensions for procedural UV generation on inherited materials
            // Find or create entry in g_materials[]
            int mi = -1;
            for (int j = 0; j < g_num_materials; j++) {
                if (strcmp(g_materials[j].name, sanitized) == 0) { mi = j; break; }
            }
            if (mi < 0 && g_num_materials < MAX_MATERIALS) {
                mi = g_num_materials++;
                strncpy(g_materials[mi].name, sanitized, 255);
                g_materials[mi].written = 0;
            }
            if (mi >= 0) {
                g_materials[mi].has_texture = 1;
                size_t tw = 0, th = 0;
                double ss = 1.0, ts = 1.0;
                if (SUTextureGetDimensions(tex, &tw, &th, &ss, &ts) == SU_ERROR_NONE && tw > 0 && th > 0 && ss > 0 && ts > 0) {
                    // s_scale/t_scale = inches per pixel; physical size = pixels × scale
                    g_materials[mi].tex_s_scale = (double)tw * ss;
                    g_materials[mi].tex_t_scale = (double)th * ts;
                } else {
                    g_materials[mi].tex_s_scale = 24.0;  // default ~2ft
                    g_materials[mi].tex_t_scale = 24.0;
                }
                fprintf(stderr, "[skp2obj] Material '%s' physical size: %.1f x %.1f inches\n",
                        sanitized, g_materials[mi].tex_s_scale, g_materials[mi].tex_t_scale);
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
#ifdef _WIN32
    get_dirname(g_out_dir, argv[2], sizeof(g_out_dir));
#else
    {
        char tmp[4096];
        strncpy(tmp, argv[2], sizeof(tmp) - 1);
        tmp[sizeof(tmp) - 1] = '\0';
        char *dir = dirname(tmp);
        strncpy(g_out_dir, dir, sizeof(g_out_dir) - 1);
    }
#endif

    // Write MTL file (same name as OBJ but .mtl extension)
    {
        char mtl_path[4096];
        strncpy(mtl_path, argv[2], sizeof(mtl_path) - 1);
        mtl_path[sizeof(mtl_path) - 1] = '\0';
        size_t len = strlen(mtl_path);
        if (len > 4 && strcmp(mtl_path + len - 4, ".obj") == 0) {
            strcpy(mtl_path + len - 4, ".mtl");
        } else {
            strcat(mtl_path, ".mtl");
        }

        // Derive MTL filename (basename only) for the mtllib directive
#ifdef _WIN32
        get_basename(g_mtl_name, mtl_path, sizeof(g_mtl_name));
#else
        {
            char tmp[4096];
            strncpy(tmp, mtl_path, sizeof(tmp) - 1);
            tmp[sizeof(tmp) - 1] = '\0';
            char *base = basename(tmp);
            strncpy(g_mtl_name, base, sizeof(g_mtl_name) - 1);
        }
#endif

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

    // Create texture writer for UV helper (needed to get per-face UVs)
    SUTextureWriterCreate(&g_texture_writer);

    SUEntitiesRef entities = SU_INVALID;
    SUModelGetEntities(model, &entities);
    write_entities(out, entities, NULL, NULL, NULL);

    fprintf(stderr, "[skp2obj] OK: %d vertices, %d UVs written to %s\n",
            g_vertex_offset - 1, g_uv_offset - 1, argv[2]);
    fprintf(stderr, "[skp2obj] Material stats: front=%d back=%d inherited=%d default=%d instances_with_mat=%d\n",
            g_faces_with_front_mat, g_faces_with_back_mat, g_faces_with_inherited_mat,
            g_faces_with_default_mat, g_instances_with_mat);
    fprintf(stderr, "[skp2obj] UV stats: uvhelper_ok=%d uvhelper_fail=%d procedural=%d\n",
            g_uvhelper_ok, g_uvhelper_fail, g_procedural_uv);

done:
    if (out) fclose(out);
    if (!SUIsInvalid(g_texture_writer)) SUTextureWriterRelease(&g_texture_writer);
    if (!SUIsInvalid(model)) SUModelRelease(&model);
    SUTerminate();
    return ret;
}

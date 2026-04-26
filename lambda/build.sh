#!/bin/bash
# Build the SKP conversion Lambda: cross-compile skp2obj for Windows, build Docker image.
# Prerequisites:
#   - MinGW installed: brew install mingw-w64
#   - SketchUp Windows SDK files in lambda/sdk/ (SketchUpAPI.dll + any dependency DLLs)
#   - Docker running
#
# To get the Windows SDK:
#   1. Download SketchUp for Windows from https://www.sketchup.com/try-sketchup
#   2. Extract/install it
#   3. Copy these files from the SketchUp installation directory to lambda/sdk/:
#      - SketchUpAPI.dll
#      - SketchUpCommonPreferences.dll (if present)
#      - Any other DLL dependencies

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Step 1: Create import library from SketchUpAPI.dll ==="

# Generate .def file listing exported functions
cat > SketchUpAPI.def << 'EOF'
LIBRARY SketchUpAPI
EXPORTS
    SUInitialize
    SUTerminate
    SUModelCreateFromFile
    SUModelRelease
    SUModelGetEntities
    SUModelGetNumMaterials
    SUModelGetMaterials
    SUEntitiesGetNumFaces
    SUEntitiesGetFaces
    SUEntitiesGetNumEdges
    SUEntitiesGetEdges
    SUEntitiesGetNumGroups
    SUEntitiesGetGroups
    SUEntitiesGetNumInstances
    SUEntitiesGetInstances
    SUFaceGetNumVertices
    SUFaceGetVertices
    SUFaceGetOuterLoop
    SUFaceGetNumInnerLoops
    SUFaceGetInnerLoops
    SUFaceGetFrontMaterial
    SUFaceGetUVHelper
    SUFaceGetNormal
    SULoopGetNumVertices
    SULoopGetVertices
    SUVertexGetPosition
    SUEdgeGetStartVertex
    SUEdgeGetEndVertex
    SUGroupGetEntities
    SUGroupToComponentInstance
    SUComponentInstanceGetTransform
    SUComponentInstanceGetDefinition
    SUComponentDefinitionGetEntities
    SUComponentDefinitionGetName
    SUComponentInstanceGetName
    SUGroupGetName
    SUMaterialGetName
    SUMaterialGetColor
    SUMaterialGetTexture
    SUMaterialGetColorizeType
    SUTextureGetFileName
    SUTextureWriteToFile
    SUTextureGetDimensions
    SUStringCreate
    SUStringRelease
    SUStringGetUTF8Length
    SUStringGetUTF8
    SUUVHelperRelease
    SUUVHelperGetFrontUVQ
    SUTextureWriterCreate
    SUTextureWriterRelease
    SUComponentInstanceToDrawingElement
    SUDrawingElementGetMaterial
    SUFaceGetBackMaterial
    SUMeshHelperCreate
    SUMeshHelperRelease
    SUMeshHelperGetNumTriangles
    SUMeshHelperGetNumVertices
    SUMeshHelperGetVertices
    SUMeshHelperGetVertexIndices
    SUMeshHelperGetNormals
    SUMeshHelperGetFrontSTQCoords
EOF

# Create import library from .def file
x86_64-w64-mingw32-dlltool -d SketchUpAPI.def -l libSketchUpAPI.a
echo "  Created libSketchUpAPI.a"

echo "=== Step 2: Cross-compile skp2obj for Windows ==="

x86_64-w64-mingw32-gcc \
    -O2 \
    -o skp2obj_win.exe \
    ../tools/skp2obj.c \
    -L. -lSketchUpAPI \
    -Wl,--enable-stdcall-fixup

echo "  Built skp2obj_win.exe (from tools/skp2obj.c)"

echo "=== Step 3: Verify SDK files ==="

if [ ! -d sdk ] || [ ! -f sdk/SketchUpAPI.dll ]; then
    echo ""
    echo "ERROR: lambda/sdk/SketchUpAPI.dll not found!"
    echo ""
    echo "To fix this:"
    echo "  1. Download SketchUp for Windows from https://www.sketchup.com/try-sketchup"
    echo "  2. Install it (or extract with 7z)"
    echo "  3. Copy SketchUpAPI.dll (and any other DLLs from the same directory)"
    echo "     to: $(pwd)/sdk/"
    echo ""
    exit 1
fi

echo "  SDK files found in sdk/"
ls -la sdk/*.dll 2>/dev/null || true

echo "=== Step 4: Build Docker image ==="

docker build --platform linux/amd64 -t skp-convert-lambda .

echo ""
echo "=== Build complete ==="
echo "  Image: skp-convert-lambda"
echo ""
echo "Test locally:"
echo "  docker run -p 9000:8080 skp-convert-lambda"
echo ""
echo "Deploy:"
echo "  ./deploy.sh"

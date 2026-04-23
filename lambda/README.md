# SKP Conversion Lambda

Converts SketchUp (.skp) files to OBJ+MTL+textures using the SketchUp C API via Wine on AWS Lambda.

## Setup

### 1. Get the Windows SketchUp SDK

You need `SketchUpAPI.dll` and its dependency DLLs from a Windows SketchUp installation.

**Option A — From an existing Windows SketchUp installation:**
```
Copy all DLLs from C:\Program Files\SketchUp\SketchUp 2026\ to lambda/sdk/
```

**Option B — Extract from the installer on Windows:**
```powershell
# Download SketchUp installer
Invoke-WebRequest -Uri "https://download.sketchup.com/SketchUpFull-2026-1-256-82.exe" -OutFile SketchUp.exe
# Install to a temp directory or use 7z to extract
7z x SketchUp.exe -oextracted
# Find and copy SketchUpAPI.dll
```

**Option C — Use GitHub Actions** (see `.github/workflows/extract-sdk.yml`)

### 2. Build

```bash
# Cross-compile skp2obj for Windows and build Docker image
./build.sh
```

### 3. Deploy

```bash
# Push to ECR and create/update Lambda
./deploy.sh
```

### 4. Configure the web app

Set the Lambda Function URL in the web build:
```bash
export SKP_CONVERT_URL="https://xxxxx.lambda-url.us-east-1.on.aws/"
npm run build:web
```

## Architecture

```
Browser (draftdownapp.com)
  │ POST (base64 SKP)
  ▼
Lambda Function URL
  │ Wine + skp2obj_win.exe + SketchUpAPI.dll
  ▼
ZIP response (OBJ + MTL + textures)
  │ unpackZip() in browser
  ▼
importOBJ({ rotateSkp: true })
```

## Local Testing

```bash
docker run -p 9000:8080 skp-convert-lambda

# Convert a file
cat test.skp | base64 | \
  curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
    -d "{\"body\": \"{\\\"file\\\": \\\"$(cat)\\\", \\\"filename\\\": \\\"test.skp\\\"}\"}"
```

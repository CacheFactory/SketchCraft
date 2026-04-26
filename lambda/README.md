# SKP Conversion Service

Converts SketchUp (.skp) files to OBJ+MTL+textures using the SketchUp C API via Wine.

**Runs on AWS App Runner** (not Lambda — Wine needs a full Linux kernel that Lambda's Firecracker micro-VM doesn't provide).

## Setup

### 1. Get the Windows SketchUp SDK

You need `SketchUpAPI.dll` and `SketchUpCommonPreferences.dll` from a Windows SketchUp installation.

**Option A — From an existing Windows SketchUp installation:**
```
Copy SketchUpAPI.dll and SketchUpCommonPreferences.dll from
C:\Program Files\SketchUp\SketchUp 2026\ to lambda/sdk/
```

**Option B — Use GitHub Actions** (see `.github/workflows/extract-sdk.yml`)

### 2. Build

```bash
# Cross-compile skp2obj for Windows
./build.sh

# Build Docker image (must target x86_64 for Wine)
docker build --platform linux/amd64 -t skp-convert .
```

### 3. Deploy

```bash
./deploy.sh
```

### 4. Configure the web app

Set the service URL in the web build:
```bash
export SKP_CONVERT_URL="https://xxxxx.us-east-1.awsapprunner.com"
npm run build:web
```

## Architecture

```
Browser (draftdownapp.com)
  │ POST { file: base64, filename: "model.skp" }
  ▼
App Runner (skp-convert)
  │ Wine + skp2obj_win.exe + SketchUpAPI.dll
  ▼
ZIP response (OBJ + MTL + textures)
  │ unpackZip() in browser
  ▼
importOBJ({ rotateSkp: true })
```

## Local Testing

**Note:** Testing on Apple Silicon requires QEMU emulation of x86_64, which causes Wine to segfault. Test on an x86_64 Linux machine or deploy to AWS.

On an x86_64 machine:
```bash
docker build --platform linux/amd64 -t skp-convert .
docker run -p 8080:8080 skp-convert

# Health check
curl http://localhost:8080/

# Convert a file
cat test.skp | base64 -w0 | \
  jq -Rn '{file: input, filename: "test.skp"}' | \
  curl -XPOST http://localhost:8080/ -H "Content-Type: application/json" -d @- -o result.zip
```

## Why Not Lambda?

Wine uses Linux syscalls (`clone()`, `mmap()` with `MAP_FIXED`, etc.) that Lambda's Firecracker micro-VM kernel doesn't support. Even `wine cmd.exe /c "echo hello"` segfaults on Lambda. App Runner uses standard EC2 instances with a full kernel.

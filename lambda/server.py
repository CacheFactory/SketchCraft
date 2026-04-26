# @archigraph svc.skp_convert
# HTTP server for SKP-to-OBJ conversion.
# Receives SKP file (base64 JSON or multipart), runs skp2obj via Wine,
# returns ZIP of OBJ+MTL+textures.
# Designed for Fargate/App Runner (Wine needs full Linux kernel, not Lambda).

import os
import json
import base64
import shutil
import subprocess
import tempfile
import zipfile
import io
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

SKPOBJ_DIR = '/opt/skp2obj'
PORT = int(os.environ.get('PORT', '8080'))

_wine_initialized = False

def _ensure_wine():
    global _wine_initialized
    if _wine_initialized:
        return

    env = _wine_env()

    # Copy exe + DLLs to /tmp for write access
    work = '/tmp/skp2obj'
    os.makedirs(work, exist_ok=True)
    for f in os.listdir(SKPOBJ_DIR):
        src = os.path.join(SKPOBJ_DIR, f)
        dst = os.path.join(work, f)
        if os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)

    # Copy pre-initialized Wine prefix (has MSVC runtime DLLs from winetricks)
    wineprefix = env['WINEPREFIX']
    if not os.path.exists(os.path.join(wineprefix, 'system.reg')):
        print('[skp-convert] Copying Wine prefix...', flush=True)
        if os.path.exists('/opt/wineprefix'):
            shutil.copytree('/opt/wineprefix', wineprefix, dirs_exist_ok=True)
        else:
            os.makedirs(wineprefix, exist_ok=True)
            try:
                subprocess.run(
                    ['wineboot', '-i'], env=env,
                    capture_output=True, timeout=90,
                )
            except subprocess.TimeoutExpired:
                print('[skp-convert] wineboot timed out', flush=True)
    print('[skp-convert] Wine ready', flush=True)
    _wine_initialized = True


def _wine_env():
    env = os.environ.copy()
    env['WINEPREFIX'] = '/tmp/wine'
    env['WINEDEBUG'] = '-all'
    env['WINEARCH'] = 'win64'
    # Force Wine to use real Microsoft DLLs instead of its built-in stubs
    env['WINEDLLOVERRIDES'] = 'msvcp140=n;msvcp140_1=n;msvcp140_2=n;msvcp140_codecvt_ids=n;vcruntime140=n;vcruntime140_1=n;concrt140=n'
    # Ensure Wine can find its own libraries
    # Unset DISPLAY to prevent any GUI attempts
    env.pop('DISPLAY', None)
    return env


def convert_skp(skp_data: bytes, filename: str) -> tuple[int, dict, bytes]:
    """Convert SKP bytes to ZIP of OBJ+MTL+textures. Returns (status, headers, body)."""
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }

    try:
        _ensure_wine()

        work_dir = tempfile.mkdtemp(dir='/tmp')
        skp_path = os.path.join(work_dir, 'input.skp')
        obj_path = os.path.join(work_dir, 'output.obj')

        with open(skp_path, 'wb') as f:
            f.write(skp_data)

        env = _wine_env()
        wine_skp = 'Z:' + skp_path.replace('/', '\\')
        wine_obj = 'Z:' + obj_path.replace('/', '\\')
        wine_exe = 'Z:\\tmp\\skp2obj\\skp2obj_win.exe'

        start = time.time()
        result = subprocess.run(
            ['wine', wine_exe, wine_skp, wine_obj],
            env=env,
            capture_output=True,
            text=True,
            timeout=240,
            cwd='/tmp/skp2obj',
        )
        elapsed = time.time() - start

        print(f'[skp-convert] Wine exit={result.returncode} in {elapsed:.1f}s')
        if result.stdout:
            print(f'[skp-convert] stdout: {result.stdout[:2000]}')
        if result.stderr:
            print(f'[skp-convert] stderr: {result.stderr[:2000]}')

        if result.returncode != 0:
            return 500, headers, json.dumps({
                'error': 'Conversion failed',
                'exitCode': result.returncode,
                'stderr': result.stderr[:1000],
                'stdout': result.stdout[:1000],
                'cmd': ' '.join(['wine', wine_exe, wine_skp, wine_obj]),
                'cwd_files': os.listdir('/tmp/skp2obj'),
            }).encode()

        if not os.path.exists(obj_path):
            return 500, headers, json.dumps({
                'error': 'No output file generated',
            }).encode()

        # Collect output into ZIP
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fname in os.listdir(work_dir):
                fpath = os.path.join(work_dir, fname)
                if fname == 'input.skp':
                    continue
                if os.path.isfile(fpath):
                    zf.write(fpath, fname)
                    print(f'[skp-convert] ZIP: {fname} ({os.path.getsize(fpath)} bytes)')

        zip_data = zip_buffer.getvalue()
        print(f'[skp-convert] ZIP total: {len(zip_data)} bytes')
        headers['Content-Type'] = 'application/zip'
        return 200, headers, zip_data

    except subprocess.TimeoutExpired:
        return 504, headers, json.dumps({'error': 'Conversion timed out'}).encode()
    except Exception as e:
        print(f'[skp-convert] Error: {e}')
        return 500, headers, json.dumps({'error': str(e)}).encode()
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        """Health check endpoint."""
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
            skp_data = base64.b64decode(data['file'])
            filename = data.get('filename', 'model.skp')
        except Exception as e:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'Invalid request: {e}'}).encode())
            return

        print(f'[skp-convert] Received {len(skp_data)} bytes: {filename}')
        status, headers, response_body = convert_skp(skp_data, filename)

        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, format, *args):
        print(f'[http] {args[0]}')


if __name__ == '__main__':
    print(f'[skp-convert] Starting on port {PORT}')
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    server.serve_forever()

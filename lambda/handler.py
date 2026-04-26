# @archigraph svc.skp_convert
# Lambda handler for SKP-to-OBJ conversion.
# Receives SKP file (base64), runs skp2obj via Wine, returns ZIP of OBJ+MTL+textures.

import os
import json
import base64
import shutil
import subprocess
import tempfile
import zipfile
import io
import time

_wine_initialized = False

def _ensure_wine():
    """Initialize Wine prefix and copy binaries on cold start."""
    global _wine_initialized
    if _wine_initialized:
        return

    env = _wine_env()

    # Copy exe + DLLs to a working directory under /tmp
    skp2obj_dir = '/tmp/skp2obj'
    os.makedirs(skp2obj_dir, exist_ok=True)
    for f in os.listdir('/opt/skp2obj'):
        src = os.path.join('/opt/skp2obj', f)
        dst = os.path.join(skp2obj_dir, f)
        if os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)

    # Initialize Wine prefix (creates registry, drive mappings)
    subprocess.run(
        ['wineboot', '--init'], env=env,
        capture_output=True, timeout=60,
    )
    print('[skp-convert] Wine initialized')
    _wine_initialized = True


def _wine_env():
    env = os.environ.copy()
    env['WINEPREFIX'] = '/tmp/wine'
    env['WINEDEBUG'] = '-all'
    env['WINEARCH'] = 'win64'
    return env


def lambda_handler(event, context):
    """Convert SKP file to OBJ+MTL+textures."""

    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    }

    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}

    try:
        # Parse request body
        body = event.get('body', '')
        if event.get('isBase64Encoded'):
            body = base64.b64decode(body).decode('utf-8')

        data = json.loads(body)
        skp_data = base64.b64decode(data['file'])
        filename = data.get('filename', 'model.skp')

        print(f'[skp-convert] Received {len(skp_data)} bytes: {filename}')

        # Ensure Wine is ready
        _ensure_wine()

        # Write SKP to temp file
        work_dir = tempfile.mkdtemp(dir='/tmp')
        skp_path = os.path.join(work_dir, 'input.skp')
        obj_path = os.path.join(work_dir, 'output.obj')

        with open(skp_path, 'wb') as f:
            f.write(skp_data)

        env = _wine_env()

        # Wine maps Linux / to Z:\ — construct Windows paths directly
        wine_skp = 'Z:' + skp_path.replace('/', '\\')
        wine_obj = 'Z:' + obj_path.replace('/', '\\')
        wine_exe = 'Z:\\tmp\\skp2obj\\skp2obj_win.exe'

        start = time.time()
        result = subprocess.run(
            ['wine64', wine_exe, wine_skp, wine_obj],
            env=env,
            capture_output=True,
            text=True,
            timeout=240,
            cwd='/tmp/skp2obj',  # Working dir = where the DLLs are
        )
        elapsed = time.time() - start

        print(f'[skp-convert] Wine exit={result.returncode} in {elapsed:.1f}s')
        if result.stdout:
            print(f'[skp-convert] stdout: {result.stdout[:500]}')
        if result.stderr:
            print(f'[skp-convert] stderr: {result.stderr[:500]}')

        if result.returncode != 0:
            return {
                'statusCode': 500,
                'headers': headers,
                'body': json.dumps({
                    'error': 'Conversion failed',
                    'details': result.stderr[:500] or result.stdout[:500],
                }),
            }

        # Check OBJ was created
        if not os.path.exists(obj_path):
            return {
                'statusCode': 500,
                'headers': headers,
                'body': json.dumps({'error': 'No output file generated'}),
            }

        # Collect all output files into a ZIP
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fname in os.listdir(work_dir):
                fpath = os.path.join(work_dir, fname)
                if fname == 'input.skp':
                    continue
                if os.path.isfile(fpath):
                    zf.write(fpath, fname)
                    size = os.path.getsize(fpath)
                    print(f'[skp-convert] Added to ZIP: {fname} ({size} bytes)')

        zip_data = zip_buffer.getvalue()
        print(f'[skp-convert] ZIP size: {len(zip_data)} bytes')

        return {
            'statusCode': 200,
            'headers': {
                **headers,
                'Content-Type': 'application/zip',
            },
            'body': base64.b64encode(zip_data).decode('utf-8'),
            'isBase64Encoded': True,
        }

    except subprocess.TimeoutExpired:
        return {
            'statusCode': 504,
            'headers': headers,
            'body': json.dumps({'error': 'Conversion timed out (>240s)'}),
        }
    except Exception as e:
        print(f'[skp-convert] Error: {e}')
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)}),
        }

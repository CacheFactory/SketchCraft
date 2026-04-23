# @archigraph svc.skp_convert
# Lambda handler for SKP-to-OBJ conversion.
# Receives SKP file (base64), runs skp2obj via Wine, returns ZIP of OBJ+MTL+textures.

import os
import json
import base64
import subprocess
import tempfile
import zipfile
import io
import time

def lambda_handler(event, context):
    """Convert SKP file to OBJ+MTL+textures."""

    # Handle CORS preflight
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

        # Write SKP to temp file
        work_dir = tempfile.mkdtemp(dir='/tmp')
        skp_path = os.path.join(work_dir, 'input.skp')
        obj_path = os.path.join(work_dir, 'output.obj')

        with open(skp_path, 'wb') as f:
            f.write(skp_data)

        # Run conversion via Wine
        skp2obj_path = '/opt/skp2obj/skp2obj_win.exe'
        env = os.environ.copy()
        env['WINEPREFIX'] = '/tmp/wine'
        env['WINEDEBUG'] = '-all'  # Suppress Wine debug output

        # Convert Windows paths for Wine
        wine_skp = subprocess.check_output(
            ['winepath', '-w', skp_path], env=env, text=True
        ).strip()
        wine_obj = subprocess.check_output(
            ['winepath', '-w', obj_path], env=env, text=True
        ).strip()

        start = time.time()
        result = subprocess.run(
            ['wine64', skp2obj_path, wine_skp, wine_obj],
            env=env,
            capture_output=True,
            text=True,
            timeout=240,
        )
        elapsed = time.time() - start

        print(f'[skp-convert] Wine exit={result.returncode} in {elapsed:.1f}s')
        if result.stderr:
            print(f'[skp-convert] stderr: {result.stderr[:500]}')

        if result.returncode != 0:
            return {
                'statusCode': 500,
                'headers': headers,
                'body': json.dumps({
                    'error': 'Conversion failed',
                    'details': result.stderr[:500],
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

        # Return ZIP as base64
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

"""Minimal ComfyUI HTTP client (stdlib only): upload an image, queue an API-format workflow,
wait for it via /history, and fetch the outputs via /view.

The server is started separately (work/tools/comfyui/start_comfyui.sh, see SETUP.md) and must listen on
127.0.0.1 only. Nothing here talks to any other host.
"""
import io
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

HOST = os.environ.get('COMFY_HOST', '127.0.0.1:8188')
assert HOST.split(':')[0] in ('127.0.0.1', 'localhost'), 'ComfyUI must be local'
CLIENT_ID = str(uuid.uuid4())


def _req(path, data=None, headers=None, timeout=60):
    r = urllib.request.Request(f'http://{HOST}{path}', data=data, headers=headers or {})
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return f.read()


def alive():
    try:
        json.loads(_req('/system_stats', timeout=3))
        return True
    except Exception:
        return False


def wait_alive(timeout=300):
    t = time.time()
    while time.time() - t < timeout:
        if alive():
            return True
        time.sleep(2)
    raise RuntimeError('ComfyUI did not come up on ' + HOST)


def system_stats():
    return json.loads(_req('/system_stats'))


def upload(img, name):
    """img: PIL.Image or path. Uploads to ComfyUI's input dir (overwrite). Returns the stored name."""
    from PIL import Image
    if isinstance(img, str):
        img = Image.open(img)
    buf = io.BytesIO(); img.save(buf, 'PNG'); body_img = buf.getvalue()
    b = uuid.uuid4().hex
    parts = [
        f'--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'.encode(),
        f'--{b}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n'.encode(),
        f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'.encode(),
        body_img, f'\r\n--{b}--\r\n'.encode()]
    res = json.loads(_req('/upload/image', b''.join(parts), {'Content-Type': f'multipart/form-data; boundary={b}'}))
    return res['name'] if not res.get('subfolder') else f"{res['subfolder']}/{res['name']}"


def queue(workflow):
    body = json.dumps({'prompt': workflow, 'client_id': CLIENT_ID}).encode()
    try:
        res = json.loads(_req('/prompt', body, {'Content-Type': 'application/json'}))
    except urllib.error.HTTPError as e:
        raise RuntimeError('ComfyUI rejected the workflow: ' + e.read().decode(errors='replace')[:3000])
    if res.get('node_errors'):
        raise RuntimeError('node errors: ' + json.dumps(res['node_errors'])[:3000])
    return res['prompt_id']


def wait(prompt_id, timeout=7200, poll=1.0):
    t = time.time()
    while time.time() - t < timeout:
        h = json.loads(_req(f'/history/{prompt_id}'))
        if prompt_id in h:
            e = h[prompt_id]
            st = e.get('status', {})
            if st.get('status_str') == 'error':
                msgs = [m for m in st.get('messages', []) if m[0] == 'execution_error']
                raise RuntimeError('execution error: ' + json.dumps(msgs)[:3000])
            if st.get('completed', True):
                return e
        time.sleep(poll)
    raise TimeoutError(prompt_id)


def view(image_ref):
    """image_ref: one entry of outputs[node]['images'] -> PIL.Image"""
    from PIL import Image
    q = urllib.parse.urlencode({'filename': image_ref['filename'], 'subfolder': image_ref.get('subfolder', ''),
                                'type': image_ref.get('type', 'output')})
    return Image.open(io.BytesIO(_req(f'/view?{q}', timeout=300)))


def run(workflow, out_node=None):
    """Queue, wait, and return (list of PIL images of out_node or of every SaveImage/PreviewImage, seconds)."""
    t = time.time()
    pid = queue(workflow)
    h = wait(pid)
    dt = time.time() - t
    imgs = []
    for nid, o in h.get('outputs', {}).items():
        if out_node is not None and str(nid) != str(out_node):
            continue
        for ref in o.get('images', []):
            imgs.append(view(ref))
    return imgs, dt


def free():
    """Ask ComfyUI to unload models / free VRAM (between big jobs)."""
    try:
        _req('/free', json.dumps({'unload_models': True, 'free_memory': True}).encode(), {'Content-Type': 'application/json'})
    except Exception:
        pass

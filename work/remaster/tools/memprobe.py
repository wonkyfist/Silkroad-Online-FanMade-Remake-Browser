"""Find which ComfyUI stage makes the per-tile CPU-RAM spike: run small workflows one at a time while sampling the
server's private bytes (psutil) every 0.25 s. Aborts (interrupt + free) if system available RAM < 1.5 GB.
usage: venv python memprobe.py"""
import json, os, sys, threading, time
import psutil
sys.path.insert(0, os.path.dirname(__file__))
import comfy_api as C
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))


def server_proc():
    for c in psutil.net_connections('tcp'):
        if c.laddr and c.laddr.port == 8188 and c.status == 'LISTEN':
            return psutil.Process(c.pid)


def watch(proc, stop, rec):
    while not stop.is_set():
        try:
            pm = proc.memory_info().private / 2 ** 30
        except Exception:
            break
        av = psutil.virtual_memory().available / 2 ** 30
        rec.append((time.time(), pm, av))
        if av < 1.5:
            C._req('/interrupt', b'{}', {'Content-Type': 'application/json'})
            print('ABORT: system available RAM', round(av, 2), 'GB')
        time.sleep(0.25)


def probe(name, wf):
    proc = server_proc(); rec = []; stop = threading.Event()
    t = threading.Thread(target=watch, args=(proc, stop, rec)); t.start()
    base = proc.memory_info().private / 2 ** 30
    try:
        _, dt = C.run(wf)
    except Exception as e:
        dt = -1; print(name, 'ERROR', str(e)[:200])
    stop.set(); t.join()
    pk = max(r[1] for r in rec); mn = min(r[2] for r in rec)
    print(json.dumps(dict(probe=name, seconds=round(dt, 1), private_before_gb=round(base, 2), private_peak_gb=round(pk, 2),
                          min_sys_available_gb=round(mn, 2))))
    return rec


def base_nodes(img_name, cn):
    wf = {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'sd_xl_base_1.0.safetensors'}},
        '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'sdxl_vae_fp16_fix.safetensors'}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': 'leather armour texture'}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': 'blurry'}},
        '6': {'class_type': 'LoadImage', 'inputs': {'image': img_name}},
    }
    pos, neg = ['3', 0], ['4', 0]
    if cn:
        wf['5'] = {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': 'controlnet-tile-sdxl-1.0.safetensors'}}
        wf['7'] = {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': pos, 'negative': neg, 'control_net': ['5', 0],
                                                                        'image': ['6', 0], 'strength': 0.8, 'start_percent': 0.0, 'end_percent': 0.85}}
        pos, neg = ['7', 0], ['7', 1]
    return wf, pos, neg


def usdu_wf(img_name, cn, seed, tile=1024, pad=128, tiled=False):
    wf, pos, neg = base_nodes(img_name, cn)
    wf['8'] = {'class_type': 'UltimateSDUpscaleCustomSample', 'inputs': {
        'image': ['6', 0], 'model': ['1', 0], 'positive': pos, 'negative': neg, 'vae': ['2', 0], 'upscale_by': 1.0, 'seed': seed,
        'steps': 6, 'cfg': 5.0, 'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': 0.4, 'mode_type': 'Linear',
        'tile_width': tile, 'tile_height': tile, 'mask_blur': 16, 'tile_padding': pad, 'seam_fix_mode': 'None',
        'seam_fix_denoise': 0.2, 'seam_fix_width': 64, 'seam_fix_mask_blur': 16, 'seam_fix_padding': 32,
        'force_uniform_tiles': True, 'tiled_decode': tiled, 'batch_size': 1}}
    wf['9'] = {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': 'memprobe/u'}}
    return wf


if __name__ == '__main__':
    C.wait_alive()
    im = Image.open(os.path.join(ROOT, 'work/tmp/detail/bakeoff/_work/bench/ba1024.png')).convert('RGB')
    which = sys.argv[1:] or ['vae1152', 'usdu_nocn', 'usdu_cn', 'usdu_cn_pad0']
    for i, w in enumerate(which):
        n = C.upload(im.rotate(90 * i), f'memprobe_{w}.png')
        if w == 'vae1152':
            n = C.upload(im.resize((1152, 1152)), 'memprobe_vae.png')
            wf = {'2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'sdxl_vae_fp16_fix.safetensors'}},
                  '6': {'class_type': 'LoadImage', 'inputs': {'image': n}},
                  '3': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['6', 0], 'vae': ['2', 0]}},
                  '4': {'class_type': 'VAEDecode', 'inputs': {'samples': ['3', 0], 'vae': ['2', 0]}},
                  '9': {'class_type': 'SaveImage', 'inputs': {'images': ['4', 0], 'filename_prefix': 'memprobe/v'}}}
        elif w == 'usdu_nocn':
            wf = usdu_wf(n, False, 11 + i)
        elif w == 'usdu_cn':
            wf = usdu_wf(n, True, 11 + i)
        elif w.startswith('usdu_cn_t'):
            tl = int(w.split('_t')[1].split('_')[0])
            pd = int(w.split('_p')[1].split('_')[0]) if '_p' in w else 128
            wf = usdu_wf(n, True, 11 + i, tile=tl, pad=pd, tiled=w.endswith('_td'))
        elif w == 'usdu_cn_pad0':
            wf = usdu_wf(n, True, 11 + i, tile=1024, pad=0)
        probe(w, wf)

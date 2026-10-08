"""Reproduce the host-RAM spike of an SDXL VAE encode/decode in ComfyUI's own code, outside the server.
usage: venv python vaeprobe.py <size> [comfy args...]   (run from anywhere)"""
import os, sys, threading, time
import psutil
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
size = int(sys.argv[1]); sys.argv = [sys.argv[0]] + sys.argv[2:]
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
FRAC = float(os.environ.get('SRO_VRAM_FRACTION', '0.6'))
torch.cuda.set_per_process_memory_fraction(FRAC, 0)
import comfy.sd, comfy.utils, comfy.model_management as mm

P = psutil.Process(os.getpid())
peak = [0]; stop = threading.Event(); low = [99.0]


def watch():
    while not stop.is_set():
        peak[0] = max(peak[0], P.memory_info().private)
        low[0] = min(low[0], psutil.virtual_memory().available / 2 ** 30)
        time.sleep(0.02)


threading.Thread(target=watch, daemon=True).start()


def rep(tag, t0=None):
    torch.cuda.synchronize()
    print(f'{tag:34s} private now {P.memory_info().private / 2**30:5.2f} GB, peak {peak[0] / 2**30:5.2f} GB, '
          f'sys avail min {low[0]:5.2f} GB, gpu alloc peak {torch.cuda.max_memory_allocated() / 2**30:5.2f} GB'
          + (f', {time.time() - t0:5.1f} s' if t0 else ''))
    peak[0] = P.memory_info().private; torch.cuda.reset_peak_memory_stats()


rep('start')
sd = comfy.utils.load_torch_file('models/vae/sdxl_vae_fp16_fix.safetensors')
vae = comfy.sd.VAE(sd=sd); rep('vae loaded')
img = torch.rand(1, size, size, 3)
print('cudnn/miopen enabled:', torch.backends.cudnn.enabled, 'cap GB', round(FRAC * torch.cuda.get_device_properties(0).total_memory / 2**30, 1))
for i in range(2):
    t = time.time(); lat = vae.encode(img); rep(f'encode {size} #{i}', t)
    t = time.time(); out = vae.decode(lat); rep(f'decode {size} #{i}', t)
    if psutil.virtual_memory().available < 2 * 2**30: print('LOW RAM, stop'); break
stop.set()

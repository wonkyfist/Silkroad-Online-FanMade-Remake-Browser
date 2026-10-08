"""Per-module GPU memory of the SDXL VAE decoder in ComfyUI on this stack (capped)."""
import os, sys, time
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
size = int(sys.argv[1]); sys.argv = [sys.argv[0]] + sys.argv[2:]
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
torch.cuda.set_per_process_memory_fraction(0.6, 0)
import comfy.sd, comfy.utils, comfy.model_management as mm
G = 2 ** 30
vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file('models/vae/sdxl_vae_fp16_fix.safetensors'))
print('vae dtype', vae.vae_dtype, 'device', vae.device, 'cudnn', torch.backends.cudnn.enabled)
dec = vae.first_stage_model.decoder
rows = []
def mk(name):
    def pre(m, a):
        torch.cuda.synchronize(); m._a0 = torch.cuda.memory_allocated(); torch.cuda.reset_peak_memory_stats()
    def post(m, a, o):
        torch.cuda.synchronize()
        rows.append((name, type(m).__name__, tuple(o.shape) if torch.is_tensor(o) else '-', (torch.cuda.max_memory_allocated() - m._a0) / G, (torch.cuda.memory_allocated() - m._a0) / G))
    return pre, post
for name, m in dec.named_modules():
    if name.count('.') <= 2 and name:
        p, q = mk(name); m.register_forward_pre_hook(p); m.register_forward_hook(q)
lat = vae.encode(torch.rand(1, size, size, 3))
torch.cuda.synchronize(); print('allocated before decode', round(torch.cuda.memory_allocated() / G, 2))
out = vae.decode(lat)
for r in rows:
    if r[3] > 0.15: print(f'{r[0]:28s} {r[1]:16s} out {str(r[2]):22s} peak +{r[3]:5.2f} GB, kept +{r[4]:5.2f} GB')
print('allocated after decode', round(torch.cuda.memory_allocated() / G, 2))

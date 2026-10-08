"""Does ComfyUI's VAE retain GPU memory between calls on this ROCm/Windows stack? (capped: no spill possible)"""
import os, sys, time, gc
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
size = int(sys.argv[1]); n = int(sys.argv[2]); sys.argv = [sys.argv[0]] + sys.argv[3:]
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
torch.cuda.set_per_process_memory_fraction(float(os.environ.get('SRO_VRAM_FRACTION', '0.6')), 0)
import comfy.sd, comfy.utils, comfy.model_management as mm
G = 2 ** 30
vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file('models/vae/sdxl_vae_fp16_fix.safetensors'))
img = torch.rand(1, size, size, 3)
for i in range(n):
    torch.cuda.reset_peak_memory_stats()
    t = time.time(); lat = vae.encode(img); te = time.time() - t
    pe = torch.cuda.max_memory_allocated() / G; ae = torch.cuda.memory_allocated() / G
    torch.cuda.reset_peak_memory_stats()
    t = time.time(); out = vae.decode(lat); td = time.time() - t
    pd = torch.cuda.max_memory_allocated() / G; ad = torch.cuda.memory_allocated() / G
    print(f'{i}: enc {te:4.1f}s peak {pe:5.2f} after {ae:5.2f} | dec {td:4.1f}s peak {pd:5.2f} after {ad:5.2f} | reserved {torch.cuda.memory_reserved()/G:5.2f} GB', flush=True)

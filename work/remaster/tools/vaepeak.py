"""True SDXL-VAE GPU peak in ComfyUI code under inference_mode (as the server runs it). Capped: cannot spill."""
import os, sys, time
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
sizes = [int(x) for x in sys.argv[1].split(',')]; sys.argv = [sys.argv[0]] + sys.argv[2:]
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
torch.cuda.set_per_process_memory_fraction(float(os.environ.get('SRO_VRAM_FRACTION', '0.6')), 0)
import comfy.sd, comfy.utils
G = 2 ** 30
vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file('models/vae/sdxl_vae_fp16_fix.safetensors'))
with torch.inference_mode():
    for s in sizes:
        for i in range(2):
            torch.cuda.reset_peak_memory_stats(); t = time.time(); lat = vae.encode(torch.rand(1, s, s, 3)); te = time.time() - t; pe = torch.cuda.max_memory_allocated() / G
            torch.cuda.reset_peak_memory_stats(); t = time.time(); out = vae.decode(lat); td = time.time() - t; pd = torch.cuda.max_memory_allocated() / G
            print(f'{s}: enc {te:4.1f}s peak {pe:5.2f} GB | dec {td:4.1f}s peak {pd:5.2f} GB | after {torch.cuda.memory_allocated()/G:4.2f} GB', flush=True)

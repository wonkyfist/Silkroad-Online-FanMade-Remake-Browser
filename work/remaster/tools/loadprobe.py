"""Measure CPU/GPU memory while ComfyUI loads the SDXL checkpoint + ControlNet, with or without the
'load large safetensors straight to GPU' patch that launch_capped.py applies. In-process guard: exits if system
available RAM < 1.5 GB.  usage: venv python loadprobe.py [patch|nopatch]"""
import os, sys, threading, time
import psutil
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
mode = sys.argv[1] if len(sys.argv) > 1 else 'patch'
sys.argv = [sys.argv[0], '--highvram', '--disable-pinned-memory', '--use-quad-cross-attention', '--fp16-vae']
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
torch.cuda.set_per_process_memory_fraction(0.80, 0)
G = 2 ** 30; P = psutil.Process(os.getpid()); stat = dict(priv=0, ws=0, low=99.0)


def guard():
    while True:
        mi = P.memory_info(); av = psutil.virtual_memory().available / G
        stat['priv'] = max(stat['priv'], mi.private / G); stat['ws'] = max(stat['ws'], mi.rss / G); stat['low'] = min(stat['low'], av)
        if av < 1.5:
            print('GUARD: available', round(av, 2), 'GB -> exit', flush=True); os._exit(3)
        time.sleep(0.05)


threading.Thread(target=guard, daemon=True).start()
import comfy.utils
if mode == 'patch':
    sys.path.insert(0, os.path.abspath(os.path.join(CUI, '..')))
    import sro_patches; sro_patches.apply()
import comfy.sd, comfy.controlnet, folder_paths


def rep(tag, t0):
    torch.cuda.synchronize()
    print(f'{tag:22s} {time.time() - t0:5.1f}s  peak private {stat["priv"]:5.2f} GB, peak WS {stat["ws"]:5.2f} GB, '
          f'min avail {stat["low"]:5.2f} GB, GPU alloc {torch.cuda.memory_allocated() / G:5.2f} GB (peak {torch.cuda.max_memory_allocated() / G:5.2f})', flush=True)
    stat.update(priv=0, ws=0, low=99.0); torch.cuda.reset_peak_memory_stats()


t = time.time()
out = comfy.sd.load_checkpoint_guess_config(folder_paths.get_full_path('checkpoints', 'sd_xl_base_1.0.safetensors'),
                                            output_vae=False, output_clip=True, embedding_directory=None)
rep('checkpoint', t)
t = time.time()
cn = comfy.controlnet.load_controlnet(folder_paths.get_full_path('controlnet', 'controlnet-tile-sdxl-1.0.safetensors'))
rep('controlnet', t)
print('private now', round(P.memory_info().private / G, 2), 'GB')

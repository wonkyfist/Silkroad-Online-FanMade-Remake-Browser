import os, sys, gc
CUI = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'comfyui', 'ComfyUI')
sys.argv = [sys.argv[0]] + sys.argv[1:]
sys.path.insert(0, os.path.abspath(CUI)); os.chdir(CUI)
import comfy.options; comfy.options.enable_args_parsing()
import torch
torch.cuda.set_per_process_memory_fraction(0.6, 0)
import comfy.sd, comfy.utils
G = 2 ** 30
vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file('models/vae/sdxl_vae_fp16_fix.safetensors'))
lat = vae.encode(torch.rand(1, 512, 512, 3)); out = vae.decode(lat)
gc.collect(); torch.cuda.synchronize()
tot = 0; big = []
for o in gc.get_objects():
    try:
        if torch.is_tensor(o) and o.is_cuda:
            n = o.untyped_storage().nbytes(); tot += n
            if n > 50e6: big.append((n / G, tuple(o.shape), o.dtype))
    except Exception:
        pass
print('allocated', round(torch.cuda.memory_allocated() / G, 2), 'GB; live cuda tensors', round(tot / G, 2), 'GB; big:', big[:10])
st = torch.cuda.memory_stats()
print({k: round(v / G, 2) for k, v in st.items() if k.startswith(('allocated_bytes.all.current', 'reserved_bytes.all.current', 'active_bytes.all.current', 'requested_bytes.all.current'))})
print('blas env', {k: v for k, v in os.environ.items() if 'BLAS' in k or 'HIP' in k or 'ALLOC' in k})
print('preferred blas', torch.backends.cuda.preferred_blas_library())
import types
ts = [o for o in gc.get_objects() if torch.is_tensor(o) and o.is_cuda and o.untyped_storage().nbytes() > 100e6]
print('n big', len(ts))
for t in ts[:2]:
    for r in gc.get_referrers(t):
        if r is ts: continue
        if isinstance(r, types.FrameType):
            print('FRAME', r.f_code.co_name, r.f_code.co_filename[-60:], r.f_lineno, [k for k, v in r.f_locals.items() if v is t])
            f = r.f_back; d = 0
            while f is not None and d < 6:
                print('   <-', f.f_code.co_name, f.f_code.co_filename[-50:], f.f_lineno); f = f.f_back; d += 1
            gen = [g for g in gc.get_referrers(r) if not isinstance(g, types.FrameType)]
            print('   frame owners', [type(g).__name__ for g in gen][:5])
        elif isinstance(r, dict) and r.get('t') is t:
            pass
        else:
            print('REF', type(r).__name__, len(r) if hasattr(r, '__len__') else '')
del ts

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
t = ts[0]; ids = {id(ts)}
def show(o, depth, seen):
    if depth > 5 or id(o) in seen: return
    seen.add(id(o))
    for r in gc.get_referrers(o):
        if id(r) in ids or r is seen or isinstance(r, types.FrameType): continue
        if isinstance(r, dict) and ('__name__' in r and r.get('__name__') == '__main__'): continue
        d = ''
        if isinstance(r, dict): d = 'keys=' + str([k for k in list(r.keys())[:6]])
        elif isinstance(r, (list, tuple)): d = 'len=%d' % len(r)
        else: d = str(type(r))[:80] + ' ' + str(getattr(r, '__qualname__', ''))[:60]
        print('  ' * depth + type(r).__name__, d)
        if isinstance(r, (list, tuple, dict)) or type(r).__name__ in ('cell', 'method', 'function'):
            show(r, depth + 1, seen)
show(t, 0, set())

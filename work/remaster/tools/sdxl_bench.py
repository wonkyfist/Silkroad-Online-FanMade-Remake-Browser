"""Timing probe for the SDXL + ControlNet-Tile USDU workflow on this GPU (used to pick ComfyUI's attention flags).
usage: python sdxl_bench.py <input.png> <upscale_by> <tag> [denoise] [steps] [seam_fix]
"""
import json, sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
import comfy_api as C
from PIL import Image

inp, up, tag = sys.argv[1], float(sys.argv[2]), sys.argv[3]
den = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
steps = int(sys.argv[5]) if len(sys.argv) > 5 else 24
seam = sys.argv[6] if len(sys.argv) > 6 else 'None'
C.wait_alive()
name = C.upload(inp, 'bench_' + os.path.basename(inp))
wf = {
 '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'sd_xl_base_1.0.safetensors'}},
 '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'sdxl_vae_fp16_fix.safetensors'}},
 '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': 'hand-painted fantasy game texture, riveted leather armour plates, hammered iron, woven linen, flat lighting'}},
 '4': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': 'blurry, text, watermark, harsh shadows, specular highlights'}},
 '5': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': 'controlnet-tile-sdxl-1.0.safetensors'}},
 '6': {'class_type': 'LoadImage', 'inputs': {'image': name}},
 '7': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': ['3', 0], 'negative': ['4', 0], 'control_net': ['5', 0], 'image': ['6', 0], 'strength': 0.8, 'start_percent': 0.0, 'end_percent': 0.85, 'vae': ['2', 0]}},
 '8': {'class_type': 'UltimateSDUpscaleCustomSample', 'inputs': {
     'image': ['6', 0], 'model': ['1', 0], 'positive': ['7', 0], 'negative': ['7', 1], 'vae': ['2', 0], 'upscale_by': up, 'seed': sum(map(ord, tag)),
     'steps': steps, 'cfg': 5.0, 'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': den, 'mode_type': 'Linear',
     'tile_width': 1024, 'tile_height': 1024, 'mask_blur': 16, 'tile_padding': 96, 'seam_fix_mode': seam, 'seam_fix_denoise': 0.25,
     'seam_fix_width': 64, 'seam_fix_mask_blur': 16, 'seam_fix_padding': 32, 'force_uniform_tiles': True, 'tiled_decode': False, 'batch_size': 1}},
 '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': 'bench/' + tag}},
}
imgs, dt = C.run(wf, '9')
print(json.dumps({'tag': tag, 'seconds': round(dt, 1), 'size': imgs[0].size, 'denoise': den, 'steps': steps, 'seam': seam}))

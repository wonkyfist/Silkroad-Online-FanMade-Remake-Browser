"""Run ComfyUI jobs robustly on this shared 16 GB PC.

* waits until the system has >= MIN_AVAIL GB of available RAM before starting the server or a job;
* starts ComfyUI with work/tools/comfyui/start_comfyui.sh (VRAM cap, no-mmap loader, RAM watchdog) if it is not up;
* if a job fails because the watchdog interrupted/killed the server (another process used the RAM), waits for RAM
  to recover, restarts the server and retries (up to RETRIES times);
* stop() shuts the server down.
Import and call run(fn, *args) with fn a callable that talks to ComfyUI through comfy_api.
"""
import os
import subprocess
import sys
import time

import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
import comfy_api as C  # noqa: E402

CUI = os.path.join(ROOT, 'work', 'tools', 'comfyui')
BASH = r'C:\Program Files\Git\bin\bash.exe'
MIN_AVAIL = float(os.environ.get('SRO_MIN_AVAIL_GB', '1.5'))
RETRIES = 4
G = 2 ** 30


def log(*a):
    print('[gpu_jobs]', time.strftime('%H:%M:%S'), *a, flush=True)


def wait_ram(need=MIN_AVAIL, stable_s=15, timeout=3600):
    t0 = time.time(); ok_since = None
    while time.time() - t0 < timeout:
        av = psutil.virtual_memory().available / G
        if av >= need:
            ok_since = ok_since or time.time()
            if time.time() - ok_since >= stable_s:
                return av
        else:
            if ok_since is not None or int(time.time() - t0) % 60 < 3:
                log(f'waiting for RAM: {av:.1f} GB available, need {need}')
            ok_since = None
        time.sleep(3)
    raise TimeoutError('RAM did not recover')


def start():
    if C.alive():
        return
    wait_ram()
    logf = open(os.path.join(CUI, 'logs', 'server_%s.log' % time.strftime('%H%M%S')), 'w')
    subprocess.Popen([BASH, os.path.join(CUI, 'start_comfyui.sh')], stdout=logf, stderr=subprocess.STDOUT,
                     creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    C.wait_alive(300)
    log('ComfyUI up')


def stop():
    subprocess.run([BASH, os.path.join(CUI, 'stop_comfyui.sh')], capture_output=True)


def run(fn, *a, **kw):
    for attempt in range(RETRIES):
        start()
        wait_ram(0.8, stable_s=5)                   # the server itself holds ~1.5-3.5 GB once loaded
        try:
            return fn(*a, **kw)
        except Exception as e:  # interrupted / killed by the watchdog, or a transient server error
            msg = str(e)[:300]
            log(f'attempt {attempt + 1} failed: {msg}')
            if C.alive() and 'execution error: []' not in msg and 'Processing interrupted' not in msg:
                raise
            time.sleep(5)
            if not C.alive():
                log('server gone (watchdog kill?) - waiting for RAM, restarting')
    raise RuntimeError('job failed after %d attempts' % RETRIES)

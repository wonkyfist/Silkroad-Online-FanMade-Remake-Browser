/** English strings of the graphics device loss recovery (gpu-loss.ts). Spread into en.ts. */
export const enGpu = {
  'gpu.restoring': 'The graphics device was reset. Restoring the 3D view...',
  'gpu.reloading': 'The graphics device stopped responding (a driver reset or out of video memory). Reloading the game; you will be back where you were in a few seconds.',
  'gpu.reloadingWebgl': 'The graphics device stopped responding again. Reloading the game in compatibility mode (WebGL2) for this tab.',
  'gpu.stopped': 'The graphics device keeps failing. Close other tabs that use the GPU or update the graphics driver, then reload.',
  'gpu.reload': 'Reload',
  'gpu.restored': 'The graphics device was reset, so the game reloaded. You are back where you were.',
} satisfies Record<string, string>

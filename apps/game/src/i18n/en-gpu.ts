/**
 * English strings of the graphics recovery: device loss (gpu-loss.ts), black output (gpu-watchdog.ts), the "3D view is
 * black" help (gpu-help.ts) and Options → Graphics → Graphics mode. Spread into en.ts.
 */
export const enGpu = {
  'gpu.restoring': 'The graphics device was reset. Restoring the 3D view...',
  'gpu.reloading': 'The graphics device stopped responding (a driver reset or out of video memory). Reloading the game; you will be back where you were in a few seconds.',
  'gpu.reloadingWebgl': 'The graphics device stopped responding (a driver reset or out of video memory). Reloading the game in compatibility mode (WebGL2) for this tab; you will be back where you were in a few seconds.',
  'gpu.stopped': 'The graphics device keeps failing. Close other tabs that use the GPU or update the graphics driver, then reload.',
  'gpu.reload': 'Reload',
  'gpu.restored': 'The graphics device was reset, so the game reloaded. You are back where you were.',
  'gpu.blackWebgl': 'The 3D view is not reaching the screen. Reloading the game in compatibility mode (WebGL2) for this tab; you will be back where you were in a few seconds.',
  'gpu.blackRestored': 'The 3D view was not reaching the screen, so the game reloaded in compatibility mode (WebGL2). You are back where you were.',
  'gpu.modeApplied': 'The game reloaded with the new graphics mode. You are back where you were.',
  'gpu.reloaded': 'The game reloaded. You are back where you were.',
  // The "3D view is black" help (gpu-help.ts).
  'gpu.help.title': 'The 3D view is black',
  'gpu.help.intro': 'If the 3D view stays black while windows and text still show, the browser has stopped showing 3D content. This happens after its graphics process crashed, for example when the computer ran low on memory with other graphics-heavy programs open. The game itself is fine.',
  'gpu.help.detected': 'The browser has stopped showing the game\'s 3D picture. This happens after its graphics process crashed, for example when the computer ran low on memory with other graphics-heavy programs open. The game itself is fine.',
  'gpu.help.fixBrowser': 'Fix 1: open the game in another browser, such as Microsoft Edge.',
  'gpu.help.fixGpuProcess': 'Fix 2 (Chrome): press Shift+Esc to open Chrome\'s Task Manager, select "GPU Process", click "End process", then reload this page. Your other tabs stay open.',
  'gpu.help.fixCompatibility': 'You can also try the compatibility mode (WebGL2) for this tab.',
  'gpu.help.compatibility': 'Compatibility mode',
  'gpu.help.close': 'Close',
  'gpu.help.link': 'Screen black?',
  'menu.blackScreen': 'Screen black?',
  // Options → Graphics → Graphics mode.
  'options.backend': 'Graphics mode',
  'options.backend.auto': 'Automatic',
  'options.backend.webgpu': 'WebGPU',
  'options.backend.webgl2': 'WebGL2 (compatibility)',
  'options.backend.ask': 'The graphics mode changes after a reload. Reload now?',
  'options.backend.reloadNow': 'Reload now',
  'options.backend.later': 'Later',
  'options.backend.pending': 'The new graphics mode applies after a reload.',
  'options.backend.fallback': 'This tab runs WebGL2 after a graphics problem. Choosing a mode here applies on the next load.',
} satisfies Record<string, string>

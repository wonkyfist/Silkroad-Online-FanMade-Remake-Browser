/**
 * English strings of wave 9's renderer options (docs/WAVE_PLAN3.md D11: preset Ultra, Advanced, tone mapping), owned
 * by GAME. Spread into en.ts: only that lane edits this file. en.ts keys win over a duplicate here.
 */
export const enRender = {
  // Options → Graphics: the preset (settings.ts graphics.preset; Low is the Classic look once the new one is on)
  'options.quality.lowClassic': 'Low (Classic)',
  'options.quality.ultra': 'Ultra',
  // Options → Graphics, under the Sky row: Low (Classic) + Classic sky + Weather off (settings.ts classicLook)
  'options.classicLook': 'Low with the Classic sky and weather off is the original look: always noon, always clear. Choose a weather level or the Modern sky for day and night.',
  // The preview gate (rollout.ts): settings.ts graphics.modern and the first-run recommendation
  'options.modern': 'Modern graphics (preview)',
  'options.modern.recommended': 'Recommended for this computer: {preset}',
  'options.modern.why.webgl': 'this browser has no WebGPU',
  'options.modern.why.integrated': 'integrated graphics',
  'options.modern.why.apple': 'Apple graphics',
  'options.modern.why.apple-pro': 'Apple Pro/Max graphics',
  'options.modern.why.discrete': 'a dedicated graphics card',
  'options.modern.why.varyings': 'a limited graphics driver',
  'options.rebuild.confirm': 'Switching between the Classic look and the modern graphics rebuilds the world around you. It takes a few seconds. Continue?',
  'options.rebuild.title': 'Graphics',
  // Options → Graphics → Advanced (settings.ts graphics.advanced; 'Auto' = the preset's choice)
  'options.advanced': 'Advanced (Auto = the preset)',
  'options.advanced.shadows': 'Sun shadows',
  'options.advanced.shadows.auto': 'Auto',
  'options.advanced.shadows.off': 'Off',
  'options.advanced.shadows.medium': 'Medium',
  'options.advanced.shadows.high': 'High',
  'options.advanced.shadows.ultra': 'Ultra',
  'options.advanced.ao': 'Ambient occlusion',
  'options.advanced.ao.auto': 'Auto',
  'options.advanced.ao.off': 'Off',
  'options.advanced.ao.half': 'Half resolution',
  'options.advanced.ao.full': 'Full resolution',
  'options.advanced.reflections': 'Reflections',
  'options.advanced.reflections.auto': 'Auto',
  'options.advanced.reflections.off': 'Off',
  'options.advanced.reflections.puddles': 'Puddles',
  'options.advanced.reflections.always': 'Always',
  'options.advanced.aa': 'Anti-aliasing',
  'options.advanced.aa.auto': 'Auto',
  'options.advanced.aa.msaa': 'MSAA x4',
  'options.advanced.aa.fxaa': 'FXAA',
  'options.advanced.aa.taa': 'TAA',
  'options.advanced.toneMap': 'Tone mapping',
  'options.advanced.toneMap.neutral': 'Neutral',
  'options.advanced.toneMap.filmic': 'Filmic',
  // Options → Graphics → Bloom (render/quality.ts BLOOM_LOOKS)
  'options.bloom': 'Bloom',
  'options.bloom.off': 'Off',
  'options.bloom.subtle': 'Subtle',
  'options.bloom.strong': 'Strong',
  // Wave 10 (docs/WAVE_PLAN6.md §4.2): Options → Graphics → Grass (the scatter row) and Wildlife; Advanced → World
  // batching (settings.ts graphics.wildlife, graphics.advanced.batching)
  'options.grass': 'Grass',
  'options.wildlife': 'Wildlife',
  'options.wildlife.on': 'On',
  'options.wildlife.off': 'Off',
  // CHARACTERS §16.2: the licensed characters' springs (settings.ts graphics.hairCloth, graphics.bodyPhysics)
  'options.hairCloth': 'Hair & cloth physics',
  'options.bodyPhysics': 'Body physics',
  // Wave 11 (docs/TOWN_LIFE.md §8.2): Options → Graphics → Town life (settings.ts graphics.townLife)
  'options.townLife': 'Town life',
  'options.townLife.auto': 'Auto',
  'options.townLife.off': 'Off',
  'options.townLife.low': 'Low',
  'options.townLife.full': 'Full',
  // Wave 12 (docs/TREES.md Part W, WAVE_PLAN8 D9): Options → Graphics → Trees (settings.ts graphics.trees)
  'options.trees': 'Trees',
  'options.trees.new': 'New',
  'options.trees.retail': 'Retail',
  'options.advanced.batching': 'World batching',
  'options.advanced.batching.on': 'On',
  'options.advanced.batching.off': 'Off',
  'options.advanced.lightShafts': 'Volumetric light',
  'options.advanced.lightShafts.auto': 'Auto',
  'options.advanced.lightShafts.off': 'Off',
  'options.advanced.lightShafts.low': 'Low',
  'options.advanced.lightShafts.high': 'High',
  // The world screen: the frame-time watchdog (RENDER §10) and a path switch a whole-world load cannot rebuild
  'render.watchdog': 'The game was running slowly, so the graphics quality went down to {preset}. Options → Graphics changes it back.',
  'render.reenter': 'The new graphics apply the next time you enter the world.',
  // PERF2: the loading picture while the world's shaders are prepared (world entry, a graphics switch; screens/warmup.ts)
  'render.warmup': 'Preparing the graphics...',
  // The FPS line (hud/perf-overlay.ts): the material path and preset, the GPU frame time, the weather
  'world.statsRender': '{mode} {preset}',
  'world.statsGpu': '  |  GPU {ms} ms',
  'world.statsWeather': '  |  weather {level}: rain {rain}, wet {wet}',
  'world.statsPbr': 'PBR',
  'world.statsClassic': 'Classic',
} satisfies Record<string, string>

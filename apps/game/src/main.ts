import { App } from './app.ts'
import { GameAudio, setGameAudio } from './audio/index.ts'
import { installUiSounds } from './audio/ui-sounds.ts'
import { loadCatalog } from './content/catalog.ts'
import { createEngine, gpuLimitsParam } from './engine.ts'
import { engineChoice, installGpuLossGuard, setBootedEngine, webglAfterLoss } from './gpu-loss.ts'
import { installBlackWatchdog } from './gpu-watchdog.ts'
import { resumeSession } from './net/resume.ts'
import { createTransport } from './net/transport.ts'
import { readParams } from './params.ts'
import { charCreateScreen } from './screens/charcreate.ts'
import { creatorScreen } from './screens/creator.ts'
import { charSelectScreen } from './screens/charselect.ts'
import { loginScreen } from './screens/login.ts'
import { serversScreen } from './screens/servers.ts'
import { splashScreen } from './screens/splash.ts'
import { worldScreen } from './screens/world.ts'
import { applyGraphics, settings } from './settings.ts'
import { loadGameText, t } from './i18n/index.ts'
import { Art } from './ui/art.ts'
import { el } from './ui/dom.ts'
import { loadFonts } from './ui/fonts.ts'

async function main(): Promise<void> {
  const params = readParams()
  const boot = el('div', 'boot', t('boot.loading'))
  document.body.append(boot)

  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  // The engine (gpu-loss.ts engineChoice): ?engine=webgl, Options → Graphics mode, this tab's WebGL2 fallback after a
  // lost WebGPU device or black output, else WebGPU ('auto' skips a software adapter).
  const backend = settings.get().graphics.backend
  const choice = engineChoice(params.webgl, backend, webglAfterLoss())
  const [engineResult, catalog, art] = await Promise.all([createEngine(canvas, choice.webgpu, gpuLimitsParam(), choice.avoidSoftware), loadCatalog(), Art.load(), loadGameText()])
  if (choice.why === 'fallback') engineResult.note = 'WebGPU off for this tab after a graphics device loss or black output'
  else if (choice.why === 'setting' && !choice.webgpu) engineResult.note = 'WebGPU off by Options → Graphics mode'
  setBootedEngine({ kind: engineResult.kind, backend, why: choice.why })
  // Options → Graphics → Resolution (UX_GAPS R4), now and on every change.
  applyGraphics(engineResult.engine)
  const fonts = await loadFonts(art.manifest)
  if (engineResult.note) console.info(`[engine] ${engineResult.note}`)
  console.info(`[engine] ${engineResult.kind}; characters from ${catalog.source} (${catalog.characters.length}); ui art ${art.manifest ? 'loaded' : 'missing'}; fonts ${Object.entries(fonts).map(([k, ok]) => `${k}:${ok ? 'ok' : 'fallback'}`).join(' ')}`)

  // Sound (docs/SOUND.md §5): music, effects and their settings; `?mute=1` mutes this page only.
  const audio = GameAudio.create({ muted: params.mute, itemDef: code => catalog.item(code) })
  setGameAudio(audio)
  installUiSounds(cue => audio.ui(cue))
  const transport = createTransport(params.mock, params.gm)
  const app = new App(engineResult.engine, engineResult.kind, params, transport, catalog, art, audio.music!, audio)
  // A lost graphics device reloads straight back into the world instead of leaving it black (gpu-loss.ts).
  const gpuGuard = installGpuLossGuard(app, engineResult.kind)
  // A 3D view that renders nothing without a loss: WebGL2 once per tab, then the help (gpu-watchdog.ts).
  installBlackWatchdog(app.engine, detail => gpuGuard.blackOutput(detail))
  app.register('splash', splashScreen)
  app.register('login', loginScreen)
  app.register('servers', serversScreen)
  app.register('charselect', charSelectScreen)
  app.register('charcreate', charCreateScreen)
  app.register('creator', creatorScreen)
  app.register('world', worldScreen)

  // The corner: the master mute (localStorage['sro.muted']). The engine name is in the world's stats line and the log.
  const corner = el('div', 'corner')
  const mute = el('button', 'mute-button')
  mute.type = 'button'
  mute.title = t('corner.soundTitle')
  mute.dataset.sfx = 'none'
  const setMuteLabel = (m: boolean) => {
    mute.textContent = m ? t('corner.soundOff') : t('corner.soundOn')
    mute.classList.toggle('muted', m)
  }
  setMuteLabel(audio.settings.muted)
  audio.settings.onChange((_, m) => setMuteLabel(m))
  mute.addEventListener('click', () => audio.settings.toggleMuted())
  corner.append(mute)
  document.body.append(corner)

  // ?kit=1: the UI kit gallery (dev only, docs/UI.md §9.1 UI-K) instead of the game.
  if (params.kit) {
    boot.remove()
    const { showKitGallery } = await import('./ui/kit/gallery.ts')
    return showKitGallery(app)
  }

  if (params.fxlab) await import('./debug/fx-lab.ts').then(m => m.installFxLab(app), err => console.error('[fxlab] failed to load', err))
  if (params.charbench) await import('./debug/charbench.ts').then(m => m.installCharBench(app), err => console.error('[charbench] failed to load', err))
  if (params.rarelab) await import('./debug/rarity-lab.ts').then(m => m.installRarityLab(app), err => console.error('[rarelab] failed to load', err))
  // A refresh keeps you logged in: the tab's saved token goes straight to character select (UX_GAPS L1).
  const resumed = await resumeSession(app).catch(err => {
    console.warn('[resume] failed', err)
    return false
  })
  boot.remove()
  if (resumed) return
  await app.go(params.skipSplash ? 'login' : 'splash')
}

main().catch(err => {
  console.error(err)
  document.body.append(el('pre', 'fatal', t('boot.failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) })))
})

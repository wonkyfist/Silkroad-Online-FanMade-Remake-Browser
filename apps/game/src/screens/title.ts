/** The backdrop shared by the login and server-select screens: a slow flyover of the plaza. */
import type { ArcRotateCamera, Observer, Scene } from '@babylonjs/core'
import type { App, OwnedScene } from '../app.ts'
import { buildPlaza } from '../three/backdrop.ts'

export interface TitleScene extends OwnedScene {
  camera: ArcRotateCamera
}

export function titleScene(app: App): TitleScene {
  return app.useScene('title', () => {
    const { scene, camera } = buildPlaza(app.engine)
    camera.radius = 24
    camera.beta = 1.2
    camera.target.set(0, 2.5, -2)
    const t0 = performance.now()
    const obs: Observer<Scene> | null = scene.onBeforeRenderObservable.add(() => {
      const t = (performance.now() - t0) / 1000
      camera.alpha = Math.PI / 2 + Math.sin(t * 0.05) * 0.9
      camera.beta = 1.18 + Math.sin(t * 0.07) * 0.08
      camera.radius = 22 + Math.sin(t * 0.04) * 3
    })
    return {
      kind: 'title',
      scene,
      camera,
      dispose() {
        scene.onBeforeRenderObservable.remove(obs)
        scene.dispose()
      },
    }
  })
}

/**
 * The Climb on the client (docs/CLIMB.md §2.5, §11; layers L2 and L7): the mini-bosses' look and the rewards' state.
 *
 * - **The bosses' look**: each mini-boss reuses its base's retail model at its `size` (the shared derived MobDef's
 *   scale), painted per mesh by the ice-look plugin (world/winter/ice-look.ts, as the siege's Warlord) with its own ramp,
 *   so the ordinary monsters that share the material are untouched. The name plate is the unique one (variant 'unique').
 * - **The rewards' state**: the `climb` message (titles owned and worn, the Arts picked) into hud/climb-state.ts, which
 *   the character and skill windows read.
 */
import { climbBossOf, type ClimbBoss } from '@sro/shared'
import { lookAttachment, type IceLook } from '../winter/ice-look.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { climbState } from '../../hud/climb-state.ts'

/** Per look: a champion keeps its hue and gets a gold edge, a giant turns to grey stone with a red glow, the Canyon Lord is earth and ember. */
export const CLIMB_BOSS_LOOKS: Readonly<Record<ClimbBoss['look'], IceLook>> = {
  champion: { amount: 0.55, dark: [0.05, 0.03, 0.02], light: [0.55, 0.36, 0.12], gain: 2.4, fur: 0, glow: 0.4, rim: [1, 0.72, 0.25], rimPower: 3, rimGain: 0.3 },
  giant: { amount: 0.8, dark: [0.03, 0.03, 0.035], light: [0.36, 0.34, 0.33], gain: 2.6, fur: 0, glow: 0.6, rim: [0.9, 0.2, 0.08], rimPower: 2.6, rimGain: 0.35 },
  lord: { amount: 0.85, dark: [0.03, 0.012, 0.004], light: [0.62, 0.3, 0.06], gain: 2.8, fur: 0, glow: 0.8, rim: [1, 0.45, 0.08], rimPower: 2.4, rimGain: 0.45 },
}

/** The look of a mob code (undefined for every monster but a mini-boss). */
export function climbBossLook(code: string): IceLook | undefined {
  const b = climbBossOf(code)
  return b ? CLIMB_BOSS_LOOKS[b.look] : undefined
}

export function climbFeature(ctx: WorldFeatureContext): WorldFeature {
  const offs: (() => void)[] = []
  offs.push(
    ctx.addAttachment((v) => {
      if (v.kind !== 'mob') return null
      const look = climbBossLook(v.state.model)
      return look ? lookAttachment(v, look) : null
    }),
  )
  return {
    onMessage(msg) {
      if (msg.t === 'climb') climbState.set(msg)
    },
    dispose() {
      for (const off of offs) off()
      climbState.reset()
    },
  }
}

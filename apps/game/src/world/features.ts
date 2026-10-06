/**
 * World features: how the wave lanes plug into the world screen without editing it (docs/WAVE_PLAN.md §3.2).
 * The world screen builds one WorldFeatureContext once the HUD exists, runs every factory in WORLD_FEATURES, and
 * calls the hooks below from its own code paths. Every hook call is isolated: a feature that throws is logged and
 * the world carries on. Lanes fill their own `world/features/<lane>.ts`; only W3-FC/W4-FC edit the list.
 */
import type { ArcRotateCamera, Scene } from '@babylonjs/core'
import type { ClientMessage, ServerMessage } from '@sro/shared'
import type { App } from '../app.ts'
import type { Hud } from '../hud/index.ts'
import type { KeyMap } from '../hud/keys.ts'
import type { Session } from '../net/session.ts'
import type { ActorMaterialDecorator } from '../three/models.ts'
import type { ChatBox } from './chat.ts'
import type { EntityAttachmentFactory, EntityView } from './entities.ts'
import type { JanganGround } from './jangan/ground.ts'
import type { HudMinimap } from './jangan/minimap.ts'
import { alchemyFeature } from './features/alchemy.ts'
import { autoPotionFeature } from './features/auto-potion.ts'
import { berserkFeature } from './features/berserk.ts'
import { coastFeature } from './features/coast.ts'
import { durabilityFeature } from './features/durability.ts'
import { editorsFeature } from './features/editors.ts'
import { fxWorldFeature } from './features/fx-world.ts'
import { guildFeature } from './features/guild.ts'
import { mapFeature } from './features/map.ts'
import { mountFeature } from './features/mount.ts'
import { movementFeature } from './features/movement.ts'
import { npcFeature } from './features/npc.ts'
import { partyFeature } from './features/party.ts'
import { pilotFeature } from './features/pilot.ts'
import { postureFeature } from './features/posture.ts'
import { questsFeature } from './features/quests.ts'
import { skillsFeature } from './features/skills.ts'
import { skyClockFeature } from './features/sky-clock.ts'
import { soundFeature } from './features/sound.ts'
import { soundZonesFeature } from './features/sound-zones.ts'
import { stallFeature } from './features/stall.ts'
import { townFeature } from './features/town.ts'
import { townSoundFeature } from './features/town-sound.ts'
import { tradeFeature } from './features/trade.ts'
import { uxWorldFeature } from './features/ux-world.ts'
import { weatherFeature } from './features/weather.ts'
import { winterFeature } from './features/winter.ts'
import { winterPlayFeature } from './features/winter-play.ts'
import { lightningFeature } from './features/lightning.ts'
import { stormFeature } from './features/storm.ts'
import { tornadoFeature } from './features/tornado.ts'
import { wallsFeature } from './features/walls.ts'
import { siegeRepairFeature } from './features/siege-repair.ts'
import { siegeFeature } from './features/siege.ts'
import { newsFeature } from './features/news.ts'

export type CombatMessage = Extract<ServerMessage, { t: 'combat' }>

export interface WorldFeatureContext {
  readonly app: App
  readonly session: Session
  readonly scene: Scene
  readonly hud: Hud
  /** Same as `hud.keys`. */
  readonly keys: KeyMap
  /** The chat log (add lines with `chat.add(kind, text)`). */
  readonly chat: ChatBox
  readonly camera: ArcRotateCamera
  /** Sends when online and valid; builders must pass parseClientMessage (lane tests). False when not sent. */
  send(msg: ClientMessage): boolean
  /** Own entity id (null before worldEnter). */
  selfId(): number | null
  view(id: number): EntityView | undefined
  views(): IterableIterator<EntityView>
  target(): EntityView | null
  /** null clears the target. Ground items cannot be targeted (ignored). */
  setTarget(v: EntityView | null): void
  serverNow(): number
  /** The item of your last accepted `pickup` (from its actionResult on; null before any). */
  acceptedPickup(): number | null
  /** Loaded world-render handle (null while loading, or on the flat fallback). */
  world(): JanganGround | null
  /** The minimap (null until the world has loaded one). */
  minimap(): HudMinimap | null
  /**
   * Shows hit `index` of a combat message now: hurt clip, HP, damage number, the death on the last hit of a kill,
   * then every feature's `onCombatHit`. For features that time hits themselves (see `combat`).
   */
  presentHit(msg: CombatMessage, index: number): void
  /** Adds a per-view attachment factory for views created from now on. Returns an unregister function. */
  addAttachment(factory: EntityAttachmentFactory): () => void
  /**
   * Wave 9 (D9): a material decorator on every actor model the world screen's ModelLibrary loads (those loaded so far
   * and every later one). Returns a remover. Optional: absent in lane tests' contexts.
   */
  addMaterialDecorator?(fn: ActorMaterialDecorator): () => void
  /**
   * Play the Boss (docs/PLAY_THE_BOSS.md §4.1): the entity the player's input and "where am I" reads follow: the
   * steered mob while piloting, else the own id (null before worldEnter). Optional: absent in lane tests' contexts
   * (`ctx.controlledId?.() ?? ctx.selfId()`).
   */
  controlledId?(): number | null
  /** Play the Boss: sets the steered entity (null = back to the own character). */
  setControlled?(c: ControlledView | null): void
}

/**
 * Play the Boss (docs/PLAY_THE_BOSS.md §4.1): an entity the player steers instead of the own character. While one is
 * set, the world screen's focusView() is its view: the camera follow, the ground streaming, the world update, the
 * minimap centre and the music/town check follow it.
 */
export interface ControlledView {
  readonly id: number
  /** The camera's follow height above the feet (m); default the view's focusHeight. */
  focusHeight?(v: EntityView): number
  /** Minimap: false keeps an entity's sign off it (the pilot sees hunters only as her own markers). */
  onMinimap?(v: EntityView): boolean
}

export interface WorldFeature {
  /** Every server message, after world.ts handled it. */
  onMessage?(msg: ServerMessage): void
  /**
   * A `combat` message before the default presentation; true = this feature presents it (and calls
   * `ctx.presentHit(msg, i)` at each hit), so the default attack clip and hit timeline are skipped.
   */
  combat?(msg: CombatMessage): boolean
  /** When hit `index` is shown (after the default presentation of that hit). */
  onCombatHit?(msg: CombatMessage, index: number): void
  /** Every frame: server time (ms) and dt (seconds). */
  onFrame?(now: number, dt: number): void
  /** The own character entered or left the town (from the music check, about once a second). */
  onTownChange?(inTown: boolean): void
  /** true = consumed (runs before the default target/attack/pick-up). */
  clickEntity?(v: EntityView): boolean
  /** Esc: after the HUD windows and the Esc menu, before clearing the target. true = consumed. */
  escape?(): boolean
  onEntityAdded?(v: EntityView): void
  onEntityRemoved?(v: EntityView): void
  /**
   * Before a ground click or a hold-to-move step sends `moveTo` (the only two senders: screens/world.ts and
   * world/move-feedback.ts; docs/WAVE_PLAN2.md §4.3). true = consumed: nothing is sent (a stall owner's click).
   */
  beforeGroundMove?(): boolean
  dispose?(): void
}

export type WorldFeatureFactory = (ctx: WorldFeatureContext) => WorldFeature

/** One line per lane; W3-FC writes all wave-3 lines, W4-FC appends wave 4's. */
export const WORLD_FEATURES: readonly WorldFeatureFactory[] = [
  skillsFeature, // world/features/skills.ts (SK-C)
  npcFeature, // world/features/npc.ts (NPC-C)
  soundFeature, // world/features/sound.ts (SND-C)
  uxWorldFeature, // world/features/ux-world.ts (UX-B)
  mapFeature, // world/features/map.ts (FLD-C)
  questsFeature, // world/features/quests.ts (QS-C)
  partyFeature, // world/features/party.ts (PT-C)
  editorsFeature, // world/features/editors.ts (ED-C)
  fxWorldFeature, // world/features/fx-world.ts (FX-C2)
  postureFeature, // world/features/posture.ts (FX-C2)
  // Wave 8 (docs/WAVE_PLAN2.md §4.3; W8-FC writes these lines, append-only):
  mountFeature, // world/features/mount.ts (MR-C)
  berserkFeature, // world/features/berserk.ts (BZ)
  durabilityFeature, // world/features/durability.ts (DR)
  alchemyFeature, // world/features/alchemy.ts (AL)
  tradeFeature, // world/features/trade.ts (TR-C)
  stallFeature, // world/features/stall.ts (ST-C)
  guildFeature, // world/features/guild.ts (GU-C)
  // Playtest ask: drinks potions below the Options thresholds (after the stall and trade features, which own those windows).
  autoPotionFeature, // world/features/auto-potion.ts
  // Play the Boss (docs/PLAY_THE_BOSS.md §4.1): after the skills feature (its 1-7 win over the hotbar while piloting).
  pilotFeature, // world/features/pilot.ts
  // Wave 9 (docs/WAVE_PLAN3.md §4.3; W9A-S writes these lines):
  skyClockFeature, // world/features/sky-clock.ts (GAME)
  weatherFeature, // world/features/weather.ts (WX-C)
  // The snow season (docs/WINTER.md §8): footprints, breath, winter sounds; after the weather (it reads its frame).
  winterFeature, // world/features/winter.ts
  // The winter gameplay layer (docs/WINTER.md §13): warmth, snowballs, winter monsters, gift boxes; after the winter feature.
  winterPlayFeature, // world/features/winter-play.ts
  // Storm series step 1 (docs/WEATHER.md §2.7): lightning that strikes (telegraph, bolt, aftermath), after the weather.
  lightningFeature, // world/features/lightning.ts
  // Storm series step 2 (docs/WEATHER.md §12): the weather icon and forecast, charged monsters' glow and arcs.
  stormFeature, // world/features/storm.ts
  // Storm series step 3 (docs/WEATHER.md §13): the lightning tornado (funnel, thrown bodies, shake, roar).
  tornadoFeature, // world/features/tornado.ts
  // Siege of Jangan, layer 1 (docs/SIEGE.md §9.1): the walls that break (the cut walls, the nav through gaps, dust).
  wallsFeature, // world/features/walls.ts
  // Siege of Jangan, layer 3 (docs/SIEGE.md §2.4): Master Mason Ko's donation window and the repair numbers.
  siegeRepairFeature, // world/features/siege-repair.ts
  // Siege of Jangan, layer 4 (docs/SIEGE.md §9.3): the siege HUD, banners, the Town Bell, kegs, the reward window.
  siegeFeature, // world/features/siege.ts
  // The "What's new" window (docs/CHANGELOG_WINDOW.md): unseen update notes once per login, the Esc menu entry and J.
  newsFeature, // world/features/news.ts
  // Wave 10 step 2 (COAST §12.6, CST-A): after the sound feature, so the coast ambience wins on the coast; the jump stays last.
  coastFeature, // world/features/coast.ts (CST-A)
  // Wave 11 (docs/TOWN_LIFE.md §6, TL-S): after the sound and coast features (the area is set), before the town feature.
  townSoundFeature, // world/features/town-sound.ts (TL-S)
  // Wave 12 (docs/WAVE_PLAN8.md D9; W12-G writes this line, WE-R fills the feature): after the sound, coast and town
  // sound features (the area and the town loops are set: the zone voice cap counts them), before the town feature.
  soundZonesFeature, // world/features/sound-zones.ts (WE-R)
  // Wave 11 (docs/WAVE_PLAN7.md D11; W11-G writes this line; before the jump, which stays last):
  townFeature, // world/features/town.ts (TL-C)
  // Wave 10 (docs/WAVE_PLAN6.md §4.2; W10-G writes this line):
  movementFeature, // world/features/movement.ts (MV-C)
]

/** The features of one world visit, with every hook call isolated from the others. */
export class WorldFeatures {
  private readonly list: { name: string; f: WorldFeature }[] = []

  constructor(ctx: WorldFeatureContext, factories: readonly WorldFeatureFactory[] = WORLD_FEATURES) {
    factories.forEach((make, i) => {
      const name = make.name || `feature${i}`
      try {
        this.list.push({ name, f: make(ctx) })
      } catch (err) {
        console.error(`[world] feature ${name} failed to start`, err)
      }
    })
  }

  /** Calls `fn` on every feature (errors logged per feature). */
  each(fn: (f: WorldFeature) => void): void {
    for (const { name, f } of this.list) {
      try {
        fn(f)
      } catch (err) {
        console.error(`[world] feature ${name} failed`, err)
      }
    }
  }

  /** True as soon as one feature's `fn` returns true (the rest are not asked). */
  some(fn: (f: WorldFeature) => boolean | undefined): boolean {
    for (const { name, f } of this.list) {
      try {
        if (fn(f)) return true
      } catch (err) {
        console.error(`[world] feature ${name} failed`, err)
      }
    }
    return false
  }

  dispose(): void {
    this.each(f => f.dispose?.())
    this.list.length = 0
  }
}

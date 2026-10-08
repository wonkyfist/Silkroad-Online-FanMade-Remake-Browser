/**
 * The rare weapons' effect art (docs/RARITY.md §5.2): every sprite, strip and decal of the Seal of Star / Moon / Sun
 * effects lives in one atlas (`/rarity/fx-atlas.jpg`, 2048 × 2816), so every effect of every rare weapon on screen is
 * one draw (world/rarity/batch.ts). The art is generated (image generation, emissive on black; the sources and the
 * packing tool: packages/texpipe/src/rarity-atlas.ts), RGB only: black is transparent, the shader takes its coverage
 * from the brightest channel. The blade materials sample two more textures (`/rarity/blade-nebula.jpg`, the Star
 * blade's inside, and `/rarity/blade-masks.png`: R constellation lines, G fire cracks, B moonstone, A moonstone sheen).
 * Pure data (the packer and the tests read it).
 */

export const ATLAS_URL = '/rarity/fx-atlas.jpg'
export const BLADE_NEBULA_URL = '/rarity/blade-nebula.jpg'
export const BLADE_MASKS_URL = '/rarity/blade-masks.png'
export const ATLAS_W = 2048
export const ATLAS_H = 2816

/** x, y, w, h in atlas pixels (y down from the top); `rot` = the packer turns the source a quarter (its up runs along +u). */
export interface AtlasRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly rot?: boolean
}

const r = (x: number, y: number, w: number, h: number, rot = false): AtlasRect => ({ x, y, w, h, ...(rot ? { rot } : {}) })

/** Every sprite by name. Strips are 1024 × 256: the bright leading edge at the top, the trail fading down. */
export const SPRITES = {
  /** The ornate golden sun-disc (Seal of Sun, behind the back). */
  mandala: r(0, 0, 1024, 1024),
  /** Swing ribbons: silver moon mist, fire, cosmic stardust. */
  stripMoon: r(1024, 0, 1024, 256),
  stripFire: r(1024, 256, 1024, 256),
  stripStar: r(1024, 512, 1024, 256),
  /** A vertical pillar of light (Moon's moonbeam, the drop columns), stored turned: the pillar's height runs along u. */
  pillar: r(1024, 768, 1024, 256, true),
  flame: r(0, 1024, 512, 512),
  starburst: r(512, 1024, 512, 512),
  solarBurst: r(1024, 1024, 512, 512),
  /** God rays fanning up from the bottom centre. */
  godrays: r(1536, 1024, 512, 512),
  /** The filigree crescent (Moon's halo; opens to the right). */
  halo: r(0, 1536, 512, 512),
  /** A ground crescent shockwave (Moon crits). */
  shockwave: r(512, 1536, 512, 512),
  /** Ground ripples of moonlight. */
  ripples: r(1024, 1536, 512, 512),
  /** Scorched glowing ground. */
  scorch: r(1536, 1536, 512, 512),
  mist: r(0, 2048, 512, 512),
  /** A shooting star, head bottom-left, tail up-right. */
  shooting: r(512, 2048, 512, 512),
  flare: r(1024, 2048, 256, 256),
  orb: r(1280, 2048, 256, 256),
  ember: r(1024, 2304, 256, 256),
  smoke: r(1280, 2304, 256, 256),
  /** Blade shells: a strip of nebula (Star) and of constellation lines (shafts), the strip's middle row brightest. */
  nebulaStrip: r(0, 2560, 1024, 256),
  conStrip: r(1024, 2560, 1024, 256),
  /** The solar flare burst's twin (sun kill rays). */
  flareRing: r(1536, 2048, 512, 512),
} as const satisfies Record<string, AtlasRect>

export type SpriteName = keyof typeof SPRITES

/** u0, v0, u1, v1 of a sprite (v down, like the image; the batch flips nothing: textures load with invertY false). */
export function spriteUv(name: SpriteName, inset = 1.5): [number, number, number, number] {
  const s = SPRITES[name]
  return [(s.x + inset) / ATLAS_W, (s.y + inset) / ATLAS_H, (s.x + s.w - inset) / ATLAS_W, (s.y + s.h - inset) / ATLAS_H]
}

/** Which sprites a rect list overlaps (the packer checks the layout with it; tests too). */
export function overlaps(a: AtlasRect, b: AtlasRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * DT-2 detail stage: the albedo route of a texture and the calibrated SDXL parameters per profile
 * (work/tmp/detail/bakeoff/REPORT.md §4–§5 and §8, docs/TEXPIPE.md §3.4a). Pure: no node:* imports.
 *
 * Route (`overrides.json`): the set's `detail` wins, then `classes[<material class>].detail`, else `gan` (TP-U's
 * Real-ESRGAN master, what every set used before DT-2). `sdxl` runs the detail stage; `retail` is a plain Lanczos3 ×4
 * of the retail pixels (no AI), for art the models misread.
 *
 * Profiles, as calibrated in the bake-off (the settings of every final D result that passed the UV gate):
 *   terrain    denoise 0.5, ControlNet 0.8, dpmpp_2m, cfg 6, 16 steps, colour lock at 2 source texels, then the
 *              half-offset seam repair at 0.55 (sdxl_terrain.py; 220–240 s per 2K tile)
 *   body       denoise 0.45 + a face pass at 0.18, ControlNet 0.7, SDE, cfg 6, 20 steps, colour fix 1 texel
 *              (32.7 dB, face 33.9 dB)
 *   hair       denoise 0.5, ControlNet 0.7, SDE, cfg 6, 20 steps, colour fix 1 texel, the "detail" style (32.5 dB)
 *   equipment  armour, leather, cloth and weapons: denoise 0.6, ControlNet 0.6, SDE, cfg 7, 20 steps, colour fix
 *              0.5 texel, the "detail" style (28.3–31.3 dB; REPORT §8: SDE at CN 0.6 is what invents detail)
 *   world      walls, roofs, gates, paving, bark (not in the bake-off): the terrain recipe at a lower denoise (0.4)
 *              and a 1-texel colour fix, because the painted building art has hard edges the 2-texel lock blurs
 * Wrap axes always get the seam repair and a wrap-aware colour lock; atlases (no wrap axis) get the UV-safe composite
 * (SDXL inside the dilated UV islands only; the gutter stays the GAN master's, bit for bit).
 */
import type { MaterialClass } from '../../../world-render/src/pbr/classes.ts'
import type { DetailProfileName, DetailRoute, SdxlOverride, TexpipeOverrides } from '../format.ts'
import { isPavingFile } from '../paving.ts'

/** Bump when the stage's output changes for the same inputs (drops the detail cache). */
export const DETAIL_VERSION = 1

export const DEFAULT_MODELS = {
  ckpt: 'sd_xl_base_1.0.safetensors',
  vae: 'sdxl_vae_fp16_fix.safetensors',
  controlnet: 'controlnet-tile-sdxl-1.0.safetensors',
} as const

export const STYLE_PAINT = 'hand-painted fantasy MMORPG texture, highly detailed, sharp, flat even lighting, no shadows'
export const STYLE_DETAIL = 'highly detailed game texture, intricate fine detail, sharp focus, crisp micro detail, realistic material surface, 4k, flat even lighting, no shadows'
export const STYLE_GROUND = 'top-down orthographic seamless ground texture, highly detailed, sharp focus, flat even lighting, no shadows'
export const STYLE_WALL = 'flat orthographic seamless texture, front view, highly detailed, sharp focus, flat even lighting, no shadows'
export const NEGATIVE = 'blurry, soft, lowres, jpeg artifacts, noise, text, letters, watermark, logo, signature, photo background, harsh shadows, specular highlights, glare, deformed, extra objects'
export const NEGATIVE_SEAMLESS = `${NEGATIVE}, seam, border, frame, perspective, horizon, sky, objects, plants in 3d`

/** The parameters one SDXL job gets (sdxl_job.py `params`). */
export interface SdxlParams {
  profile: DetailProfileName
  prompt: string
  negative: string
  denoise: number
  seamDenoise: number
  cn: number
  cnEnd: number
  cfg: number
  steps: number
  sampler: string
  scheduler: string
  /** Colour-fix radius in source texels. */
  cfix: number
  seed: number
  /** USDU tile edge (px, at most the image). */
  tile: number
  tilePadding: number
  /** Seam band half-width and feather (px at the working size). */
  band: number
  feather: number
  /** Working size: the short edge is raised to workMin, the long edge kept ≤ workMax. */
  workMin: number
  workMax: number
  face: { uv: [number, number, number, number]; denoise: number } | null
  models: { ckpt: string; vae: string; controlnet: string }
}

type ProfileBase = Omit<SdxlParams, 'prompt' | 'profile' | 'face' | 'models'> & { face: SdxlParams['face'] }

const COMMON = { cnEnd: 0.85, scheduler: 'karras', tile: 1024, tilePadding: 64, band: 96, feather: 32, workMin: 1024, workMax: 4096 }

export const PROFILES: Readonly<Record<DetailProfileName, ProfileBase>> = {
  terrain: { ...COMMON, negative: NEGATIVE_SEAMLESS, denoise: 0.5, seamDenoise: 0.55, cn: 0.8, cfg: 6, steps: 16, sampler: 'dpmpp_2m', cfix: 2, seed: 3, face: null },
  world: { ...COMMON, negative: NEGATIVE_SEAMLESS, denoise: 0.4, seamDenoise: 0.45, cn: 0.8, cfg: 6, steps: 16, sampler: 'dpmpp_2m', cfix: 1, seed: 3, face: null },
  body: { ...COMMON, negative: NEGATIVE, denoise: 0.45, seamDenoise: 0.45, cn: 0.7, cfg: 6, steps: 20, sampler: 'dpmpp_2m_sde', cfix: 1, seed: 7, face: { uv: [0.45, 0, 1, 1], denoise: 0.18 } },
  hair: { ...COMMON, negative: NEGATIVE, denoise: 0.5, seamDenoise: 0.5, cn: 0.7, cfg: 6, steps: 20, sampler: 'dpmpp_2m_sde', cfix: 1, seed: 7, face: null },
  equipment: { ...COMMON, negative: NEGATIVE, denoise: 0.6, seamDenoise: 0.5, cn: 0.6, cfg: 7, steps: 20, sampler: 'dpmpp_2m_sde', cfix: 0.5, seed: 7, face: null },
}

/** What the profile and prompt choice needs to know about a texture (an InventoryEntry satisfies it). */
export interface DetailEntry {
  key: string
  group: string
  class: MaterialClass
  wrap: readonly [boolean, boolean]
}

const fileOf = (key: string) => key.slice(key.lastIndexOf('/') + 1).replace(/^tile2d:/, '').replace(/\.ddj$/, '').trim()

/** The profile of a texture: tiles → terrain, hair and bodies by name, other actor atlases → equipment, else world. */
export function profileFor(e: DetailEntry, override?: SdxlOverride): DetailProfileName {
  if (override?.profile) return override.profile
  const f = fileOf(e.key)
  if (e.group === 'tile') return 'terrain'
  if (/(^|_)hair($|_|\d)/.test(f)) return 'hair'
  if (/(^|_)body($|_|\d)/.test(f) || e.class === 'skin') return 'body'
  if (e.group !== 'world') return 'equipment'
  return 'world'
}

/** The positive prompt of a texture (profile, class and name words; REPORT's prompts where the bake-off had one). */
export function promptFor(e: DetailEntry, profile: DetailProfileName): string {
  const f = fileOf(e.key)
  switch (profile) {
    case 'terrain':
      if (isPavingFile(f) || /floor/.test(f)) return `flat stone paving slabs with fine joints, worn smooth surface, fine mineral grain, thin moss in the joints, ${STYLE_GROUND}`
      if (e.class === 'ground_grass') return `lush meadow grass, dense fine grass blades, small clover leaves, tiny wild flowers, ${STYLE_GROUND}`
      if (e.class === 'ground_soil') return `packed earth dirt road, fine dry soil, small pebbles and grit, faint cart tracks, ${STYLE_GROUND}`
      if (e.class === 'water') return `wet muddy ground, dark silt, small puddles and reeds, ${STYLE_GROUND}`
      return `weathered grey stone ground, cracked rock surface, fine mineral grain, lichen patches, ${STYLE_GROUND}`
    case 'body':
      return `skin with subtle pores and natural muscle definition, fine cloth weave and embroidery on the garments, ${STYLE_PAINT}`
    case 'hair':
      return `fine individual hair strands flowing downward, soft strand highlights, ${STYLE_DETAIL}`
    case 'equipment':
      if (e.class === 'metal') return `ornate chinese weapon parts, polished steel with fine engraving, bronze and gold fittings with relief ornament, leather-wrapped grip, subtle scratches, ${STYLE_DETAIL}`
      return `chinese armour and clothing, riveted leather plates with stitching and worn edges, hammered iron, quilted linen with fine weave, silk with gold trim, subtle scratches, ${STYLE_DETAIL}`
    case 'world':
      if (/roof/.test(f) || e.class === 'roof_tile') return `glazed chinese roof tiles in neat rows, fine glaze crackle, weathered edges, ${STYLE_WALL}`
      if (/floor|stair|pave|dan$/.test(f)) return `worn stone paving slabs with fine joints, smooth surface, fine mineral grain, ${STYLE_WALL}`
      if (e.class === 'wood' || /tre_|bark|pilla|trunk|pine|bam/.test(f)) return `tree bark with deep natural furrows and fine fibres, lichen specks, ${STYLE_WALL}`
      if (e.class === 'metal') return `aged bronze and iron fittings with fine hammer marks and patina, ${STYLE_WALL}`
      if (/gate|door|pillar|fence|dragon/.test(f)) return `ancient chinese architecture, lacquered red wood with fine grain, carved ornament, painted beams, stone base, ${STYLE_WALL}`
      return `ancient chinese city wall, dressed stone blocks and brick with fine mortar joints, weathered plaster, fine mineral grain, ${STYLE_WALL}`
  }
}

/** The SDXL parameters of one texture: its profile's calibrated values, then the review's `sdxl` block. */
export function sdxlParams(e: DetailEntry, override?: SdxlOverride): SdxlParams {
  const profile = profileFor(e, override)
  const base = PROFILES[profile]
  const p: SdxlParams = { ...base, profile, prompt: promptFor(e, profile), face: base.face ? { ...base.face, uv: [...base.face.uv] as [number, number, number, number] } : null, models: { ...DEFAULT_MODELS } }
  if (!override) return p
  const o = override
  if (o.prompt) {
    const style = profile === 'terrain' ? STYLE_GROUND : profile === 'world' ? STYLE_WALL : profile === 'body' ? STYLE_PAINT : STYLE_DETAIL
    p.prompt = `${o.prompt}, ${style}`
  }
  for (const k of ['denoise', 'seamDenoise', 'cn', 'cfg', 'steps', 'cfix', 'seed'] as const) if (o[k] !== undefined) p[k] = o[k]!
  if (o.sampler) p.sampler = o.sampler
  if (o.face === null) p.face = null
  else if (o.face) p.face = { uv: [...o.face.uv] as [number, number, number, number], denoise: o.face.denoise ?? p.face?.denoise ?? 0.18 }
  return p
}

/** The albedo route of a texture: the set's `detail`, else its class's, else `gan`. */
export function detailRoute(key: string, cls: MaterialClass, overrides?: TexpipeOverrides | null): DetailRoute {
  return overrides?.sets[key]?.detail ?? overrides?.classes?.[cls]?.detail ?? 'gan'
}

/** 'tile' (any wrap axis: seam repair, whole-image composite) or 'atlas' (UV-island composite). */
export function detailMode(e: Pick<DetailEntry, 'wrap'>): 'tile' | 'atlas' {
  return e.wrap[0] || e.wrap[1] ? 'tile' : 'atlas'
}

// ---- the gate ---------------------------------------------------------------------------------------------------------

/** sdxl_job.py's gate report (meta.json `gates`). */
export interface DetailGates {
  gutter_changed_px: number
  gutter_px: number
  pass_gutter: boolean
  uvsafe: { psnr: number | null; psnr_gan: number | null; psnr_shift1: number | null; psnr_lanczos: number | null; 'coverage_%': number }
  shift_texels: { blocks: number; median: number; p95: number; mean_dx: number; mean_dy: number }
  pass_shift: boolean
  face?: { denoise: number; box: number[]; triangles: number; seconds: number; psnr?: number | null }
  mean_rgb: { source: number[]; result: number[]; max_delta: number }
  luma_std: { source: number; gan: number; result: number }
  seams?: { source: [number, number]; gan: [number, number]; raw: [number, number]; result: [number, number] }
}

/** The pass rule (REPORT §5, DETAIL §2). */
export const GATE = {
  /** Atlases: island PSNR vs the source (dB). */
  psnrMin: 28,
  /** PSNR must beat the 1-texel-shifted result by this much (dB): the result lines up with the UVs. */
  shiftMargin: 3,
  /**
   * Tiles: no islands to misalign, and a smooth soil tile scores nearly the same shifted by a texel (c_dust_fld_01:
   * GAN 39.9 dB, the SDXL result 35.5 dB vs 34.7 dB shifted), so a tile only has to beat its shifted copy; the block
   * shift test is its alignment gate.
   */
  tileShiftMargin: 0,
  /** Median / p95 block shift (source texels). */
  shiftMedian: 0.1,
  /** Faces: PSNR of the face islands vs the source (the bake-off's final face was 33.9 dB; the GAN's 34.0). */
  facePsnrMin: 30,
  /** Tiles: the mean colour may move this many 8-bit levels (the splat blend needs the source's colour family). */
  meanDelta: 3,
  /** Tiles: seam ratio on a wrap axis ≤ max(seamAbs, seamRel × the source's). */
  seamAbs: 1.5,
  seamRel: 1.35,
  /** Tiles have no UV islands to misalign; their absolute floor is the GAN master's own PSNR minus this (dB). */
  tileGanSlack: 2,
} as const

export interface GateVerdict {
  pass: boolean
  /** Failed checks, e.g. ['psnr 26.1 < 28']. */
  failed: string[]
  /** The failure is fidelity only (aligned, gutter intact): a smaller colour-fix radius is the prescribed re-roll. */
  fidelityOnly: boolean
}

/** Applies the pass rule to a job's gates. */
export function judge(mode: 'tile' | 'atlas', g: DetailGates, wrap: readonly [boolean, boolean]): GateVerdict {
  const failed: string[] = []
  const u = g.uvsafe
  const psnr = u.psnr ?? 0
  const floor = mode === 'atlas' ? GATE.psnrMin : Math.min(GATE.psnrMin, (u.psnr_gan ?? GATE.psnrMin) - GATE.tileGanSlack)
  let fidelity = false
  if (psnr < floor) {
    failed.push(`psnr ${psnr} < ${+floor.toFixed(2)}`)
    fidelity = true
  }
  const margin = mode === 'atlas' ? GATE.shiftMargin : GATE.tileShiftMargin
  if (u.psnr_shift1 !== null && psnr < u.psnr_shift1 + margin) failed.push(`psnr ${psnr} < shift-1 ${u.psnr_shift1} + ${margin}`)
  if (!g.pass_shift) failed.push(`shift median ${g.shift_texels.median} p95 ${g.shift_texels.p95} mean ${g.shift_texels.mean_dx},${g.shift_texels.mean_dy}`)
  if (!g.pass_gutter) failed.push(`gutter changed ${g.gutter_changed_px} px`)
  if (g.face && g.face.psnr !== undefined && g.face.psnr !== null && g.face.psnr < GATE.facePsnrMin) {
    failed.push(`face psnr ${g.face.psnr} < ${GATE.facePsnrMin}`)
    fidelity = true
  }
  if (mode === 'tile') {
    if (g.mean_rgb.max_delta > GATE.meanDelta) {
      failed.push(`mean colour moved ${g.mean_rgb.max_delta} levels`)
      fidelity = true
    }
    if (g.seams) {
      for (const [i, axis] of (['u', 'v'] as const).entries()) {
        if (!wrap[i]) continue
        const limit = Math.max(GATE.seamAbs, GATE.seamRel * g.seams.source[i]!)
        if (g.seams.result[i]! > limit) failed.push(`seam ${axis} ${g.seams.result[i]} > ${+limit.toFixed(2)}`)
      }
    }
  }
  // Aligned (block shift) and the gutter intact, only the fidelity numbers low: the prescribed first re-roll is a
  // smaller colour-fix radius on the same SDXL output (REPORT §5).
  // A low shift-1 margin counts too: a less faithful result gains less over its shifted copy, and the block shift test
  // (pass_shift) is what proves alignment; the re-composite still has to pass the whole gate.
  const fidelityOnly = fidelity && g.pass_shift && g.pass_gutter && failed.every(f => f.startsWith('psnr ') || f.startsWith('face') || f.startsWith('mean colour'))
  return { pass: failed.length === 0, failed, fidelityOnly }
}

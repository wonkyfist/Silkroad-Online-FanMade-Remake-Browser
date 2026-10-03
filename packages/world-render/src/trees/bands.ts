/**
 * The band byte and its slots (docs/TREES.md Part W §W3.3; docs/WAVE_PLAN8.md §2.2, §2.5, D24; T12-N).
 *
 * - **The band byte** per swapped placement: 0 near (the LOD0 overlay draws it), 1 mid (the merged LOD1), 2 far (the
 *   merged LOD2), 3 hidden (the World Editor's drag and delete). One byte decides for both the overlay and the merged
 *   vertices (T12-W's SRO_FOL_BAND collapses a merged vertex whose tier is not its slot's byte), so a tree is never drawn
 *   twice and never missing.
 * - **The bands** (distance − radius, × the range scale): trees < 40 m near, < 110 m mid, far beyond (the group range
 *   culls the rest); plants have no overlay: P-LOD0 (tier 1) < 25 m, P-LOD1 (tier 2) beyond. **Hysteresis 3 m**: a
 *   placement crosses a boundary outward only 3 m past it (inward at the boundary). A species whose overlay is not ready
 *   stays mid however near (its LOD1 stands in), so nothing is ever missing while a `near.glb` loads.
 * - **The crowded-plaza rule (D24):** on Medium with ≥ 15 players in range the overlay draws only within 20 m (the merged
 *   LOD1 beyond). Cut item 17 makes it 0 m (`CROWD_NEAR_M`).
 * - **The slots:** 8,192 (R8 128 × 64, T12-W's TREE_BAND_TEX_W × TREE_BAND_TEX_H), a free list keyed by the placement
 *   key (placementKey(region, uid)), handed out when a region places a swapped placement (before its merge job is built,
 *   so the worker writes `slot × 4 + tier`), kept while any region load holds the key (a reload places it again under a
 *   new owner before the old one goes), freed with the last.
 * - **The texture:** R8, nearest, uploaded whole (8 KB) after a refill that changed a byte.
 */
import { Constants, RawTexture, Texture, type Scene } from '@babylonjs/core'
import { TREE_BAND_TEX_H, TREE_BAND_TEX_W } from '../pbr/foliage-plugin.ts'

/** Band bytes (TREES §W3.3). */
export const BAND_NEAR = 0
export const BAND_MID = 1
export const BAND_FAR = 2
export const BAND_HIDDEN = 3
/** A slot entry whose band was never computed (no hysteresis applies to it). */
export const BAND_NONE = 255

/** The band slots (R8 TREE_BAND_TEX_W × TREE_BAND_TEX_H = 8,192; 5,586 swapped placements + the editor's headroom). */
export const BAND_SLOTS = TREE_BAND_TEX_W * TREE_BAND_TEX_H
/** A tree is near (the overlay's LOD0) within this (m, distance − radius, × the range scale). */
export const TREE_NEAR_M = 40
/** A tree is mid (the merged LOD1) within this; far (LOD2) beyond. */
export const TREE_MID_M = 110
/** A plant draws its P-LOD0 (tier 1) within this; its P-LOD1 (tier 2) beyond. Plants have no overlay. */
export const PLANT_NEAR_M = 25
/** Hysteresis (m): a placement leaves a band outward this far past the boundary. */
export const BAND_HYSTERESIS_M = 3
/** The bands are refilled once the camera moved this far (m), or the range scale or the rule changed. */
export const REFILL_STEP_M = 4
/** The crowded-plaza rule (D24): from this many players in range, on Medium… */
export const CROWD_PLAYERS = 15
/** …the overlay draws only within this (m; × the range scale). Cut item 17: 0. */
export const CROWD_NEAR_M = 20

/** The band boundaries in force (m, already × the range scale). */
export interface BandRule {
  /** Trees: near → mid (0: no overlay, every tree at least mid). */
  nearM: number
  /** Trees: mid → far. */
  midM: number
  /** Plants: P-LOD0 → P-LOD1. */
  plantM: number
  /** Hysteresis (m, not scaled). */
  hysteresisM: number
}

/**
 * The rule at a range scale (Options' sight, the create screen's 0.6), with the crowded-plaza rule on or off.
 * `crowdNearM`: the crowd's near distance (CROWD_NEAR_M; cut 17 passes 0).
 */
export function bandRule(scale: number, crowded = false, crowdNearM = CROWD_NEAR_M): BandRule {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    nearM: (crowded ? Math.min(crowdNearM, TREE_NEAR_M) : TREE_NEAR_M) * s,
    midM: TREE_MID_M * s,
    plantM: PLANT_NEAR_M * s,
    hysteresisM: BAND_HYSTERESIS_M,
  }
}

/**
 * The boundaries crossed at distance `d` (0 … edges.length): boundary i is crossed at edges[i], or at edges[i] + h
 * when the previous index (`prev`, −1: none) lies on its near side (the hysteresis).
 */
export function bandIndex(d: number, edges: readonly number[], prev: number, h: number): number {
  let b = 0
  for (let i = 0; i < edges.length; i++) {
    const t = edges[i]! + (prev >= 0 && prev <= i ? h : 0)
    if (d >= t) b = i + 1
    else break
  }
  return b
}

/**
 * A placement's band at `d` (m: distance from the camera to its bounding sphere: centre distance − radius): a plant
 * 1 or 2; a tree 0, 1 or 2 (never 0 while its species' overlay is not ready, `overlay` false, or the rule's near is 0).
 * `prev` is its last band (BAND_NONE / BAND_HIDDEN: no hysteresis).
 */
export function bandFor(d: number, plant: boolean, prev: number, rule: Readonly<BandRule>, overlay = true): number {
  // bandIndex's rule, unrolled (no allocation: the refill runs it for every resident slot).
  const h = rule.hysteresisM
  if (plant || !overlay || !(rule.nearM > 0)) {
    // one boundary (plants: P-LOD0 | P-LOD1; trees without an overlay: LOD1 | LOD2); mid lies on its near side
    return d >= (plant ? rule.plantM : rule.midM) + (prev === BAND_MID ? h : 0) ? BAND_FAR : BAND_MID
  }
  if (!(d >= rule.nearM + (prev === BAND_NEAR ? h : 0))) return BAND_NEAR
  if (!(d >= rule.midM + (prev === BAND_NEAR || prev === BAND_MID ? h : 0))) return BAND_MID
  return BAND_FAR
}

// ---- the slots ----------------------------------------------------------------------------------------------------

/** One swapped placement holding a band slot. */
export interface SlotEntry {
  readonly slot: number
  /** placementKey(region, uid). */
  readonly key: number
  /** The region loads (owner keys) that placed it; the slot is freed with the last. */
  owners: number[]
  /** The species' manifest model index (its overlay set). */
  species: number
  /** A plant (no overlay; P-LOD0 / P-LOD1 bands). */
  plant: boolean
  /** The crown tint (0: the species' own sprites; k ≥ 1: its k-th tint). */
  tint: number
  /** The species matrix (16 floats): the overlay instance's, the merged vertices' root in its translation. */
  readonly matrix: Float32Array
  /** The bounding sphere (world space). */
  x: number
  y: number
  z: number
  r: number
  /** The band last written (BAND_NONE before the first). */
  band: number
}

/** The band slots: a free list keyed by the placement key (lowest free slot first). */
export class TreeSlots {
  private readonly free: number[] = []
  private readonly byKey = new Map<number, SlotEntry>()
  /** Slots that could not be handed out (all taken). */
  refused = 0

  constructor(readonly capacity = BAND_SLOTS) {
    for (let s = capacity - 1; s >= 0; s--) this.free.push(s)
  }

  /** Slots in use. */
  get used(): number {
    return this.byKey.size
  }

  /** The slot of a placement key, or null. */
  slotOf(key: number): number | null {
    return this.byKey.get(key)?.slot ?? null
  }

  get(key: number): SlotEntry | null {
    return this.byKey.get(key) ?? null
  }

  /** Every entry in use. */
  entries(): IterableIterator<SlotEntry> {
    return this.byKey.values()
  }

  /**
   * The entry of `key` for region load `owner`: its existing slot (the owner joins it), or a free one (null when none is
   * left: the batch then draws that tree's LOD1 at every distance). `fresh` tells a new entry from a kept one.
   */
  acquire(key: number, owner: number): { entry: SlotEntry; fresh: boolean } | null {
    const have = this.byKey.get(key)
    if (have) {
      if (!have.owners.includes(owner)) have.owners.push(owner)
      return { entry: have, fresh: false }
    }
    const slot = this.free.pop()
    if (slot === undefined) {
      this.refused++
      return null
    }
    const entry: SlotEntry = {
      slot, key, owners: [owner], species: -1, plant: false, tint: 0, matrix: new Float32Array(16), x: 0, y: 0, z: 0, r: 0, band: BAND_NONE,
    }
    this.byKey.set(key, entry)
    return { entry, fresh: true }
  }

  /** Region load `owner` went: its claim on every entry goes; returns the entries freed (no owner left). */
  releaseOwner(owner: number): SlotEntry[] {
    const freed: SlotEntry[] = []
    for (const e of this.byKey.values()) {
      const i = e.owners.indexOf(owner)
      if (i < 0) continue
      e.owners.splice(i, 1)
      if (e.owners.length) continue
      freed.push(e)
    }
    for (const e of freed) {
      this.byKey.delete(e.key)
      this.free.push(e.slot)
    }
    // Lowest first again (a stable hand-out order; the list is at most 8,192 long and frees are per region).
    if (freed.length) this.free.sort((a, b) => b - a)
    return freed
  }

  /** Every slot back to free. */
  clear(): void {
    this.byKey.clear()
    this.free.length = 0
    for (let s = this.capacity - 1; s >= 0; s--) this.free.push(s)
  }
}

// ---- the texture --------------------------------------------------------------------------------------------------

/** The band bytes and their R8 texture (made on first use: a world that swaps nothing never makes one). */
export class TreeBandTexture {
  /** One byte per slot (free slots: hidden). */
  readonly bytes = new Uint8Array(BAND_SLOTS).fill(BAND_HIDDEN)
  private tex: RawTexture | null = null
  private dirty = false
  /** Whole-texture uploads so far. */
  uploads = 0

  constructor(readonly scene: Scene) {}

  /** The texture (null until `ensure`). */
  get texture(): RawTexture | null {
    return this.tex
  }

  /** Makes the texture (R8, nearest, no mips) with the current bytes. */
  ensure(): RawTexture {
    if (this.tex) return this.tex
    const t = new RawTexture(this.bytes, TREE_BAND_TEX_W, TREE_BAND_TEX_H, Constants.TEXTUREFORMAT_R, this.scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE)
    t.name = 'sroTreeBand'
    t.wrapU = Texture.CLAMP_ADDRESSMODE
    t.wrapV = Texture.CLAMP_ADDRESSMODE
    this.tex = t
    this.dirty = false
    return t
  }

  /** Writes a slot's byte; true when it changed. */
  set(slot: number, band: number): boolean {
    if (this.bytes[slot] === band) return false
    this.bytes[slot] = band
    this.dirty = true
    return true
  }

  /** Uploads the bytes when any changed since the last upload; true when it did. */
  upload(): boolean {
    if (!this.dirty || !this.tex) return false
    this.dirty = false
    this.tex.update(this.bytes)
    this.uploads++
    return true
  }

  dispose(): void {
    this.tex?.dispose()
    this.tex = null
  }
}

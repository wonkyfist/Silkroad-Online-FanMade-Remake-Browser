/**
 * Hunting labels of the world map (docs/FIELDS.md §5.3): the nests of nests.json clustered per mob (single linkage,
 * nests of the same mob within 200 m join one cluster), one "Tiger Lv 14" label per cluster at the mean of its nest
 * centres, coloured by the shared level band against the player's level (world/level-band.ts, decision 24). A unique
 * (Tiger Girl: 11 camps sharing one uniqueGroup) gets a single label at the mean of all its nests. Pure: no DOM.
 */
import { LEVEL_BAND_COLOR, levelBand } from '../level-band.ts'

/** The nest fields the clustering reads (NestDef). */
export interface HuntNest {
  mob: string
  x: number
  z: number
  /** Mobs alive at once. */
  count?: number
  /** Copy of the mob's level (exporter); the mob's own level wins. */
  level?: number
  uniqueGroup?: string
  enabled?: boolean
}

/** The mob fields the clustering reads (MobDef). */
export interface HuntMob {
  code: string
  /** English name; null (missing) shows the code. */
  name: string | null
  level: number
  rarity?: string
}

export interface HuntCluster {
  mob: string
  name: string
  level: number
  /** glTF metres: the mean of the cluster's nest centres. */
  x: number
  z: number
  nests: number
  /** Sum of the nests' counts. */
  mobs: number
  unique: boolean
}

export interface HuntOptions {
  /** Single-linkage distance (m); default CLUSTER_LINK_M. */
  linkM?: number
  /** Nests whose mob is above this level are left out (the server leaves them empty; config MOB_LEVEL_MAX). */
  maxLevel?: number
  /** Only nests inside this glTF rectangle (the world map's area). */
  bounds?: { minX: number; minZ: number; maxX: number; maxZ: number }
}

export const CLUSTER_LINK_M = 200

/** Clusters the nests (see the header). Sorted by level, then name, then position, so the output is stable. */
export function huntingClusters(nests: readonly HuntNest[], mobOf: (code: string) => HuntMob | undefined, opts: HuntOptions = {}): HuntCluster[] {
  const link = opts.linkM ?? CLUSTER_LINK_M
  const b = opts.bounds
  const byMob = new Map<string, { mob: HuntMob; nests: HuntNest[]; unique: boolean }>()
  for (const n of nests) {
    if (n.enabled === false || !Number.isFinite(n.x) || !Number.isFinite(n.z)) continue
    if (b && (n.x < b.minX || n.x > b.maxX || n.z < b.minZ || n.z > b.maxZ)) continue
    const known = mobOf(n.mob)
    const level = known?.level ?? n.level
    if (level === undefined || !Number.isFinite(level)) continue
    if (opts.maxLevel !== undefined && opts.maxLevel > 0 && level > opts.maxLevel) continue
    const unique = known?.rarity === 'unique' || !!n.uniqueGroup
    const key = unique && n.uniqueGroup ? `unique:${n.uniqueGroup}` : n.mob
    let g = byMob.get(key)
    if (!g) {
      g = { mob: known ?? { code: n.mob, name: n.mob, level }, nests: [], unique }
      byMob.set(key, g)
    }
    g.nests.push(n)
  }
  const out: HuntCluster[] = []
  for (const g of byMob.values()) {
    const groups = g.unique ? [g.nests] : linkage(g.nests, link)
    for (const list of groups) {
      let sx = 0
      let sz = 0
      let mobs = 0
      for (const n of list) {
        sx += n.x
        sz += n.z
        mobs += n.count ?? 1
      }
      out.push({ mob: g.mob.code, name: g.mob.name || g.mob.code, level: g.mob.level, x: sx / list.length, z: sz / list.length, nests: list.length, mobs, unique: g.unique })
    }
  }
  return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name) || a.x - b.x || a.z - b.z)
}

/** Single-linkage groups: nests closer than `link` metres (directly or through a chain) share a group. */
export function linkage<T extends { x: number; z: number }>(items: readonly T[], link: number): T[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const l2 = link * link
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const dx = items[i]!.x - items[j]!.x
      const dz = items[i]!.z - items[j]!.z
      if (dx * dx + dz * dz <= l2) {
        const a = find(i)
        const c = find(j)
        if (a !== c) parent[c] = a
      }
    }
  }
  const groups = new Map<number, T[]>()
  items.forEach((it, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(it)
    else groups.set(r, [it])
  })
  return [...groups.values()]
}

/** Label colour of a mob level for the player's level (the nameplates' band colours). */
export function huntColor(mobLevel: number, selfLevel: number): string {
  return LEVEL_BAND_COLOR[levelBand(mobLevel, selfLevel)]
}

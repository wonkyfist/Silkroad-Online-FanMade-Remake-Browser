/**
 * S-NAV (docs/WORLD_EDITOR.md §F10, §6.3 step 3; docs/WAVE_PLAN8.md §4.1): object instance edits on NavData.
 *
 * The world editor moves, drops and adds placements whose models carry a collision navmesh (trees included). The nav
 * keeps one instance per (regionId, localUid), id = regionId << 16 | uid; an edit names instances by that id:
 * - `remove`: the instances leave (their index slots are compacted out);
 * - `put`: an instance with a new id is appended; one with the id of an existing instance replaces it **in its slot**
 *   (a move: same id, same index, new transform), whether or not the same edit also removes that id
 *   (replace = remove + add).
 * Links are never edited (the palace bridge pieces, §4.6): removing or moving a linked instance (one with links, or
 * the target of another's link) throws. Untouched instances keep their objects; the regions are shared, not copied.
 *
 * NavWorld.editInstances applies the same function in place (the walk preview); `new NavWorld(editNavInstances(...)
 * .data)` is the same world built from scratch (the objects-only rebuild).
 */
import type { NavData, NavInstance, NavModel } from './data.ts'

export interface NavInstancePut {
  /** regionId << 16 | uid (unsigned). */
  id: number
  objId: number
  /** Index into NavData.models, or a model (appended unless one with its key exists). */
  model: number | NavModel
  /** World file space. */
  x: number
  y: number
  z: number
  /** Radians about +Y, as stored in the .nvm. */
  yaw: number
}

export interface NavInstanceEdits {
  /** Instance ids to remove. */
  remove?: ReadonlyArray<number>
  /** Instances to add, or to replace in place (same id). Ids must be unique. */
  put?: ReadonlyArray<NavInstancePut>
}

export interface NavInstanceEditResult {
  /** The edited data (regions shared with the input; the input is not mutated). */
  data: NavData
  /** Old instance index -> new index; -1 for a removed instance. */
  remap: Int32Array
  removed: number
  replaced: number
  added: number
  /** Removed ids that were not in the data. */
  missing: number[]
}

/** The nav instance id of a placement: regionId << 16 | uid, unsigned (packages/nav/src/data.ts). */
export const navInstanceId = (regionId: number, uid: number) => (((regionId & 0xffff) << 16) | (uid & 0xffff)) >>> 0

const normKey = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/**
 * Adds a set of extra instances (e.g. the Siege of Jangan's wall pieces, `siege/walls-nav.bin`: models and instances,
 * no regions) to a world's nav data in one edit: each piece is put by id (appended; an id already there is replaced
 * in its slot, so installing twice changes nothing). Returns the puts for `NavWorld.editInstances` / editNavInstances.
 */
export function navPiecePuts(pieces: Pick<NavData, 'models' | 'instances'>): NavInstancePut[] {
  return pieces.instances.map(inst => {
    const model = pieces.models[inst.model]
    if (!model) throw new Error(`nav pieces: instance 0x${(inst.id >>> 0).toString(16)} has no model ${inst.model}`)
    return { id: inst.id >>> 0, objId: inst.objId, model, x: inst.x, y: inst.y, z: inst.z, yaw: inst.yaw }
  })
}

/** Applies instance edits to NavData (pure). Throws on a linked instance, a duplicate put id or a bad model. */
export function editNavInstances(data: NavData, edits: NavInstanceEdits): NavInstanceEditResult {
  const byId = new Map<number, number>()
  data.instances.forEach((inst, i) => byId.set(inst.id >>> 0, i))
  const linked = new Set<number>()
  data.instances.forEach((inst, i) => {
    if (inst.links.length) linked.add(i)
    for (const l of inst.links) linked.add(l.target)
  })
  const models = data.models.slice()
  const modelByKey = new Map<string, number>()
  models.forEach((m, i) => modelByKey.set(m.key, i))
  const modelOf = (m: number | NavModel): number => {
    if (typeof m === 'number') {
      if (!Number.isInteger(m) || m < 0 || m >= models.length) throw new Error(`nav edit: model index ${m} out of range`)
      return m
    }
    const key = normKey(m.key)
    let i = modelByKey.get(key)
    if (i === undefined) {
      i = models.length
      models.push(m.key === key ? m : { ...m, key })
      modelByKey.set(key, i)
    }
    return i
  }

  const removed = new Set<number>()
  const missing: number[] = []
  for (const raw of edits.remove ?? []) {
    const id = raw >>> 0
    const i = byId.get(id)
    if (i === undefined) {
      missing.push(id)
      continue
    }
    if (linked.has(i)) throw new Error(`nav edit: instance 0x${id.toString(16)} is linked; links are never edited`)
    removed.add(i)
  }

  const replace = new Map<number, NavInstance>()
  const append: NavInstance[] = []
  const seen = new Set<number>()
  for (const p of edits.put ?? []) {
    const id = p.id >>> 0
    if (seen.has(id)) throw new Error(`nav edit: instance 0x${id.toString(16)} put twice`)
    seen.add(id)
    if (![p.x, p.y, p.z, p.yaw].every(Number.isFinite)) throw new Error(`nav edit: instance 0x${id.toString(16)} has a non-finite transform`)
    const inst: NavInstance = { id, objId: p.objId, model: modelOf(p.model), x: p.x, y: p.y, z: p.z, yaw: p.yaw, links: [] }
    const i = byId.get(id)
    if (i === undefined) {
      append.push(inst)
      continue
    }
    if (linked.has(i)) throw new Error(`nav edit: instance 0x${id.toString(16)} is linked; links are never edited`)
    removed.delete(i)
    replace.set(i, inst)
  }

  const remap = new Int32Array(data.instances.length).fill(-1)
  const instances: NavInstance[] = []
  data.instances.forEach((inst, i) => {
    if (removed.has(i)) return
    remap[i] = instances.length
    instances.push(replace.get(i) ?? inst)
  })
  // Links only join kept, unedited instances (linked ones can be neither removed nor replaced): re-index them.
  if (removed.size) {
    for (let k = 0; k < instances.length; k++) {
      const inst = instances[k]!
      if (!inst.links.length) continue
      instances[k] = { ...inst, links: inst.links.map(l => ({ ...l, target: remap[l.target]! })) }
    }
  }
  for (const inst of append) instances.push(inst)
  return {
    data: { ...data, models, instances },
    remap,
    removed: removed.size,
    replaced: replace.size,
    added: append.length,
    missing,
  }
}

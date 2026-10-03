/**
 * NavData: the serializable navigation model (docs/NAVIGATION.md §9.1) and its builder.
 *
 * Space: world FILE space, the frame every native rule is stated in (NAVIGATION.md §9): left-handed, +Y up,
 * 1 unit = 1 dm, world = 1920 * (rx, rz) + region-local position. The glTF/Babylon frame of the world viewer is
 * a thin conversion on top (gltf.ts), mirroring packages/convert/src/gltf/space.ts.
 *
 * Content:
 * - regions: per .nvm the 97 x 97 height grid, the 96 x 96 tile -> cell map, the open cell count (cells
 *   [0, openCellCount) are walkable; cells tile the region exactly, so the tile map alone locates them) and the
 *   6 x 6 ice/water planes. Terrain edges are not kept: the cell test is equivalent (§2).
 * - models: one object navmesh per collision .bms, shared by all instances (vertices, triangle cells,
 *   outline/inline edges with flags, events), object-local file space, exactly as parsed.
 * - instances: the .nvm object records (= the .o2 placements whose object has a collision navmesh, §4.1),
 *   deduplicated on (regionId, localUid), with their world position, yaw and resolved links (§4.3).
 */
import { NVM_HEIGHTS, NVM_REGION_SIZE, NVM_TILES, type BmsNavMesh, type NvmFile } from '@sro/formats'

export const NAV_DATA_VERSION = 1

export interface NavRegion {
  /** Region id z << 8 | x. */
  id: number
  rx: number
  rz: number
  openCellCount: number
  /** 97 x 97 terrain heights (file units), index gz * 97 + gx. */
  heights: Float32Array
  /** 96 x 96 cell index per 20-unit tile, index tz * 96 + tx. */
  tileCells: Int32Array
  /** 6 x 6 NVM_PLANE_TYPE, or undefined when the file has none. */
  planeTypes?: Uint8Array
  planeHeights?: Float32Array
}

export interface NavEdges {
  /** 2 vertex indices per edge. */
  vertices: Uint16Array
  /** 2 cells per edge (src, dst); 0xFFFF = none (outline dst is always none). */
  cells: Uint16Array
  /** NVM_EDGE_FLAG bits. */
  flags: Uint8Array
}

export interface NavModel {
  /** Collision .bms path (normalized: lower case, forward slashes). */
  key: string
  /** 3 floats per vertex, object-local file space. */
  vertices: Float32Array
  /** 3 vertex indices per triangle cell. */
  cells: Uint16Array
  outline: NavEdges
  inline: NavEdges
  /** Event zone names (dungeon doors, fortress structures); not used by the walker. */
  events: string[]
}

export interface NavLink {
  /** Outline edge of this instance's model. */
  edge: number
  /** Index into NavData.instances. */
  target: number
  /** Outline edge of the target's model. */
  targetEdge: number
}

export interface NavInstance {
  /** World id: regionId << 16 | localUid (unsigned). */
  id: number
  objId: number
  /** Index into NavData.models. */
  model: number
  /** World file space position. */
  x: number
  y: number
  z: number
  /** Radians about +Y as stored; local -> world is (x + c lx - s lz, y + ly, z + s lx + c lz). */
  yaw: number
  links: NavLink[]
}

export interface NavData {
  version: number
  regions: NavRegion[]
  models: NavModel[]
  instances: NavInstance[]
}

/** What buildNavData needs from a parsed .nvm (parseNvm result). */
export type NvmInput = Pick<NvmFile, 'objects' | 'openCellCount' | 'tileCells' | 'heights' | 'planeTypes' | 'planeHeights'>

/** What buildNavData needs from a parsed BMS navmesh (parseBms().navMesh). */
export type NavMeshInput = Pick<BmsNavMesh, 'vertices' | 'cells' | 'outlineEdges' | 'inlineEdges' | 'events'>

export interface NavBuildInput {
  /** Parsed terrain navmeshes; id = z << 8 | x (outdoor regions only). */
  regions: ReadonlyArray<{ id: number; nvm: NvmInput }>
  /**
   * The collision navmesh of an object.ifo id (NAVIGATION.md §3.1: .bsr collision mesh, or the collision .bsr of a
   * .cpd). key names the mesh so instances share it. null/undefined: no navmesh (the instance is skipped).
   */
  objectNavMesh: (objId: number) => { key: string; navMesh: NavMeshInput } | null | undefined
}

export const regionCoords = (id: number) => ({ rx: id & 0xff, rz: (id >> 8) & 0xff })

const normKey = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/**
 * Builds NavData from parsed client structures. Instances come from the .nvm object lists (positions relative to
 * each file's region), deduplicated on (regionId, localUid); links index the same file's object list.
 * Problems (missing meshes, dungeon regions) go to `warnings`.
 */
export function buildNavData(input: NavBuildInput, warnings: string[] = []): NavData {
  const regions: NavRegion[] = []
  const models: NavModel[] = []
  const modelIndex = new Map<string, number>()
  const instances: NavInstance[] = []
  const instanceIndex = new Map<number, number>()
  const linkSeen = new Set<string>()

  const modelFor = (objId: number): number => {
    const found = input.objectNavMesh(objId)
    if (!found) return -1
    const key = normKey(found.key)
    let index = modelIndex.get(key)
    if (index === undefined) {
      index = models.length
      models.push(toModel(key, found.navMesh))
      modelIndex.set(key, index)
    }
    return index
  }

  const seenRegions = new Set<number>()
  for (const { id, nvm } of input.regions) {
    if (id & 0x8000) {
      warnings.push(`region 0x${id.toString(16)}: dungeon regions are not supported`)
      continue
    }
    if (seenRegions.has(id)) continue
    seenRegions.add(id)
    const { rx, rz } = regionCoords(id)
    if (nvm.heights.length !== NVM_HEIGHTS * NVM_HEIGHTS || nvm.tileCells.length !== NVM_TILES * NVM_TILES) {
      throw new Error(`region 0x${id.toString(16)}: bad grid sizes`)
    }
    const region: NavRegion = {
      id, rx, rz,
      openCellCount: nvm.openCellCount,
      heights: Float32Array.from(nvm.heights),
      tileCells: Int32Array.from(nvm.tileCells),
    }
    if (nvm.planeTypes && nvm.planeHeights) {
      region.planeTypes = Uint8Array.from(nvm.planeTypes)
      region.planeHeights = Float32Array.from(nvm.planeHeights)
    }
    regions.push(region)
  }

  // Instances first (every file), then links (they may point at instances listed by another file first).
  const fileInstances: number[][] = []
  for (const { id, nvm } of input.regions) {
    const local: number[] = []
    fileInstances.push(local)
    if (id & 0x8000) continue
    const { rx, rz } = regionCoords(id)
    for (const o of nvm.objects) {
      const key = o.regionId * 0x10000 + o.localUid
      let index = instanceIndex.get(key)
      if (index === undefined) {
        const model = modelFor(o.objId)
        if (model < 0) {
          warnings.push(`object ${o.objId} (region 0x${o.regionId.toString(16)} uid ${o.localUid}): no navmesh`)
          index = -1
        } else {
          index = instances.length
          instances.push({
            id: key,
            objId: o.objId,
            model,
            x: NVM_REGION_SIZE * rx + o.position[0],
            y: o.position[1],
            z: NVM_REGION_SIZE * rz + o.position[2],
            yaw: o.yaw,
            links: [],
          })
        }
        instanceIndex.set(key, index)
      }
      local.push(index)
    }
  }
  input.regions.forEach(({ nvm }, f) => {
    const local = fileInstances[f]!
    if (!local.length) return
    nvm.objects.forEach((o, i) => {
      const self = local[i]!
      if (self < 0) return
      for (const l of o.links) {
        if (l.linkedObject < 0 || l.edge < 0 || l.linkedObjectEdge < 0) continue
        const target = local[l.linkedObject]
        if (target === undefined || target < 0) continue
        const inst = instances[self]!
        const own = models[inst.model]!.outline.flags.length
        const other = models[instances[target]!.model]!.outline.flags.length
        if (l.edge >= own || l.linkedObjectEdge >= other) {
          warnings.push(`instance ${inst.id}: link edge out of range`)
          continue
        }
        const key = `${self}:${l.edge}`
        if (linkSeen.has(key)) continue
        linkSeen.add(key)
        inst.links.push({ edge: l.edge, target, targetEdge: l.linkedObjectEdge })
      }
    })
  })
  return { version: NAV_DATA_VERSION, regions, models, instances }
}

function toModel(key: string, nav: NavMeshInput): NavModel {
  const edges = (e: NavMeshInput['outlineEdges']): NavEdges => ({
    vertices: Uint16Array.from(e.vertices),
    cells: Uint16Array.from(e.cells),
    flags: Uint8Array.from(e.flags),
  })
  return {
    key,
    vertices: Float32Array.from(nav.vertices),
    cells: Uint16Array.from(nav.cells),
    outline: edges(nav.outlineEdges),
    inline: edges(nav.inlineEdges),
    events: [...nav.events],
  }
}

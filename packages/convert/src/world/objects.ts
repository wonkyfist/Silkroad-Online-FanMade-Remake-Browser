/**
 * Region objects: .o2 placements -> deduplicated WorldPlacements, .cpd compounds expanded, every unique .bsr
 * converted once with gltf/convert.ts convertResource (lightmaps on).
 *
 * Placement rules (docs/TERRAIN.md 6, packages/formats/src/mapo.ts):
 * - .o2 lists an object in every block it overlaps and in neighbouring regions' files; repeats of one
 *   (regionId, uid) are byte-identical, so the key is (regionId, uid). A repeat with another objId or position is
 *   counted as a conflict and the first record wins. Regions without .o2 fall back to .o (owner = the file's region).
 * - position is relative to the OWNER region (regionId), y absolute; world file space = 1920 * owner + position.
 * - rotation = mapoYawQuat(yaw) in file space; both go through space.ts (toGltfPosition / toGltfQuat).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import {
  MAPO_STATIC,
  mapoRegionCoords,
  mapoYawQuat,
  parseCpd,
  parseDdj,
  decodeDds,
  parseMapO,
  type MapO,
  type ObjectIfo,
  type Pk2Archive,
} from '@sro/formats'
import { convertResource, LIGHTMAP_EXTRAS_KEY, type Sidecar } from '../gltf/convert.ts'
import { toGltfPosition, toGltfQuat, type Vec3 } from '../gltf/space.ts'
import { validateGlb } from '../gltf/validate.ts'
import { encodePng } from '../png.ts'
import { roundM } from './format.ts'
import type { WorldModel, WorldPlacement } from './manifest.ts'

export const REGION_UNITS = 1920

/** 'res\\bldg\\china\\x.bsr' -> 'bldg/china/x' (lower case, forward slashes, no res/ prefix, no extension). */
export function outputStem(dataPath: string): string {
  const parts = dataPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  if (parts[0] === 'res') parts.shift()
  return parts.join('/').replace(/\.[^./]*$/, '')
}

export const normKey = (p: string) => p.replace(/\\/g, '/').toLowerCase()

export interface RawRecord {
  objId: number
  position: Vec3
  staticFlag: number
  yaw: number
  uid: number
  isBig: number
  isStruct: number
  /** Owner region. */
  regionId: number
  group: number
}

export interface CollectedPlacements {
  records: number
  unique: RawRecord[]
  conflicts: number
  missingFiles: string[]
}

/** Reads the .o2 (or .o) of every region and deduplicates on (regionId, uid). */
export function collectPlacements(map: Pk2Archive, regions: ReadonlyArray<{ x: number; z: number }>): CollectedPlacements {
  const seen = new Map<number, RawRecord>()
  const unique: RawRecord[] = []
  const missingFiles: string[] = []
  let records = 0
  let conflicts = 0
  for (const { x, z } of regions) {
    const fileRegion = (z << 8) | x
    let mapo: MapO | null = null
    for (const kind of ['o2', 'o'] as const) {
      const path = `${z}/${x}.${kind}`
      if (!map.has(path)) continue
      mapo = parseMapO(map.read(path), kind)
      break
    }
    if (!mapo) {
      missingFiles.push(`${z}/${x}.o2`)
      continue
    }
    for (const block of mapo.blocks) {
      block.groups.forEach((list, group) => {
        for (const p of list) {
          records++
          const regionId = p.regionId ?? fileRegion
          const key = regionId * 0x10000 + p.uid
          const prev = seen.get(key)
          if (prev) {
            if (prev.objId !== p.objId || prev.position.some((v, i) => v !== p.position[i])) conflicts++
            continue
          }
          const rec: RawRecord = {
            objId: p.objId,
            position: [...p.position] as Vec3,
            staticFlag: p.staticFlag,
            yaw: p.yaw,
            uid: p.uid,
            isBig: p.isBig,
            isStruct: p.isStruct,
            regionId,
            group,
          }
          seen.set(key, rec)
          unique.push(rec)
        }
      })
    }
  }
  unique.sort((a, b) => a.regionId - b.regionId || a.uid - b.uid)
  return { records, unique, conflicts, missingFiles }
}

/** glTF translation of a record relative to the floating origin (SW corner of `origin`). */
export function placementPosition(rec: Pick<RawRecord, 'position' | 'regionId'>, origin: { x: number; z: number }): Vec3 {
  const owner = mapoRegionCoords(rec.regionId)
  return toGltfPosition([
    REGION_UNITS * (owner.x - origin.x) + rec.position[0],
    rec.position[1],
    REGION_UNITS * (owner.z - origin.z) + rec.position[2],
  ])
}

export function placementRotation(yaw: number): [number, number, number, number] {
  return toGltfQuat(mapoYawQuat(yaw))
}

export interface ModelJob {
  source: string
  stem: string
}

/** object.ifo entry -> the .bsr resources to draw (a .cpd expands to its children; its collision BSR is not drawn). */
export function resolveObject(objId: number, ifo: ObjectIfo, data: Pk2Archive, warnings: string[]):
  { source: string; compound: boolean; resources: string[] } | null {
  const entry = ifo.byIndex.get(objId)
  if (!entry) {
    warnings.push(`object.ifo has no entry ${objId}`)
    return null
  }
  const source = entry.path
  if (!source.toLowerCase().endsWith('.cpd')) return { source, compound: false, resources: [source] }
  try {
    const cpd = parseCpd(data.read(source))
    const resources: string[] = []
    for (const child of cpd.resourcePaths) {
      if (data.has(child)) resources.push(child)
      else warnings.push(`${source}: child ${child} not in Data.pk2`)
    }
    return { source, compound: true, resources }
  } catch (e) {
    warnings.push(`${source}: ${(e as Error).message}`)
    return { source, compound: true, resources: [] }
  }
}

export interface ModelConversion {
  model: WorldModel
  sidecar: Sidecar | null
  lightmaps: string[]
}

/** Clip to loop for a world object: first clip of the 'default' aniGroup, else the first clip. */
export function defaultClip(sidecar: Sidecar): string | null {
  return (sidecar.animations.find(a => a.group === 'default') ?? sidecar.animations[0])?.name ?? null
}

/**
 * Converts one resource to <outDir>/models/<stem>.glb + .json. Lightmap .ddj files are recorded in `lightmapUris`
 * (Data path key -> manifest-relative PNG) for the caller to decode once.
 */
export async function convertModel(index: number, job: ModelJob, data: Pk2Archive, outDir: string,
  lightmapUris: Map<string, string>, validate: boolean): Promise<ModelConversion> {
  const glbRel = `models/${job.stem}.glb`
  const sidecarRel = `models/${job.stem}.json`
  const lightmaps: string[] = []
  try {
    const { document, sidecar } = convertResource(job.source, {
      read: p => data.read(p),
      lightmaps: {
        uri: p => {
          const key = normKey(p)
          if (!data.has(p)) return null
          let uri = lightmapUris.get(key)
          if (!uri) {
            uri = `lightmaps/${outputStem(p)}.png`
            lightmapUris.set(key, uri)
          }
          lightmaps.push(p)
          return uri
        },
      },
    })
    for (const material of document.getRoot().listMaterials()) {
      const lm = material.getExtras()[LIGHTMAP_EXTRAS_KEY] as { uri: string | null } | undefined
      if (lm && lm.uri === null) sidecar.warnings.push(`material ${material.getName()}: lightmap file missing`)
    }
    const glb = await new NodeIO().writeBinary(document)
    let validatorErrors: number | null = null
    if (validate) {
      const v = await validateGlb(glb, `${job.stem}.glb`)
      validatorErrors = v.errors
      sidecar.validation = { errors: v.errors, warnings: v.warnings, infos: v.infos, issues: [] }
    }
    const glbFile = join(outDir, ...glbRel.split('/'))
    mkdirSync(dirname(glbFile), { recursive: true })
    writeFileSync(glbFile, glb)
    writeFileSync(join(outDir, ...sidecarRel.split('/')), JSON.stringify(sidecar, null, 2) + '\n')
    const s = sidecar.stats
    return {
      sidecar,
      lightmaps,
      model: {
        index,
        source: job.source,
        glb: glbRel,
        sidecar: sidecarRel,
        kind: s.joints > 0 ? 'skinned' : 'static',
        animations: sidecar.animations.map(a => a.name),
        defaultClip: defaultClip(sidecar),
        lightmappedMeshes: sidecar.meshes.filter(m => m.lightmap).length,
        boundsMin: s.boundsMin,
        boundsMax: s.boundsMax,
        bytes: glb.byteLength,
        validatorErrors,
      },
    }
  } catch (e) {
    return {
      sidecar: null,
      lightmaps,
      model: {
        index,
        source: job.source,
        glb: null,
        sidecar: null,
        kind: 'failed',
        animations: [],
        defaultClip: null,
        lightmappedMeshes: 0,
        boundsMin: [0, 0, 0],
        boundsMax: [0, 0, 0],
        bytes: 0,
        validatorErrors: null,
        error: (e as Error).message,
      },
    }
  }
}

/** DDJ (Data/Map/Media) -> RGBA PNG at <outDir>/<rel>; returns the image size and bytes written. */
export function ddjToPng(bytes: Uint8Array, outDir: string, rel: string): { width: number; height: number; bytes: number } {
  const img = decodeDds(parseDdj(bytes).dds)
  const png = encodePng(img.width, img.height, img.rgba)
  const file = join(outDir, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
  return { width: img.width, height: img.height, bytes: png.byteLength }
}

export function toPlacement(rec: RawRecord, origin: { x: number; z: number }, source: string, compound: boolean,
  models: number[], converted: ReadonlySet<number>): WorldPlacement {
  return {
    objId: rec.objId,
    source,
    models,
    compound,
    position: placementPosition(rec, origin).map(roundM) as Vec3,
    rotation: placementRotation(rec.yaw),
    yaw: rec.yaw,
    flags: { static: rec.staticFlag === MAPO_STATIC, big: rec.isBig !== 0, struct: rec.isStruct !== 0 },
    staticFlag: rec.staticFlag,
    uid: rec.uid,
    region: rec.regionId,
    group: rec.group,
    inConvertedRegion: converted.has(rec.regionId),
  }
}

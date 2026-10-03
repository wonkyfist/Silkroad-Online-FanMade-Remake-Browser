/**
 * Object id -> collision navmesh (docs/NAVIGATION.md §3.1): object.ifo path; a .bsr's collision mesh, or for a .cpd
 * its collision .bsr's collision mesh; that .bms's navmesh section. Environment-neutral: the caller supplies file
 * reads (Data.pk2 paths as stored, backslashes allowed).
 */
import { parseBms, parseBsr, parseCpd, type ObjectIfo } from '@sro/formats'
import type { NavBuildInput, NavMeshInput } from './data.ts'

export type ReadFile = (pk2Path: string) => Uint8Array | undefined

export function createObjectNavMeshResolver(objectIfo: Pick<ObjectIfo, 'byIndex'>, read: ReadFile,
  warnings: string[] = []): NavBuildInput['objectNavMesh'] {
  const byObject = new Map<number, { key: string; navMesh: NavMeshInput } | null>()
  const byMesh = new Map<string, NavMeshInput | null>()
  const fail = (what: string) => {
    warnings.push(what)
    return null
  }
  const resolve = (objId: number): { key: string; navMesh: NavMeshInput } | null => {
    const entry = objectIfo.byIndex.get(objId)
    if (!entry) return fail(`object.ifo has no entry ${objId}`)
    let bsrPath = entry.path
    try {
      if (bsrPath.toLowerCase().endsWith('.cpd')) {
        const bytes = read(bsrPath)
        if (!bytes) return fail(`${bsrPath}: missing`)
        bsrPath = parseCpd(bytes).collisionPath
        if (!bsrPath) return null
      }
      const bsrBytes = read(bsrPath)
      if (!bsrBytes) return fail(`${bsrPath}: missing`)
      const meshPath = parseBsr(bsrBytes).collision.meshPath
      if (!meshPath) return null
      const key = meshPath.replace(/\\/g, '/').toLowerCase()
      let navMesh = byMesh.get(key)
      if (navMesh === undefined) {
        const bmsBytes = read(meshPath)
        navMesh = bmsBytes ? parseBms(bmsBytes).navMesh ?? null : fail(`${meshPath}: missing`)
        byMesh.set(key, navMesh)
      }
      return navMesh ? { key, navMesh } : null
    } catch (e) {
      return fail(`object ${objId} (${entry.path}): ${(e as Error).message}`)
    }
  }
  return objId => {
    let r = byObject.get(objId)
    if (r === undefined) {
      r = resolve(objId)
      byObject.set(objId, r)
    }
    return r
  }
}

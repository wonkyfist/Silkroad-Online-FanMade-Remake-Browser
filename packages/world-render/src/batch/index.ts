/**
 * The region batching part (docs/BATCHING.md §3; docs/WAVE_PLAN6.md §6.1 BT-M). World calls `createBatchPart` on the
 * PBR path of a streamed world when batching is on (LoadWorldOptions.batching, World.setBatching).
 *
 * The part merges each region's static objects into a handful of meshes on the material table (region-batch.ts,
 * merge-core.ts, the merge worker). It is made only when the material table exists: without it every group would be a
 * per-material group (region-batch.ts's material mode), which draws today's image with about today's draws and more
 * geometry memory, so batching would stay off (today's chunks) without a table. BT-A's table (`batch/{table, atlas,
 * lightmaps}.ts`) with BT-P's `SRO_TABLE` is wired in by default (`createMaterialTable`; I-10R, WAVE_PLAN6 §6.2:
 * BT-A → BT-M → BT-P); `setBatchTables(null)` turns the part off. Tests and the lab make the part directly: `new
 * RegionBatchPart(host, { tables })`, `tables: null` for the material mode.
 */
import { RegionBatchPart, type BatchTables } from './region-batch.ts'
import { createMaterialTable } from './table.ts'
import type { BatchHost, BatchPart } from './types.ts'

export { RegionBatchPart, createMergeWorker, type BatchTableEntry, type BatchTables, type GroupMaterialKey, type RegionBatchOptions } from './region-batch.ts'

/** Makes a world's material table (BT-A); null: none on this world. */
export type BatchTablesFactory = (host: BatchHost) => BatchTables | null

/** The default material table: BT-A's (table.ts), drawn through BT-P's SRO_TABLE. */
export const DEFAULT_BATCH_TABLES: BatchTablesFactory = host => createMaterialTable(host)

let tablesFactory: BatchTablesFactory | null = DEFAULT_BATCH_TABLES

/**
 * Wires the material table the batching part uses (default: BT-A's `createMaterialTable`). null: no table, no
 * batching (today's chunks). Worlds made afterwards use it; a running world picks it up at its next
 * World.setBatching / path switch.
 */
export function setBatchTables(factory: BatchTablesFactory | null): void {
  tablesFactory = factory
}

/** The batching part for a world (null: no material table yet, or the table is not available here). */
export function createBatchPart(host: BatchHost): BatchPart | null {
  if (host.path !== 'pbr' || !tablesFactory) return null
  const tables = tablesFactory(host)
  if (!tables) return null
  return new RegionBatchPart(host, { tables })
}

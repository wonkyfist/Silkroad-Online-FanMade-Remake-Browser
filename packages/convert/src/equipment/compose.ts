/**
 * Character + equipment composition lives in @sro/appearance (packages/appearance/src/compose.ts), shared by the
 * game client, the model viewer and the converter. Re-exported here for the converter's tools and tests.
 */
export {
  composeEquipment,
  composeWorn,
  indexManifest,
  missingJoints,
  wornCodes,
  type BoundItem,
  type Composition,
  type EquipmentLookup,
  type RejectedItem,
} from '@sro/appearance'

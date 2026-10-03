/**
 * Layer-mask bit of the ground meshes (terrain, water, ice): outside Babylon's default camera mask 0x0FFFFFFF like
 * WORLD_OBJECT_LAYER (objects.ts) and SHADOW_PROXY_LAYER (render/shadows.ts), and the ground keeps its default bits, so
 * it changes no draw. Lights meant for characters only (the game's hit flashes) exclude it, so on a 4-light PBR
 * terrain or water material they never take a slot from the celestial or the night lights (L3).
 */
export const WORLD_GROUND_LAYER = 0x40000000

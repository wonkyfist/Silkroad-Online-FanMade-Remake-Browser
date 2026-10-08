/**
 * The character creator's state (docs/CHARACTERS.md §16.10), engine- and DOM-free: the look being edited, every edit
 * clamped to what the body offers (packages/shared/src/look.ts), and the messages it ends in. creator.ts draws it.
 *
 * Two modes: `new` (a new character: name, weapon, gender, the look; charCreate carries it) and `edit` (the one-time
 * re-customise of a character made before the creator: its current look pre-filled, its gender fixed; charLook with the
 * look, or without one to keep the default). The face shape is never an option: only the pack's makeup maps.
 */
import {
  CHARACTER_NAME,
  LOOK_ACCESSORIES,
  LOOK_BUILD_DEFAULT,
  LOOK_HAIR_COLORS,
  LOOK_HAIRS,
  LOOK_IRISES,
  LOOK_LIMITS,
  LOOK_MAKEUPS,
  LOOK_PAINTS,
  LOOK_SKIN_TONES,
  defaultLook,
  lookHairId,
  parseLook,
  type CharLook,
  type CharacterSummary,
  type ClientMessage,
  type LookBody,
  type LookBuild,
  type StarterWeapon,
} from '@sro/shared'

export type CreatorTab = 'body' | 'face' | 'eyes' | 'hair' | 'skin' | 'markings' | 'accessories'
export const CREATOR_TABS: readonly CreatorTab[] = ['body', 'face', 'eyes', 'hair', 'skin', 'markings', 'accessories']
/** Tabs whose camera frames the face (the others the whole body). */
export const FACE_TABS: ReadonlySet<CreatorTab> = new Set(['face', 'eyes', 'hair'])
/** The build sliders the creator shows (bone girths in safe limits; the body-shape sliders come later). */
export const BUILD_SLIDERS: readonly (keyof LookBuild)[] = ['weight', 'muscle', 'shoulders', 'chest', 'hips']
/** A new character's look starts on this outfit variant (outfits by gear dress it in game). */
export const NEW_OUTFIT = '01'

export interface CreatorState {
  mode: 'new' | 'edit'
  look: CharLook
  name: string
  weapon: StarterWeapon
  /** Edit mode: the character being re-customised. */
  character: CharacterSummary | null
  /** The starter clothing preview (else the pack's underwear). */
  clothes: boolean
  tab: CreatorTab
}

/** A fresh look for a new character of `body` (outfit 01 with its hair, the body's defaults). */
export function newLook(body: LookBody, height = 2): CharLook {
  const l = defaultLook(body, 0, height)
  return { ...l, outfit: NEW_OUTFIT, hair: NEW_OUTFIT, accessories: body === 'f' ? ['earrings'] : [] }
}

export function newCreator(body: LookBody = 'f'): CreatorState {
  return { mode: 'new', look: newLook(body), name: '', weapon: 'blade', character: null, clothes: false, tab: 'body' }
}

/** Edit mode: the character's current look (or its body's default when it has none the client can read). */
export function editCreator(character: CharacterSummary, body: LookBody): CreatorState {
  const look = character.look && character.look.body === body ? character.look : defaultLook(body, character.id, character.height ?? 2, character.volume ?? 2)
  return { mode: 'edit', look: structuredClone(look), name: character.name, weapon: character.weapon, character, clothes: false, tab: 'body' }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

/** Every edit the screen makes; returns false when nothing changed (the screen then skips the redraw). */
export const edit = {
  gender(s: CreatorState, body: LookBody): boolean {
    if (s.mode === 'edit' || s.look.body === body) return false
    s.look = newLook(body, s.look.height)
    return true
  },
  height(s: CreatorState, v: number): boolean {
    const n = clamp(v, LOOK_LIMITS.height[0], LOOK_LIMITS.height[1])
    if (n === s.look.height) return false
    s.look.height = n
    return true
  },
  build(s: CreatorState, k: keyof LookBuild, v: number): boolean {
    const n = clamp(v, LOOK_LIMITS.build[0], LOOK_LIMITS.build[1])
    if (s.look.build[k] === n) return false
    s.look.build = { ...s.look.build, [k]: n }
    return true
  },
  resetBuild(s: CreatorState): boolean {
    s.look.build = { ...LOOK_BUILD_DEFAULT[s.look.body] }
    return true
  },
  makeup(s: CreatorState, v: string): boolean {
    if (!LOOK_MAKEUPS[s.look.body].includes(v) || s.look.makeup === v) return false
    s.look.makeup = v
    return true
  },
  iris(s: CreatorState, v: string): boolean {
    if (!LOOK_IRISES.includes(v) || s.look.iris === v) return false
    s.look.iris = v
    return true
  },
  hairStyle(s: CreatorState, style: number): boolean {
    const id = lookHairId(s.look.body, style, hairOf(s).bangs)
    if (id === s.look.hair) return false
    s.look.hair = id
    return true
  },
  bangs(s: CreatorState, on: boolean): boolean {
    const id = lookHairId(s.look.body, hairOf(s).style, on)
    if (id === s.look.hair) return false
    s.look.hair = id
    return true
  },
  hairColor(s: CreatorState, v: number): boolean {
    const n = clamp(v, 0, LOOK_HAIR_COLORS.length)
    if (n === s.look.hairColor) return false
    s.look.hairColor = n
    return true
  },
  skinTone(s: CreatorState, v: number): boolean {
    const n = clamp(v, 0, LOOK_SKIN_TONES.length)
    if (n === s.look.skinTone) return false
    s.look.skinTone = n
    return true
  },
  skinShift(s: CreatorState, v: number): boolean {
    const n = clamp(v, LOOK_LIMITS.skinShift[0], LOOK_LIMITS.skinShift[1])
    if (n === s.look.skinShift) return false
    s.look.skinShift = n
    return true
  },
  /** One paint at most; null = none. */
  paint(s: CreatorState, id: string | null): boolean {
    const next = id && LOOK_PAINTS[id] ? [id] : []
    if (next.join() === s.look.markings.join()) return false
    s.look.markings = next
    return true
  },
  accessory(s: CreatorState, id: string, on: boolean): boolean {
    if (!LOOK_ACCESSORIES[s.look.body].includes(id) || s.look.accessories.includes(id) === on) return false
    s.look.accessories = on ? [...s.look.accessories, id] : s.look.accessories.filter(a => a !== id)
    return true
  },
}

export function hairOf(s: CreatorState): { style: number; bangs: boolean } {
  return LOOK_HAIRS[s.look.body][s.look.hair] ?? { style: 1, bangs: true }
}

/** The name problem shown before asking the server (null: looks fine). */
export function nameProblem(name: string): string | null {
  return CHARACTER_NAME.test(name.trim()) ? null : 'create.nameRule'
}

/** The look as the server will store it (parseLook: the same checks the server runs), or the first problem. */
export function checkedLook(s: CreatorState): { ok: true; look: CharLook } | { ok: false; error: string } {
  return parseLook(s.look, s.look.body)
}

/** New mode: the charCreate message (the classic fields mirror the look: height; the starter garment). */
export function createMessage(s: CreatorState, model: string): Extract<ClientMessage, { t: 'charCreate' }> | null {
  const r = checkedLook(s)
  if (!r.ok || nameProblem(s.name)) return null
  return { t: 'charCreate', name: s.name.trim(), model, weapon: s.weapon, height: r.look.height, volume: 2, outfit: 'clothes', look: r.look }
}

/** Edit mode: the charLook message; `skip` keeps the character's default look (the offer is used up either way). */
export function lookMessage(s: CreatorState, skip = false): Extract<ClientMessage, { t: 'charLook' }> | null {
  if (!s.character) return null
  if (skip) return { t: 'charLook', id: s.character.id }
  const r = checkedLook(s)
  return r.ok ? { t: 'charLook', id: s.character.id, look: r.look } : null
}

/** Character select: whether entering the world goes through the creator first (the one-time re-customise). */
export function offersCreator(character: CharacterSummary, available: boolean): boolean {
  return available && character.customise === true
}

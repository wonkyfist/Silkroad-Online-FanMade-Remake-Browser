/**
 * docs/SOUND.md §10 (the missing-sound pass): imbue, Berserk and shield-buff hit layers, Berserk swings, the item
 * placement and drop sounds, the crit moan, mob attacks without swing tracks, and the carried-effects tracker. Pure
 * resolution plus GameAudio / EntitySound over a fake backend; no browser.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateSoundIndex, type ClipTrack, type ModelSounds, type SoundIndex } from '@sro/shared'
import type { AudioBackend, SoundBuffer, StartOptions } from '../src/audio/backend.ts'
import { SoundBank, type FetchResponse } from '../src/audio/bank.ts'
import { CarriedSkills } from '../src/audio/carried.ts'
import type { ClipCursor } from '../src/audio/clips.ts'
import { dropCue, equipKind, hitSound, hwanSwingCue, isBasicGroup, placedItem, trackFile, type HitQuery } from '../src/audio/cues.ts'
import { EntitySound, type SoundView } from '../src/audio/entity.ts'
import { GameAudio } from '../src/audio/index.ts'
import { AudioSettings } from '../src/audio/settings.ts'

const FILES = [
  'player/batswordhit1n', 'player/batswordhit2n', 'player/batcrihit', 'player/bathwanhit', 'player/bathwancrihit', 'player/hwswordswing',
  'player/hwbladeswing', 'player/batswordswing1', 'skill/csk_cold_gigong_hit', 'skill/csk_light_gigong_hit', 'skill/csk_sword_hit_c',
  'skill/csk_cold_hosin_hit', 'skill/csk_sword_swing_b', 'monster/cm_tiger_moan1', 'monster/cm_tiger_moan2', 'monster/cm_tomb_force1_swing',
  'monster/cm_tomb_force1_hit', 'monster/cm_tomb_moan1', 'ui/itring', 'ui/itsword', 'ui/itmetal', 'ui/itpotion', 'ui/itquickicon',
  'ui/itfly_rarebox', 'ui/itfly_elixir', 'ui/itgold', 'ui/itrevive',
]
const set = (w: string, s: string) => ({ weak: { n: w }, strong: { n: s }, gain: 1 })

function index(): SoundIndex {
  const cue = (files: string[], category: 'ui' | 'sfx' = 'sfx', gain = 1) => ({ files, gain, category })
  return {
    format: 'sro-sound',
    version: 1,
    generator: 'test',
    generatedAt: '2026-10-05T00:00:00Z',
    codec: 'opus',
    wavFallback: false,
    files: Object.fromEntries(FILES.map(id => [id, { url: `sound/${id}.ogg`, ms: 300, channels: 1 as const, bytes: 1000 }])),
    cues: {
      'hit.crit': cue(['player/batcrihit']),
      'hit.hwan': cue(['player/bathwanhit']),
      'hit.hwanCrit': cue(['player/bathwancrihit']),
      'swing.hwan.SWORD': cue(['player/hwswordswing']),
      'swing.hwan.BLADE': cue(['player/hwswordswing']),
      'item.equip.RING': cue(['ui/itring'], 'ui', 0.8),
      'item.equip.EARRING': cue(['ui/itring'], 'ui', 0.8),
      'item.equip.NECKLACE': cue(['ui/itring'], 'ui', 0.8),
      'item.equip.SWORD': cue(['ui/itsword'], 'ui', 0.8),
      'item.equip.POTION': cue(['ui/itpotion'], 'ui', 0.8),
      'item.equip.METAL': cue(['ui/itmetal'], 'ui', 0.8),
      'item.equip.QUICKSLOT': cue(['ui/itquickicon'], 'ui', 0.8),
      'item.dropGold': cue(['ui/itgold']),
      'item.dropRare': cue(['ui/itfly_rarebox']),
      'item.dropElixir': cue(['ui/itfly_elixir']),
      'ui.revive': cue(['ui/itrevive'], 'ui'),
    },
    steps: { walk: {}, run: {}, objectFloor: 'Stone' },
    hits: { SWORD: set('player/batswordhit1n', 'player/batswordhit2n') },
    skills: {
      SKILL_CH_SWORD_BASE: { dmg: set('player/batswordhit1n', 'player/batswordhit2n') },
      SKILL_CH_SWORD_SMASH_A: { swing: { snd_swing_s1: ['skill/csk_sword_swing_b'] }, dmg: ['skill/csk_sword_hit_c'] },
      SKILL_CH_COLD_GIGONGTA_A: { dmg: ['skill/csk_cold_gigong_hit'] },
      SKILL_CH_LIGHTNING_GIGONGTA_A: { dmg: ['skill/csk_light_gigong_hit'] },
      SKILL_CH_COLD_BINGBYEOK_A: { swing: { snd_ddmg: ['skill/csk_cold_hosin_hit'] } },
    },
    voices: {},
    mobs: {
      MOB_CH_TIGER: {
        object: 'MOB_TIGER', moan: { normal: ['monster/cm_tiger_moan1'], crit: ['monster/cm_tiger_moan2'] }, deathVoice: [], deathThud: [],
        shout1: [], shout2: [], avoid: [], gain: 0.8, walk: [], attacks: {},
      },
      MOB_CH_TOMBSTONE: {
        object: 'MOB_TOMBSTONE', moan: { normal: ['monster/cm_tomb_moan1'], crit: [] }, deathVoice: [], deathThud: [], shout1: [], shout2: [],
        avoid: [], gain: 0.8, walk: [], attacks: { MSKILL_CH_TOMBSTONE_ATTACK02: { swing: ['monster/cm_tomb_force1_swing'], dmg: ['monster/cm_tomb_force1_hit'] } },
      },
    },
    models: {},
    areas: {},
    report: { sourceFiles: 1, sourceBytes: 1, outBytes: 1, tracks: 0, unresolved: [], notExported: [] },
  }
}

const player = { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', family: 'sword' as const }
const mob = { kind: 'mob', model: 'MOB_CH_MANGNYANG' }
const q = (o: Partial<HitQuery>): HitQuery => ({ skill: 'SKILL_CH_SWORD_BASE_01', attacker: player, victim: mob, outcome: 'hit', rng: () => 0, ...o })

describe('hit layers (§10.3)', () => {
  it('the fixture index is valid', () => {
    expect(validateSoundIndex(index())).toEqual([])
  })

  it("an imbued attacker's landed hits add the imbue's SND_DMG; blocks and misses do not", () => {
    const idx = index()
    expect(hitSound(idx, q({ imbue: 'SKILL_CH_COLD_GIGONGTA_A' }))!.files).toEqual(['player/batswordhit1n', 'skill/csk_cold_gigong_hit'])
    expect(hitSound(idx, q({ imbue: 'SKILL_CH_LIGHTNING_GIGONGTA_A', outcome: 'crit' }))!.files).toEqual(['player/batswordhit2n', 'player/batcrihit', 'skill/csk_light_gigong_hit'])
    // Skill attacks carry the imbue too (the visuals do, M14).
    expect(hitSound(idx, q({ skill: 'SKILL_CH_SWORD_SMASH_A_01', imbue: 'SKILL_CH_COLD_GIGONGTA_A' }))!.files).toEqual(['skill/csk_sword_hit_c', 'skill/csk_cold_gigong_hit'])
    expect(hitSound(idx, q({ imbue: 'SKILL_CH_COLD_GIGONGTA_A', outcome: 'block' }))?.files ?? []).not.toContain('skill/csk_cold_gigong_hit')
    expect(hitSound(idx, q({ imbue: 'SKILL_CH_COLD_GIGONGTA_A', outcome: 'miss' }))).toBeNull()
    // Without an imbue: the weapon alone, as before.
    expect(hitSound(idx, q({}))!.files).toEqual(['player/batswordhit1n'])
  })

  it('Berserk basic attacks play the HWAN hit and crit rows; Berserk skill hits keep their own row', () => {
    const idx = index()
    expect(hitSound(idx, q({ hwan: true }))!.files).toEqual(['player/bathwanhit'])
    expect(hitSound(idx, q({ hwan: true, outcome: 'crit' }))!.files).toEqual(['player/bathwanhit', 'player/bathwancrihit'])
    expect(hitSound(idx, q({ hwan: true, skill: 'SKILL_CH_SWORD_SMASH_A_01', outcome: 'crit' }))!.files).toEqual(['skill/csk_sword_hit_c', 'player/bathwancrihit'])
    // A mob never uses the player's Berserk rows.
    expect(hitSound(idx, q({ hwan: true, attacker: { kind: 'mob', model: 'MOB_CH_TIGER' }, victim: { kind: 'player', model: 'X' } }))?.files ?? []).not.toContain('player/bathwanhit')
  })

  it("a shield buff the victim carries adds its SND_DDMG (Ice Wall's csk_cold_hosin_hit)", () => {
    const idx = index()
    expect(hitSound(idx, q({ guards: ['SKILL_CH_SWORD_SMASH_A', 'SKILL_CH_COLD_BINGBYEOK_A'] }))!.files).toEqual(['player/batswordhit1n', 'skill/csk_cold_hosin_hit'])
    expect(hitSound(idx, q({ guards: ['SKILL_CH_SWORD_SMASH_A'] }))!.files).toEqual(['player/batswordhit1n'])
  })

  it('basic groups and the Berserk swing cue of each weapon family', () => {
    expect([null, 'SKILL_CH_SWORD_BASE', 'SKILL_CH_BOW_BASE', 'SKILL_PUNCH'].every(isBasicGroup)).toBe(true)
    expect(isBasicGroup('SKILL_CH_SWORD_SMASH_A')).toBe(false)
    expect(['sword', 'blade', 'spear', 'glaive', 'bow', null].map(f => hwanSwingCue(f as never))).toEqual([
      'swing.hwan.SWORD', 'swing.hwan.BLADE', 'swing.hwan.SPEAR', 'swing.hwan.SPEAR', 'swing.hwan.BOW', 'swing.hwan.PUNCH',
    ])
  })

  it('Berserk replaces the basic swing tracks only', () => {
    const idx = index()
    const swing: ClipTrack = { ms: 185, handle: 'swing', raw: 'snd_swing1', file: 'player/batswordswing1' }
    const skillSwing: ClipTrack = { ms: 415, handle: 'swing', raw: 'snd_swing_s1', file: 'skill/csk_sword_swing_a' }
    const ctx = { surface: () => 'Dirt' as const, skill: null, overrideSwing: true, rng: () => 0, hwanSwing: ['player/hwswordswing'] }
    expect(trackFile(idx, swing, ctx)).toBe('player/hwswordswing')
    expect(trackFile(idx, swing, { ...ctx, hwanSwing: null })).toBe('player/batswordswing1')
    expect(trackFile(idx, skillSwing, { ...ctx, skill: 'SKILL_CH_SWORD_SMASH_A' })).toBe('skill/csk_sword_swing_b')
    expect(trackFile(idx, swing, { ...ctx, skill: 'SKILL_CH_SWORD_SMASH_A' })).toBe('player/batswordswing1')
  })
})

describe('items (§10.3)', () => {
  it('accessories, consumables and quest items have their SND_EQUIP kind', () => {
    expect(equipKind({ category: 'accessory', slot: 'ring' })).toBe('RING')
    expect(equipKind({ category: 'accessory', slot: 'earring' })).toBe('EARRING')
    expect(equipKind({ category: 'accessory', slot: 'necklace' })).toBe('NECKLACE')
    expect(equipKind({ category: 'potion' })).toBe('POTION')
    expect(equipKind({ category: 'alchemy' })).toBe('POTION')
    expect(equipKind({ category: 'pill' })).toBe('HERB')
    expect(equipKind({ category: 'scroll' })).toBe('SCROLL')
    expect(equipKind({ category: 'ammo' })).toBe('QUIVER')
    expect(equipKind({ category: 'quest' })).toBe('MOBPIECE')
  })

  it('an own placement request names the item it moves; other requests none', () => {
    const inv = {
      item: (s: number) => (s === 3 ? { code: 'ITEM_CH_RING_01_A' } : s === 4 ? { code: 'ITEM_ETC_HP_POTION_01' } : null),
      equipped: (s: string) => (s === 'necklace' ? { code: 'ITEM_CH_NECKLACE_01_A' } : null),
    }
    expect(placedItem({ t: 'itemEquip', bag: 3 }, inv)).toBe('ITEM_CH_RING_01_A')
    expect(placedItem({ t: 'itemMove', from: 4, to: 9 }, inv)).toBe('ITEM_ETC_HP_POTION_01')
    expect(placedItem({ t: 'itemSplit', from: 4, to: 9, count: 2 }, inv)).toBe('ITEM_ETC_HP_POTION_01')
    expect(placedItem({ t: 'itemUnequip', slot: 'necklace' }, inv)).toBe('ITEM_CH_NECKLACE_01_A')
    expect(placedItem({ t: 'itemEquip', bag: 7 }, inv)).toBeNull()
    expect(placedItem({ t: 'itemUse', bag: 4 }, inv)).toBeNull()
  })

  it('drops: gold, Seal of Star items and alchemy items have a cue; the rest drop silently', () => {
    expect(dropCue('ITEM_ETC_GOLD_02', { category: 'gold' })).toBe('item.dropGold')
    expect(dropCue('ITEM_CH_SWORD_03_A_RARE', { category: 'weapon' })).toBe('item.dropRare')
    expect(dropCue('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', { category: 'alchemy' })).toBe('item.dropElixir')
    expect(dropCue('ITEM_CH_SWORD_03_A', { category: 'weapon' })).toBeNull()
    expect(dropCue('ITEM_ETC_HP_POTION_01', undefined)).toBeNull()
  })
})

describe('CarriedSkills', () => {
  it('tracks imbues and buffs per entity from the effect messages', () => {
    const c = new CarriedSkills(code => /_GIGONGTA_/.test(code))
    c.set(1, [{ instance: 1, skill: 'SKILL_CH_COLD_BINGBYEOK_A_01', remainingMs: 1000 }, { instance: 2, status: 'stun', remainingMs: 500 }])
    expect(c.groupsOf(1)).toEqual(['SKILL_CH_COLD_BINGBYEOK_A'])
    expect(c.imbueOf(1)).toBeNull()
    c.add(1, { instance: 3, skill: 'SKILL_CH_LIGHTNING_GIGONGTA_A_03', remainingMs: 30000 })
    expect(c.imbueOf(1)).toBe('SKILL_CH_LIGHTNING_GIGONGTA_A')
    c.remove(1, 3)
    expect(c.imbueOf(1)).toBeNull()
    c.forget(1)
    expect(c.groupsOf(1)).toEqual([])
    c.set(2, undefined)
    expect(c.groupsOf(2)).toEqual([])
  })
})

// ---- GameAudio / EntitySound over a fake backend -----------------------------------------------------------

/** Decoded buffers remember their file, so the backend records what really started. */
type FileBuffer = SoundBuffer & { file: string }
const decode = async (bytes: ArrayBuffer): Promise<FileBuffer> => ({ duration: 0.3, bytes: 1000, file: new TextDecoder().decode(bytes).replace(/^\/out\/sound\/|\.ogg$/g, '') })

class FakeBackend implements AudioBackend {
  ready = true
  started: (StartOptions & { file: string })[] = []
  now(): number {
    return 0
  }
  async decode(bytes: ArrayBuffer): Promise<SoundBuffer> {
    return decode(bytes)
  }
  start(b: SoundBuffer, opts: StartOptions) {
    this.started.push({ ...opts, file: (b as FileBuffer).file })
    return { stop: () => opts.onEnded?.(), setPosition: () => {} }
  }
  setBusGain(): void {}
  setListener(): void {}
  suspend(): void {}
  resume(): void {}
}

const fetchAll = (extra: Record<string, unknown> = {}) => async (url: string): Promise<FetchResponse> => {
  const known = url.startsWith('/out/sound/') && url.endsWith('.ogg') ? 1 : extra[url]
  return { ok: known !== undefined, status: known === undefined ? 404 : 200, json: async () => known, arrayBuffer: async () => new TextEncoder().encode(url).buffer as ArrayBuffer }
}

const ITEMS: Record<string, unknown> = {
  ITEM_CH_RING_01_A: { category: 'accessory', slot: 'ring' },
  ITEM_CH_EARRING_01_A: { category: 'accessory', slot: 'earring' },
  ITEM_ETC_HP_POTION_01: { category: 'potion' },
  ITEM_CH_SWORD_03_A_RARE: { category: 'weapon', weaponType: 'sword' },
}

async function ready() {
  const backend = new FakeBackend()
  let clock = 0
  const audio = new GameAudio({
    backend,
    settings: new AudioSettings(null),
    bank: new SoundBank({ fetch: fetchAll(), decode }),
    itemDef: code => ITEMS[code] as never,
    rng: () => 0,
    clock: () => clock,
  })
  audio.bank.setIndex(index())
  await Promise.all(FILES.map(id => audio.bank.load(id)))
  const played = () => backend.started.map(v => v.file)
  return { audio, backend, played, advance: (ms: number) => (clock += ms) }
}

describe('GameAudio (§10)', () => {
  it("an accessory put on plays the ring's SND_EQUIP; a potion moved its own; an unknown item the METAL one", async () => {
    const { audio, backend, played } = await ready()
    audio.place('ITEM_CH_RING_01_A')
    audio.place('ITEM_CH_EARRING_01_A')
    audio.place('ITEM_ETC_HP_POTION_01')
    audio.place('ITEM_NOT_IN_CATALOG')
    expect(played()).toEqual(['ui/itring', 'ui/itring', 'ui/itpotion', 'ui/itmetal'])
    expect(backend.started.every(s => s.bus === 'ui' && !s.pos)).toBe(true)
  })

  it('a placement whose sound is still loading plays once it arrives (the first accessory equip was lost)', async () => {
    const backend = new FakeBackend()
    let clock = 0
    const audio = new GameAudio({
      backend,
      settings: new AudioSettings(null),
      bank: new SoundBank({ fetch: async url => (await new Promise(r => setTimeout(r, 30)), fetchAll()(url)), decode }),
      itemDef: code => ITEMS[code] as never,
      clock: () => clock,
    })
    audio.bank.setIndex(index())
    audio.place('ITEM_CH_RING_01_A')
    clock += 200 // later than the 150 ms an interface click waits
    await new Promise(r => setTimeout(r, 120))
    expect(backend.started).toHaveLength(1)
  })

  it('world enter preloads every item.equip cue', async () => {
    const backend = new FakeBackend()
    const log: string[] = []
    const audio = new GameAudio({
      backend,
      settings: new AudioSettings(null),
      bank: new SoundBank({ fetch: async url => (log.push(url), fetchAll({ '/out/sound/index.json': index() })(url)), decode }),
    })
    audio.preloadWorld([])
    await new Promise(r => setTimeout(r, 30))
    for (const f of ['ui/itring', 'ui/itsword', 'ui/itpotion', 'ui/itquickicon', 'ui/itfly_rarebox', 'ui/itrevive']) expect(log, f).toContain(`/out/sound/${f}.ogg`)
  })

  it('drops play where they land: a Seal of Star item its rare cue; a plain item nothing', async () => {
    const { audio, played, backend } = await ready()
    audio.drop('ITEM_CH_SWORD_03_A_RARE', { x: 1, y: 0, z: 1 })
    audio.drop('ITEM_CH_RING_01_A', { x: 1, y: 0, z: 1 })
    expect(played()).toEqual(['ui/itfly_rarebox'])
    expect(backend.started[0]!.pos).toEqual({ x: 1, y: 0, z: 1 })
  })

  it("a crit imbued hit plays every layer: the victim's 2-sfx cap counts the impact only", async () => {
    const { audio, played } = await ready()
    audio.hit(q({ imbue: 'SKILL_CH_COLD_GIGONGTA_A', outcome: 'crit', guards: ['SKILL_CH_COLD_BINGBYEOK_A'] }), { entity: 7, pos: { x: 0, y: 0, z: 0 }, self: false, priority: 2 })
    expect(played()).toEqual(['player/batswordhit2n', 'player/batcrihit', 'skill/csk_cold_gigong_hit', 'skill/csk_cold_hosin_hit'])
  })

  it('a crit on a mob plays its VOC_MOAN CRITYCAL row', async () => {
    const { audio, played } = await ready()
    audio.hit(q({ outcome: 'crit', victim: { kind: 'mob', model: 'MOB_CH_TIGER' } }), { entity: 7, pos: { x: 0, y: 0, z: 0 }, self: false, priority: 2 })
    expect(played()).toContain('monster/cm_tiger_moan2')
  })
})

describe('EntitySound (§10)', () => {
  const cur = (name: string, ms: number, run = 1): ClipCursor => ({ name, ms, run, durationMs: 1500 })
  const viewOf = (model: string, cursors: () => { top: ClipCursor | null; overlay: ClipCursor | null }, kind: SoundView['kind'] = 'mob'): SoundView => ({
    id: 9,
    kind,
    state: { model },
    root: { position: { x: 1, y: 0, z: 1 } },
    actor: { clipCursors: cursors },
    dead: false,
    isSelf: false,
  })
  const withModel = (audio: GameAudio, m: ModelSounds | null) => (audio.bank as unknown as { models: Map<string, unknown> }).models.set(m?.code ?? 'MOB_CH_TOMBSTONE', m)

  it("a mob attack clip without swing tracks plays its attack's effectsound swing once per start (Tombstone)", async () => {
    const { audio, played, advance } = await ready()
    withModel(audio, { format: 'sro-sound-model', version: 1, code: 'MOB_CH_TOMBSTONE', bsr: 'x', clips: { DAMAGE1: [{ ms: 0, handle: 'moan', raw: 'voc_moan', file: 'monster/cm_tomb_moan1' }] } })
    audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    let c: ClipCursor | null = cur('STAND1', 100)
    const s = new EntitySound(audio, viewOf('MOB_CH_TOMBSTONE', () => ({ top: c, overlay: null })))
    s.update(0)
    c = cur('ATTACK1', 10)
    s.update(16)
    c = cur('ATTACK1', 400)
    s.update(400)
    expect(played()).toEqual(['monster/cm_tomb_force1_swing'])
    c = cur('ATTACK1', 10, 2)
    advance(1600)
    s.update(1600)
    expect(played().filter(f => f === 'monster/cm_tomb_force1_swing')).toHaveLength(2)
  })

  it("a crit's hurt-clip moan is the critical one", async () => {
    const { audio, played } = await ready()
    const tiger: ModelSounds = { format: 'sro-sound-model', version: 1, code: 'MOB_CH_TIGER', bsr: 'x', clips: { DAMAGE1: [{ ms: 0, handle: 'moan', raw: 'voc_moan', file: 'monster/cm_tiger_moan1' }] } }
    withModel(audio, tiger)
    audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
    let overlay: ClipCursor | null = null
    const s = new EntitySound(audio, viewOf('MOB_CH_TIGER', () => ({ top: cur('STAND1', 0), overlay })))
    s.update(0)
    overlay = cur('DAMAGE1', 5, 1)
    s.update(16)
    s.critHit(20)
    overlay = cur('DAMAGE1', 5, 2)
    s.update(40)
    expect(played()).toEqual(['monster/cm_tiger_moan1', 'monster/cm_tiger_moan2'])
  })

  it('in Berserk a player swings with the HWAN file', async () => {
    const { audio, played } = await ready()
    const m: ModelSounds = { format: 'sro-sound-model', version: 1, code: 'CHAR_CH_MAN_ADVENTURER', bsr: 'x', clips: { ATTACK1: [{ ms: 100, handle: 'swing', raw: 'snd_swing1', file: 'player/batswordswing1' }] } }
    withModel(audio, m)
    let c = cur('ATTACK1', 0)
    const s = new EntitySound(audio, { ...viewOf('CHAR_CH_MAN_ADVENTURER', () => ({ top: c, overlay: null }), 'player'), isSelf: true })
    s.setHwanSwing(audio.index!.cues[hwanSwingCue('sword')]!.files)
    s.update(0)
    c = cur('ATTACK1', 200)
    s.update(200)
    s.setHwanSwing(null)
    c = cur('ATTACK1', 0, 2)
    s.update(1600)
    c = cur('ATTACK1', 200, 2)
    s.update(1800)
    expect(played()).toEqual(['player/hwswordswing', 'player/batswordswing1'])
  })
})


// ---- the real export (skips without work/out/sound/index.json) --------------------------------------------

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const REAL = join(REPO, 'work/out/sound/index.json')
const ITEMS_JSON = join(REPO, 'work/out/data/items.json')
const SKILLS_JSON = join(REPO, 'work/out/data/skills.json')
const CUE_SHAPE = /'((?:ui|item|hit|block|swing|berserk|cos|town|weather)\.[A-Za-z0-9_.]*[A-Za-z0-9_])'/g
/** A line that plays a cue: audio.ui(…), gameAudio()?.play(…), cue(…), sound(view, …), a *Cue helper. */
const PLAY_LINE = /([Aa]udio(\(\))?\??\.(ui|play)\(|\bcue\(|\bsound\(|[Cc]ue\b)/

/** Every cue name the client plays: all of apps/game/src/audio, plus the playing lines elsewhere (not i18n keys). */
function clientCues(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'i18n') walk(p)
        continue
      }
      if (!e.name.endsWith('.ts')) continue
      const all = /[\\/]audio$/.test(dir)
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!all && !PLAY_LINE.test(line)) continue
        for (const m of line.matchAll(CUE_SHAPE)) out.add(m[1]!)
      }
    }
  }
  walk(join(REPO, 'apps/game/src'))
  return out
}

describe.skipIf(!existsSync(REAL))('the exported index against the client (§10)', () => {
  const idx = JSON.parse(readFileSync(REAL, 'utf8')) as SoundIndex
  const onDisk = (id: string) => !!idx.files[id] && existsSync(join(REPO, 'work/out', ...idx.files[id]!.url.split('/')))

  it('every cue the client plays is exported, with its files on disk', () => {
    const cues = clientCues()
    // The scan must see the new triggers (a broken scan would pass vacuously).
    for (const c of ['ui.revive', 'ui.questOpen', 'ui.hyan', 'item.equip.QUICKSLOT', 'hit.hwan', 'item.dropRare', 'berserk.start']) expect(cues.has(c), c).toBe(true)
    const missing = [...cues].filter(c => !idx.cues[c]?.files.length || !idx.cues[c]!.files.every(onDisk))
    expect(missing).toEqual([])
  })

  it.skipIf(!existsSync(ITEMS_JSON))('every wearable, accessory and consumable in items.json has an exported equip cue (the ring "diiing")', () => {
    const items = (JSON.parse(readFileSync(ITEMS_JSON, 'utf8')) as { entries: Array<{ code: string; category: string; slot?: string; weaponType?: string; armorType?: string }> }).entries
    const misses: string[] = []
    for (const it of items) {
      if (it.category === 'gold') continue
      const cue = `item.equip.${equipKind(it as never)}`
      if (!idx.cues[cue]?.files.every(onDisk)) misses.push(`${it.code} -> ${cue}`)
    }
    expect(misses).toEqual([])
    const ring = items.find(i => i.category === 'accessory' && i.slot === 'ring')!
    expect(idx.cues[`item.equip.${equipKind(ring as never)}`]!.files).toEqual(['ui/itring'])
  })

  it.skipIf(!existsSync(SKILLS_JSON))('every imbue in skills.json hits with an exported element sound', () => {
    const skills = (JSON.parse(readFileSync(SKILLS_JSON, 'utf8')) as { entries: Array<{ code: string; kind?: string }> }).entries
    const groups = [...new Set(skills.filter(s => s.kind === 'imbue').map(s => s.code.replace(/_\d+$/, '')))]
    expect(groups.length).toBeGreaterThanOrEqual(3)
    for (const g of groups) {
      const s = hitSound(idx, q({ imbue: g }))
      expect(s?.files.length, g).toBe(2)
      expect(s!.files[1], g).toMatch(/^skill\/csk_(cold|light|fire)_gigong_hit$/)
      expect(onDisk(s!.files[1]!), g).toBe(true)
    }
  })
})

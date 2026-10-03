// Equipment panel of the model viewer: pick a character (gender) and an item per slot, see them composed on the
// animated character. Data: /out/equipment/equipment.json (pnpm tsx packages/convert/src/tools/export-equipment.ts).
import {
  composeEquipment,
  EQUIPMENT_MANIFEST,
  indexManifest,
  isEquipmentManifest,
  type CharacterBody,
  type Composition,
  type EquipmentItem,
  type EquipmentLookup,
  type EquipmentManifest,
  type Gender,
} from '@sro/appearance'
import type { Viewer } from '../viewer.ts'
import './equip.css'
import { Dresser } from './dresser.ts'

type Slot = EquipmentItem['slot']
const SLOTS: ReadonlyArray<[Slot, string]> = [
  ['head', 'Head'], ['shoulders', 'Shoulders'], ['chest', 'Chest'], ['legs', 'Legs'],
  ['hands', 'Hands'], ['feet', 'Feet'], ['weapon', 'Weapon'], ['shield', 'Shield'],
]
const CLASS_LABEL: Record<string, string> = { garment: 'Garment', protector: 'Protector', armor: 'Armour' }
const STARTER: ReadonlyArray<[string, string]> = [['CLOTHES', 'Garment'], ['LIGHT', 'Protector'], ['HEAVY', 'Armour']]

export interface EquipmentPanelHost {
  viewer: Viewer
  /** Loads a model by index.json id (the character glbs are /out/char/...). */
  selectModel(id: string): Promise<void>
  setStatus(text: string, kind?: 'info' | 'error'): void
  /** Called after the selection changed (URL state). */
  changed(): void
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children)
  return el
}

/** '/out/char/china/chinaman_adventurer.glb' -> index.json id 'char/china/chinaman_adventurer'. */
function modelId(glb: string): string {
  return glb.replace(/^\/?out\//, '').replace(/\.glb$/, '')
}

export class EquipmentPanel {
  private manifest: EquipmentManifest | null = null
  private lookup: EquipmentLookup | null = null
  private readonly dresser: Dresser
  private readonly character: HTMLSelectElement
  private readonly selects = new Map<Slot, HTMLSelectElement>()
  private readonly info: HTMLDivElement
  private readonly enabled: HTMLInputElement
  private composition: Composition | null = null

  constructor(private readonly root: HTMLElement, private readonly host: EquipmentPanelHost) {
    this.dresser = new Dresser(host.viewer.scene)
    this.enabled = h('input', { type: 'checkbox', checked: true })
    this.character = h('select', { ariaLabel: 'Character' })
    this.info = h('div', { className: 'muted equip-info' })
    root.replaceChildren(h('div', { className: 'muted' }, 'Loading equipment.json…'))
  }

  async load(initialEquip: string | null): Promise<void> {
    const res = await fetch(new URL(EQUIPMENT_MANIFEST, new URL('out/', document.baseURI)), { cache: 'no-cache' })
    if (!res.ok) {
      this.root.replaceChildren(h('div', { className: 'muted' },
        `/out/${EQUIPMENT_MANIFEST}: HTTP ${res.status}. Run pnpm tsx packages/convert/src/tools/export-equipment.ts`))
      return
    }
    const data: unknown = await res.json()
    if (!isEquipmentManifest(data)) throw new Error(`/out/${EQUIPMENT_MANIFEST}: unexpected format`)
    this.manifest = data
    this.lookup = indexManifest(data)
    this.render()
    if (initialEquip) this.setCodes(initialEquip.split(',').filter(Boolean))
  }

  /** Current item codes, comma-separated, for the URL (null when nothing is worn or the panel is off). */
  urlValue(): string | null {
    if (!this.enabled.checked) return null
    const codes = this.codes()
    return codes.length ? codes.join(',') : null
  }

  private codes(): string[] {
    return [...this.selects.values()].map(s => s.value).filter(Boolean)
  }

  private currentCharacter(): CharacterBody | null {
    const model = this.host.viewer.model
    if (!model || !this.manifest) return null
    return this.manifest.characters.find(c => modelId(c.glb) === model.entry.id) ?? null
  }

  private render(): void {
    const m = this.manifest!
    const groups = (['male', 'female'] as Gender[]).map(g => {
      const og = h('optgroup', { label: g === 'male' ? 'Male' : 'Female' })
      og.append(...m.characters.filter(c => c.gender === g).map(c => new Option(c.code.replace(/^CHAR_CH_(MAN|WOMAN)_/, '').toLowerCase(), c.code)))
      return og
    })
    this.character.replaceChildren(new Option('(pick a character)', ''), ...groups)
    this.character.addEventListener('change', () => this.run(async () => {
      const c = m.characters.find(ch => ch.code === this.character.value)
      if (c) await this.host.selectModel(modelId(c.glb))
    }))
    const starters = h('div', { className: 'equip-starters' },
      ...STARTER.map(([token, label]) => {
        const b = h('button', { className: 'small', textContent: label, title: `Creation-default ${label.toLowerCase()} set (*_DEF)` })
        b.addEventListener('click', () => this.starter(token))
        return b
      }),
    )
    const clear = h('button', { className: 'small', textContent: 'Clear' })
    clear.addEventListener('click', () => {
      for (const s of this.selects.values()) s.value = ''
      this.refresh()
    })
    starters.append(clear)
    const grid = h('div', { className: 'equip-slots' })
    for (const [slot, label] of SLOTS) {
      const select = h('select', { ariaLabel: label })
      select.addEventListener('change', () => this.refresh())
      this.selects.set(slot, select)
      grid.append(h('label', { textContent: label }), select)
    }
    this.enabled.addEventListener('change', () => this.refresh())
    this.root.replaceChildren(
      h('label', { className: 'row' }, this.enabled, ' Dress the character'),
      this.character, starters, grid, this.info,
    )
    this.fillOptions()
  }

  /** Item options for the current character's gender (A-grade and creation-default items; B/C share A's model). */
  private fillOptions(): void {
    const m = this.manifest
    if (!m) return
    const gender = this.currentCharacter()?.gender ?? null
    for (const [slot, select] of this.selects) {
      const keep = select.value
      const items = m.items
        .filter(i => i.slot === slot && (!gender || !i.gender || i.gender === gender) && /_A(_DEF)?$/.test(i.code))
        .sort((a, b) => (a.armorClass ?? a.weapon ?? '').localeCompare(b.armorClass ?? b.weapon ?? '') || a.degree - b.degree || a.code.localeCompare(b.code))
      const byGroup = new Map<string, EquipmentItem[]>()
      for (const i of items) {
        const g = `${CLASS_LABEL[i.armorClass ?? ''] ?? i.weapon ?? 'Shield'}${!gender && i.gender ? ` (${i.gender})` : ''}`
        byGroup.set(g, [...(byGroup.get(g) ?? []), i])
      }
      select.replaceChildren(new Option('(none)', ''), ...[...byGroup].map(([g, list]) => {
        const og = h('optgroup', { label: g })
        og.append(...list.map(i => {
          const o = new Option(`${i.degree}° ${i.name ?? i.code}${i.code.endsWith('_DEF') ? ' (default)' : ''}${i.model ? '' : ' (no model)'}`, i.code)
          o.title = `${i.code}\n${i.model ? `${i.model.kind} ${i.model.method} [${i.model.slots.join(', ')}]\n${i.model.glb}` : 'no model: nothing is drawn'}`
          return o
        }))
        return og
      }))
      // Switching gender keeps the same piece: ITEM_CH_W_* <-> ITEM_CH_M_*.
      const twin = gender ? keep.replace(/^ITEM_CH_[MW]_/, `ITEM_CH_${gender === 'male' ? 'M' : 'W'}_`) : keep
      const has = (code: string) => [...select.options].some(o => o.value === code)
      select.value = has(keep) ? keep : has(twin) ? twin : ''
    }
  }

  private setCodes(codes: string[]): void {
    for (const code of codes) {
      const item = this.lookup?.items.get(code)
      const select = item ? this.selects.get(item.slot) : undefined
      if (!select) continue
      if (![...select.options].some(o => o.value === code)) select.append(new Option(item!.name ?? code, code))
      select.value = code
    }
  }

  private starter(token: string): void {
    const c = this.currentCharacter()
    if (!c) return this.host.setStatus('Load a Chinese character first (pick one above).', 'error')
    const g = c.gender === 'male' ? 'M' : 'W'
    for (const [part, slot] of [['BA', 'chest'], ['LA', 'legs'], ['FA', 'feet']] as const) {
      this.selects.get(slot)!.value = `ITEM_CH_${g}_${token}_01_${part}_A_DEF`
    }
    for (const slot of ['head', 'shoulders', 'hands'] as const) this.selects.get(slot)!.value = ''
    this.refresh()
  }

  /** Model changed (or is about to): drop the items that were bound to the old skeleton. */
  beforeModelUnload(): void {
    this.dresser.clear()
    this.composition = null
  }

  /** The viewer loaded a model: sync the character picker and re-dress it. */
  async onModelLoaded(): Promise<void> {
    if (!this.manifest) return
    const c = this.currentCharacter()
    this.character.value = c?.code ?? ''
    this.fillOptions()
    await this.apply()
  }

  /** The last composition drawn (debugging: window.__sro.equip.state). */
  get state(): Composition | null {
    return this.composition
  }

  private refresh(): void {
    this.run(() => this.apply())
  }

  private async apply(): Promise<void> {
    const model = this.host.viewer.model
    const c = this.currentCharacter()
    if (!model || !c || !this.lookup || !this.enabled.checked) {
      this.dresser.clear()
      this.composition = null
      this.info.textContent = c || !model ? '' : `${model.entry.id} is not a Chinese player character`
      this.host.changed()
      return
    }
    const comp = composeEquipment(this.lookup, c.code, this.codes())
    this.composition = comp
    if (!(await this.dresser.apply(model, comp))) return
    this.renderInfo(comp)
    this.host.changed()
  }

  private renderInfo(comp: Composition): void {
    const lines: string[] = []
    lines.push(`hidden: ${comp.hide.length ? comp.hide.join(', ') : 'none'}`)
    for (const d of this.dresser.dressed) {
      const b = d.item
      lines.push(`${b.slot}: ${b.code} — ${d.binding}${b.attachBone ? ` @ ${b.attachBone}` : ''}`)
    }
    for (const code of comp.invisible) lines.push(`${code}: no model`)
    for (const r of comp.rejected) lines.push(`refused ${r.code}: ${r.detail}`)
    this.info.replaceChildren(...lines.map(l => h('div', { textContent: l })))
  }

  private run(task: () => Promise<void>): void {
    task().catch(err => {
      console.error(err)
      this.host.setStatus(err instanceof Error ? err.message : String(err), 'error')
    })
  }
}

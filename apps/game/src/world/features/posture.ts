/**
 * Posture and emotes (docs/EFFECTS.md §3.12, §4 P4; docs/WAVE_PLAN2.md D9, D20, D36), lane FX-C2:
 *  - N sits down or stands up (`sit {on}`), as does `/sitdown`; `/hi`, `/laugh`, `/greeting`, `/yes`, `/rush`, `/joy`,
 *    `/no` send an emote (chat prefixes, ChatBox.registerPrefix);
 *  - the server answers with `entityUpdate {posture}` (SIT_DOWN once, the SIT loop; STAND_UP when it clears) and
 *    `emote {id, emote}` (the EMOTION0N clip once) to every viewer; a late joiner gets `posture: 'sit'` in the spawn
 *    (the idle driver starts seated, world/idle.ts);
 *  - the Action window (MENU → Action, retail `ifaction` layout cut to what exists here): "Character control" with
 *    Sit down / Stand up and "Emotion" with the seven emotes, each a retail action icon in a lattice slot.
 * Refusals (dead, busy) are toasted by the HUD (claimRequests).
 */
import type { EmoteKind, ServerMessage } from '@sro/shared'
import { EMOTE_KINDS } from '@sro/shared'
import type { MenuBarEntry } from '../../hud/menubar.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import type { Art } from '../../ui/art.ts'
import { Section } from '../../ui/kit/section.ts'
import { SlotGrid } from '../../ui/kit/slot.ts'
import { Tooltip } from '../../ui/kit/tooltip.ts'
import { Window } from '../../ui/kit/window.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { EMOTE_CLIP } from '../fx/types.ts'
import { idleOf } from '../idle.ts'

/** Retail action icons (Media icon/action/*.ddj, exported to /out/icon/action/). */
export const ACTION_ICON = {
  sit: '/out/icon/action/icon_cha_sit.png',
  stand: '/out/icon/action/icon_cha_stand.png',
} as const
export const EMOTE_ICON: Readonly<Record<EmoteKind, string>> = {
  hi: '/out/icon/action/emot_act_greeting.png',
  greeting: '/out/icon/action/emot_act_pokun.png',
  laugh: '/out/icon/action/emot_act_laugh.png',
  yes: '/out/icon/action/emot_act_yes.png',
  rush: '/out/icon/action/emot_act_rush.png',
  joy: '/out/icon/action/emot_act_joy.png',
  no: '/out/icon/action/emot_act_no.png',
}
/** The order of the retail Emotion row (UIIT_CTL_EMOT_*). */
export const EMOTE_ORDER: readonly EmoteKind[] = ['hi', 'laugh', 'greeting', 'yes', 'rush', 'joy', 'no']

/** Chat commands (D9): '/sitdown' toggles the seat, '/<emote>' plays it. */
export const SIT_COMMAND = '/sitdown'
export const EMOTE_COMMANDS: Readonly<Record<string, EmoteKind>> = Object.fromEntries(EMOTE_KINDS.map(e => [`/${e}`, e]))

/** Retail ifaction.txt: 36-px slot pitch, 9 slots a row, section frames 364 × 117. */
const SECTION_W = 364
const SECTION_H = 117
const COLS = 9
const ROWS = 2

const CSS = `
.kit-window-action .fx-action-section { position: relative; margin: 0 0 6px; }
.kit-window-action .fx-action-grid { position: absolute; left: 22px; top: 36px; }
.kit-window-action .kit-slot { cursor: pointer; }
.kit-window-action .kit-slot.empty { cursor: default; }
.kit-window-action .kit-slot:not(.empty):hover .kit-slot-icon { filter: brightness(1.25); }
.kit-window-action .kit-slot:not(.empty):active .kit-slot-icon { transform: translate(1px, 1px); }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'fx-action'
  s.textContent = CSS
  document.head.append(s)
}

interface ActionHandlers {
  sit(): void
  emote(e: EmoteKind): void
  sitting(): boolean
}

/** The Action window: Character control (Sit down / Stand up) and Emotion (the seven emotes). */
export class ActionWindow extends Window {
  private readonly sitSlot
  private readonly tip: Tooltip

  constructor(art: Art, parent: HTMLElement, private readonly handlers: ActionHandlers) {
    super(art, parent, { id: 'action', title: t('fx.action.title'), width: SECTION_W + 32, height: SECTION_H * 2 + 6 + 60, at: [0.5, 0.45] })
    ensureStyles()
    this.tip = new Tooltip(art)
    const control = new Section(art, { caption: t('fx.action.sitCaption'), w: SECTION_W, h: SECTION_H, className: 'fx-action-section' })
    const emotion = new Section(art, { caption: t('fx.action.emoteCaption'), w: SECTION_W, h: SECTION_H, className: 'fx-action-section' })
    const controlGrid = new SlotGrid(art, null, COLS, ROWS, { className: 'fx-action-grid' })
    const emoteGrid = new SlotGrid(art, null, COLS, ROWS, { className: 'fx-action-grid' })
    control.root.append(controlGrid.root)
    emotion.root.append(emoteGrid.root)
    this.body.append(control.root, emotion.root)
    for (const s of [...controlGrid.slots, ...emoteGrid.slots]) s.root.classList.add('empty')
    this.sitSlot = controlGrid.slots[0]!
    this.bind(this.sitSlot.root, () => (this.handlers.sitting() ? t('fx.action.stand') : t('fx.action.sit')), () => this.handlers.sit())
    EMOTE_ORDER.forEach((e, i) => {
      const s = emoteGrid.slots[i]!
      s.setIcon(EMOTE_ICON[e], { text: t(`fx.emote.${e}` as StringKey).slice(0, 2) })
      this.bind(s.root, () => t(`fx.emote.${e}` as StringKey), () => this.handlers.emote(e))
    })
    this.refresh()
  }

  private bind(root: HTMLElement, label: () => string, run: () => void): void {
    root.classList.remove('empty')
    this.ls.on(root, 'click', () => run())
    this.ls.on(root, 'pointerenter', ev => this.tip.show([{ text: label(), cls: 'title' }], ev.clientX, ev.clientY))
    this.ls.on(root, 'pointermove', ev => this.tip.move(ev.clientX, ev.clientY))
    this.ls.on(root, 'pointerleave', () => this.tip.hide())
  }

  /** The seat slot shows Stand up while sitting. */
  refresh(): void {
    const sitting = this.handlers.sitting()
    this.sitSlot.setIcon(sitting ? ACTION_ICON.stand : ACTION_ICON.sit, { text: sitting ? 'St' : 'Si' })
    this.sitSlot.root.classList.toggle('on', sitting)
  }

  override close(): void {
    this.tip.hide()
    super.close()
  }

  override dispose(): void {
    this.tip.dispose()
    super.dispose()
  }
}

export function postureFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud, chat } = ctx
  const offs: (() => void)[] = []
  let sittingSelf = false

  const self = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const toggleSit = () => {
    const v = self()
    if (!v || v.dead) return
    ctx.send({ t: 'sit', on: !sittingSelf })
  }
  const emote = (e: EmoteKind) => {
    if (self()?.dead) return
    ctx.send({ t: 'emote', emote: e })
  }

  hud.claimRequests(['sit', 'emote'])
  offs.push(hud.keys.register({ id: 'action.sit', keys: ['n'], label: 'fx.key.sit', group: 'movement', run: () => toggleSit() }))
  offs.push(chat.registerPrefix(SIT_COMMAND, () => toggleSit()))
  for (const [cmd, e] of Object.entries(EMOTE_COMMANDS)) offs.push(chat.registerPrefix(cmd, () => emote(e)))

  const win = new ActionWindow(ctx.app.art, hud.layer, { sit: toggleSit, emote, sitting: () => sittingSelf })
  // D20: the MENU row (UI-H's `icon` field; without it the system-button art is used).
  const entry: MenuBarEntry & { icon?: string } = {
    id: 'action',
    art: 'mainpopup/main_sysbutton_action',
    icon: 'underbar/ub_new_icon_action',
    label: 'fx.action.menu',
    order: 60,
    toggle: () => win.toggle(),
    isOpen: () => win.isOpen,
  }
  offs.push(hud.menubar.register(entry))

  const setSitting = (id: number, on: boolean, transition?: 'play') => {
    const v = ctx.view(id)
    if (v) idleOf(v)?.setReason('sit', on, transition)
    if (id === ctx.selfId()) {
      sittingSelf = on
      win.refresh()
    }
  }

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'entityUpdate':
          if (msg.posture) setSitting(msg.id, msg.posture === 'sit', 'play')
          if (msg.state === 'dead' && msg.id === ctx.selfId()) setSitting(msg.id, false)
          break
        case 'emote': {
          const v = ctx.view(msg.id)
          if (v && !v.dead && !v.moving) v.actor?.playClip(EMOTE_CLIP[msg.emote])
          break
        }
        case 'worldEnter':
          sittingSelf = false
          win.refresh()
          break
      }
    },
    onEntityAdded(v) {
      if (v.id === ctx.selfId()) {
        sittingSelf = v.state.posture === 'sit'
        win.refresh()
      }
    },
    dispose() {
      for (const off of offs) off()
      win.dispose()
    },
  }
}

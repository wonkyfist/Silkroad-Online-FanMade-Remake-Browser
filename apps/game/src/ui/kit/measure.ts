/**
 * Text measuring for auto-fit controls (docs/UI.md §4.3 "Fit rules"): one shared canvas context in the button font.
 * Without a canvas (unit tests, a failed context) a conservative 6.6 px per character is used, the budget of
 * ui-text-fit.test.ts.
 */

/** Conservative width of one character of the 12-px basic font (the i18n budget). */
export const CHAR_PX = 6.6
/** Horizontal padding a label keeps inside its skin, per side. */
export const LABEL_PAD = 8

let ctx: CanvasRenderingContext2D | null | undefined

export const BUTTON_FONT = "12px 'SRO Basic', Tahoma, Verdana, sans-serif"

/** The budget width of `text` (no DOM). */
export function budgetWidth(text: string): number {
  return Math.ceil(text.length * CHAR_PX)
}

/** Measured width of `text` in `font`; the budget width without a canvas. */
export function textWidth(text: string, font = BUTTON_FONT): number {
  if (ctx === undefined) {
    try {
      ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      ctx = null
    }
  }
  if (!ctx) return budgetWidth(text)
  ctx.font = font
  return Math.ceil(ctx.measureText(text).width)
}

/** Width of a control that grows to its label: never below the skin, else label + padding both sides. */
export function fitWidth(skinW: number, labelW: number, pad = LABEL_PAD): number {
  return Math.max(skinW, Math.ceil(labelW) + pad * 2)
}

/** True when the label fits the skin without growing it. */
export function fitsSkin(skinW: number, labelW: number, pad = LABEL_PAD): boolean {
  return labelW + pad * 2 <= skinW
}

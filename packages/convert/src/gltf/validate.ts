import validator, { type ValidationMessage } from 'gltf-validator'

export interface GlbValidation {
  errors: number
  warnings: number
  infos: number
  hints: number
  /** Errors and warnings (all of them), then infos. */
  messages: ValidationMessage[]
  validatorVersion: string
}

/** Runs the Khronos glTF-Validator on a .glb. Severity: 0 error, 1 warning, 2 info, 3 hint. */
export async function validateGlb(glb: Uint8Array, uri = 'model.glb'): Promise<GlbValidation> {
  const report = await validator.validateBytes(glb, { uri, format: 'glb', maxIssues: 0, writeTimestamp: false })
  const { issues } = report
  return {
    errors: issues.numErrors,
    warnings: issues.numWarnings,
    infos: issues.numInfos,
    hints: issues.numHints,
    messages: [...issues.messages].sort((a, b) => a.severity - b.severity),
    validatorVersion: report.validatorVersion,
  }
}

/** "CODE x N" summary of messages at or below a severity. */
export function summarizeIssues(messages: readonly ValidationMessage[], maxSeverity = 1): string[] {
  const counts = new Map<string, number>()
  for (const m of messages) if (m.severity <= maxSeverity) counts.set(m.code, (counts.get(m.code) ?? 0) + 1)
  return [...counts].map(([code, n]) => (n > 1 ? `${code} x${n}` : code))
}

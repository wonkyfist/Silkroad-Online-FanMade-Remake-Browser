// Minimal typings for the Khronos glTF-Validator npm build (it ships none).
declare module 'gltf-validator' {
  export interface ValidationMessage {
    code: string
    message: string
    /** 0 error, 1 warning, 2 info, 3 hint. */
    severity: number
    pointer?: string
    offset?: number
  }
  export interface ValidationReport {
    uri?: string
    validatorVersion: string
    issues: {
      numErrors: number
      numWarnings: number
      numInfos: number
      numHints: number
      messages: ValidationMessage[]
      truncated: boolean
    }
    info?: Record<string, unknown>
  }
  export interface ValidationOptions {
    uri?: string
    format?: 'glb' | 'gltf'
    maxIssues?: number
    ignoredIssues?: string[]
    writeTimestamp?: boolean
    severityOverrides?: Record<string, number>
  }
  export function validateBytes(data: Uint8Array, options?: ValidationOptions): Promise<ValidationReport>
  export function version(): string
}

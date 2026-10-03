/**
 * Runs a deploy/*.sh script with bash from `pnpm run deploy` / `pnpm deploy:gm`.
 *
 * On Windows a bare `bash` from cmd.exe (how pnpm runs scripts) is usually WSL's
 * C:\Windows\System32\bash.exe, which has neither this checkout's paths nor the SSH key, so this finds
 * Git for Windows' bash instead. Override with SRO_BASH=<path to bash>.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function gitBash(): string {
  if (process.env.SRO_BASH) return process.env.SRO_BASH
  if (process.platform !== 'win32') return 'bash'
  const candidates: string[] = []
  try {
    // <git>/mingw64/libexec/git-core -> <git>/bin/bash.exe
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    candidates.push(resolve(execPath, '../../../bin/bash.exe'))
  } catch {
    // git not on PATH: try the usual install locations.
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'))
  }
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error('Git Bash not found. Install Git for Windows, or set SRO_BASH to a bash.exe')
  return found
}

const [script, ...args] = process.argv.slice(2)
if (!script || !/^[a-z-]+\.sh$/.test(script) || !existsSync(join(REPO_ROOT, 'deploy', script))) {
  console.error('usage: tsx deploy/run.ts <deploy.sh|gm.sh> [args...]')
  process.exit(2)
}
const r = spawnSync(gitBash(), [`deploy/${script}`, ...args], { cwd: REPO_ROOT, stdio: 'inherit' })
if (r.error) console.error(r.error.message)
process.exitCode = r.status ?? 1

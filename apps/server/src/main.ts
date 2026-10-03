import { loadConfig } from './config.ts'
import { startServer } from './game.ts'

const config = loadConfig()
const server = await startServer(config)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  config.log(`${signal}: saving and shutting down`)
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  try {
    await server.close()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

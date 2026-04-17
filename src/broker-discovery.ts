import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { BROKER_RENDEZVOUS_FILE } from './constants.js'

export interface BrokerRendezvous {
  port: number
  pid: number
  id: string
}

export function readRendezvous(): BrokerRendezvous | null {
  if (!existsSync(BROKER_RENDEZVOUS_FILE)) return null
  try {
    return JSON.parse(readFileSync(BROKER_RENDEZVOUS_FILE, 'utf-8')) as BrokerRendezvous
  } catch {
    return null
  }
}

export async function probeBroker(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    return res.ok
  } catch {
    return false
  }
}

export async function waitForHealthyRendezvous(timeoutMs: number): Promise<BrokerRendezvous> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = readRendezvous()
    if (r && await probeBroker(r.port)) return r
    await new Promise<void>(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Broker failed to start within ${timeoutMs}ms`)
}

export function removeRendezvous(): void {
  try { unlinkSync(BROKER_RENDEZVOUS_FILE) } catch { /* ignore */ }
}

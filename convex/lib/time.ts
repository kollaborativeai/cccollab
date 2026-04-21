export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000 // 1h
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30d
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000 // 10m

export function nowMs(): number {
  return Date.now()
}

export function isExpired(expiresAt: number): boolean {
  return nowMs() >= expiresAt
}

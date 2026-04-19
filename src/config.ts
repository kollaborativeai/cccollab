import os from 'node:os'

export interface Config {
  username: string
}

export function loadConfig(): Config {
  return {
    username: os.userInfo().username,
  }
}

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/file-lock.js'

const TMP = mkdtempSync(join(tmpdir(), 'cccollab-file-lock-test-'))

describe('writeFileAtomic (KAI-415 I7)', () => {
  beforeEach(() => {
    for (const f of ['target.json', 'target.json.' + process.pid + '.tmp', 'victim.txt']) {
      try {
        rmSync(join(TMP, f), { force: true })
      } catch {
        /* ignore */
      }
    }
  })
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('writes the full contents via rename', () => {
    const target = join(TMP, 'target.json')
    writeFileAtomic(target, '{"ok":true}\n', 0o600)
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ ok: true })
  })

  it('does not write through a pre-planted symlink at the pid tmp path', () => {
    const target = join(TMP, 'target.json')
    const victim = join(TMP, 'victim.txt')
    writeFileSync(victim, 'ORIGINAL')
    const tmp = `${target}.${process.pid}.tmp`
    symlinkSync(victim, tmp)

    // Either: O_EXCL/O_NOFOLLOW refuses the symlink (EEXIST then unlink+create),
    // or unlink of the stale tmp removes the symlink and a real file is written.
    writeFileAtomic(target, '{"safe":true}\n', 0o600)

    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ safe: true })
    // Victim must remain the original content — never the session JSON.
    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL')
    // No leftover tmp symlink.
    if (existsSync(tmp)) {
      expect(lstatSync(tmp).isSymbolicLink()).toBe(false)
    }
  })
})

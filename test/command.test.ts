import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

describe('public command', () => {
  it('packages only the aimux-pulse launcher', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('aimux-pulse')
    expect(pkg.bin).toEqual({ 'aimux-pulse': 'bin/aimux-pulse' })
    await expect(access(path.join(root, 'bin/aimux-pulse'))).resolves.toBeUndefined()
    await expect(access(path.join(root, 'bin/repo-pulse'))).rejects.toThrow()
  })

  it('identifies aimux-pulse in help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, 'src/cli.ts'),
      '--help',
    ])
    expect(stdout).toContain('aimux-pulse [path] [options]')
    expect(stdout).not.toContain('repo-pulse [path]')
  })
})

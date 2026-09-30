import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveWindowsNotebookRuntime,
  windowsNotebookRuntimeEnvironment
} from './windows-notebook-runtime'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const fixture = (): { root: string; resources: string } => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-'))
  roots.push(root)
  const resources = join(root, 'resources')
  mkdirSync(resources)
  return { root, resources }
}
const install = (root: string): void => {
  for (const file of ['node/node.exe', 'powershell/pwsh.exe', 'build.json']) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, '{}')
  }
}

describe('bundled Windows Notebook runtime', () => {
  it('keeps global tools within each workspace and rejects an unspecified destination', () => {
    const runtime = {
      root: 'D:\\runtime',
      node: 'D:\\runtime\\node\\node.exe',
      powershell: 'D:\\runtime\\powershell\\pwsh.exe'
    }
    const first = windowsNotebookRuntimeEnvironment({}, runtime, 'D:\\workspace one')
    const second = windowsNotebookRuntimeEnvironment({}, runtime, 'D:\\workspace two')
    expect(first.NPM_CONFIG_PREFIX).toBe('D:\\workspace one\\.notebook-tools\\npm')
    expect(second.NPM_CONFIG_PREFIX).toBe('D:\\workspace two\\.notebook-tools\\npm')
    expect(first.PATH).not.toContain(second.NPM_CONFIG_PREFIX)
    expect(() => windowsNotebookRuntimeEnvironment({}, runtime, '')).toThrow(
      'absolute workspace root'
    )
    expect(() => windowsNotebookRuntimeEnvironment({}, runtime, 'relative')).toThrow(
      'absolute workspace root'
    )
  })
  it('resolves packaged resources without a system PATH fallback', () => {
    const { root, resources } = fixture()
    const runtimeRoot = join(resources, 'notebook-runtime/x64')
    install(runtimeRoot)
    expect(resolveWindowsNotebookRuntime(resources, root, 'x64')).toEqual({
      root: runtimeRoot,
      node: join(runtimeRoot, 'node/node.exe'),
      powershell: join(runtimeRoot, 'powershell/pwsh.exe')
    })
  })
  it('fails closed for an incomplete packaged runtime even when a dev copy exists', () => {
    const { root, resources } = fixture()
    writeFileSync(join(resources, 'app.asar'), '')
    install(join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64'))
    expect(() => resolveWindowsNotebookRuntime(resources, join(root, 'out/main'), 'x64')).toThrow(
      'runtime is missing'
    )
  })
  it('resolves the development copy relative to the bundled main module', () => {
    const { root, resources } = fixture()
    const runtimeRoot = join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64')
    install(runtimeRoot)
    expect(resolveWindowsNotebookRuntime(resources, join(root, 'out/main'), 'x64').root).toBe(
      runtimeRoot
    )
  })
  it('selects the repaired Node/npm before host tools without mutating the captured environment', () => {
    const original = {
      Path: 'C:\\host',
      PSModulePath: 'C:\\legacy-modules',
      OTHER: 'kept',
      NODE_OPTIONS: '--require C:\\host\\preload.js',
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: 'D:\\cache'
    }
    const env = windowsNotebookRuntimeEnvironment(
      original,
      {
        root: 'D:\\runtime',
        node: 'D:\\runtime\\node\\node.exe',
        powershell: 'D:\\runtime\\powershell\\pwsh.exe'
      },
      'D:\\workspace'
    )
    expect(env).toEqual({
      Path: 'D:\\runtime\\node;D:\\workspace\\.notebook-tools\\npm;C:\\host',
      PSModulePath: 'D:\\runtime\\powershell\\Modules',
      OPEN_SCIENCE_PSMODULEPATH: 'D:\\runtime\\powershell\\Modules',
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: 'D:\\cache',
      NPM_CONFIG_CACHE: 'D:\\cache\\npm',
      NPM_CONFIG_PREFIX: 'D:\\workspace\\.notebook-tools\\npm',
      OTHER: 'kept'
    })
    expect(original.Path).toBe('C:\\host')
  })
})

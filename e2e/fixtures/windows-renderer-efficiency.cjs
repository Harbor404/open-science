'use strict'

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron test preload is plain CommonJS. */

// Test-only preloader: drive the production app without attaching a DevTools client. Playwright's
// Electron loader and focus emulation suppress native background scheduling even for hidden windows.
const { app, BrowserWindow } = require('electron')
const { execFile } = require('node:child_process')
const { writeFile } = require('node:fs/promises')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evidence = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  phases: {}
}

const waitFor = async (read, description, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await read()) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const saveEvidence = () =>
  writeFile(process.env.OPEN_SCIENCE_POWER_EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8')

app
  .whenReady()
  .then(async () => {
    let window
    try {
      await waitFor(
        () => {
          window = BrowserWindow.getAllWindows()[0]
          return Boolean(window)
        },
        'the production main window',
        180_000
      )

      const waitForWorkspace = () =>
        waitFor(
          async () => {
            try {
              return await window.webContents.executeJavaScript(
                `Boolean(document.querySelector('section[aria-label="Projects"]'))`
              )
            } catch {
              // The first document/preload and application database may still be starting or reloading.
              return false
            }
          },
          'the production workspace',
          180_000
        )
      await waitForWorkspace()

      const recordPower = async (phase, efficient) => {
        await waitFor(async () => {
          const rendererPid = window.webContents.getOSProcessId()
          const { stdout } = await execFileAsync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              process.env.OPEN_SCIENCE_POWER_QUERY,
              '-MainProcessId',
              String(process.pid),
              '-RendererProcessId',
              String(rendererPid)
            ],
            { windowsHide: true, timeout: 15_000 }
          )
          const power = JSON.parse(stdout)
          evidence.phases[phase] = {
            ...power,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            backgroundThrottling: window.webContents.getBackgroundThrottling()
          }
          await saveEvidence()
          return (
            power.main.priority === 0x20 &&
            !power.main.ecoQoS &&
            power.renderer.priority === (efficient ? 0x40 : 0x20) &&
            power.renderer.ecoQoS === efficient
          )
        }, `native process power in ${phase}`)
      }

      const restore = () => {
        window.restore()
        window.show()
        window.focus()
      }
      restore()
      await waitFor(() => window.isVisible() && !window.isMinimized(), 'the visible window')
      await recordPower('visible', false)
      window.minimize()
      await waitFor(() => window.isMinimized(), 'the minimized window')
      await recordPower('minimized', true)
      restore()
      await waitFor(() => window.isVisible() && !window.isMinimized(), 'the restored window')
      await recordPower('restored', false)
      // The isolated settings select the real production minimize-to-tray close action.
      window.close()
      await waitFor(() => !window.isDestroyed() && !window.isVisible(), 'the tray-hidden window')
      await recordPower('tray', true)
      restore()
      await waitFor(
        () => window.isVisible() && !window.isMinimized(),
        'the window shown from the tray'
      )
      await recordPower('shown-from-tray', false)
      const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await reloaded
      await waitForWorkspace()
      await recordPower('reloaded', false)
      window.minimize()
      await waitFor(() => window.isMinimized(), 'the minimized reloaded window')
      await recordPower('minimized-after-reload', true)
      restore()
      evidence.completed = true
      await saveEvidence()
      app.quit()
    } catch (error) {
      evidence.error = String(error)
      await saveEvidence().catch(() => undefined)
      console.error(error)
      app.exit(1)
    }
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

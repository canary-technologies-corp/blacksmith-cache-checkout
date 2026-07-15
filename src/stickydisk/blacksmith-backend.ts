import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import type {GetStickyDiskResponse} from '../gen/stickydisk/v1/stickydisk_pb'
import type {StickyDiskBackend} from './backend'

// Durability flush + unmount tuning (Blacksmith VMs only). Roost never touches
// the block device, so these live here rather than in the orchestrator.
const FLUSH_TIMEOUT_SECS = 10 // 10 seconds for durability flush
const UMOUNT_TIMEOUT_SECS = 10 // 10 seconds for unmount
const UMOUNT_MAX_RETRIES = 3 // Number of unmount retry attempts
const UMOUNT_INITIAL_DELAY_MS = 1000 // Initial delay between retries (1 second)
const UMOUNT_BACKOFF_MULTIPLIER = 2 // Exponential backoff multiplier

// Exit code returned by the `timeout` command when the child is killed.
const TIMEOUT_EXIT_CODE = 124

/**
 * Format the block device with ext4 if not already formatted.
 */
async function maybeFormatDevice(
  device: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()

  const result = await exec.getExecOutput('sudo', ['blkid', device], {
    ignoreReturnCode: true
  })

  signal?.throwIfAborted()

  if (result.exitCode === 0 && result.stdout.includes('TYPE=')) {
    core.debug(`[git-mirror] Device ${device} is already formatted`)
    try {
      await exec.exec('sudo', ['resize2fs', '-f', device])
      core.debug(`[git-mirror] Resized filesystem on ${device}`)
    } catch {
      core.warning(`[git-mirror] Error resizing filesystem on ${device}`)
    }
    return
  }

  // Format with ext4
  core.info(`[git-mirror] Formatting device ${device} with ext4`)
  await exec.exec('sudo', [
    'mkfs.ext4',
    '-m0',
    '-Enodiscard,lazy_itable_init=1,lazy_journal_init=1',
    '-F',
    device
  ])
  core.debug(`[git-mirror] Successfully formatted ${device} with ext4`)
}

/**
 * Get the block device path for a mount point.
 * Tries findmnt first, then falls back to parsing mount output.
 */
async function getDeviceFromMount(mountPoint: string): Promise<string | null> {
  try {
    const result = await exec.getExecOutput(
      'findmnt',
      ['-n', '-o', 'SOURCE', mountPoint],
      {ignoreReturnCode: true, silent: true}
    )
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim()
    }
  } catch {
    core.info(
      `[git-mirror] findmnt failed for ${mountPoint}, trying mount command`
    )
  }

  try {
    const result = await exec.getExecOutput('mount', [], {
      ignoreReturnCode: true,
      silent: true
    })
    if (result.exitCode === 0) {
      const lines = result.stdout.split('\n')
      for (const line of lines) {
        if (line.includes(` ${mountPoint} `)) {
          const match = line.match(/^(\/dev\/\S+)/)
          if (match) {
            return match[1]
          }
        }
      }
    }
  } catch {
    core.info(`[git-mirror] mount command failed for ${mountPoint}`)
  }

  return null
}

/**
 * Flush block device buffers to ensure data durability before Ceph RBD snapshot.
 * This is a best-effort operation - failures are logged but don't fail the cleanup.
 */
async function flushBlockDevice(devicePath: string): Promise<void> {
  const deviceName = devicePath.replace('/dev/', '')
  if (!deviceName) {
    core.info(`[git-mirror] Could not extract device name from ${devicePath}`)
    return
  }

  const statPath = `/sys/block/${deviceName}/stat`

  let beforeStats = ''
  try {
    beforeStats = fs.readFileSync(statPath, 'utf8').trim()
  } catch {
    core.info(
      `[git-mirror] Could not read block device stats before flush: ${statPath}`
    )
  }

  const startTime = Date.now()
  try {
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(FLUSH_TIMEOUT_SECS),
        'sudo',
        'blockdev',
        '--flushbufs',
        devicePath
      ],
      {ignoreReturnCode: true}
    )

    const duration = Date.now() - startTime

    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(
        `[git-mirror] Flush timed out for ${devicePath} after ${FLUSH_TIMEOUT_SECS}s`
      )
      return
    }

    if (result.exitCode !== 0) {
      core.warning(
        `[git-mirror] Flush failed for ${devicePath} after ${duration}ms: exit code ${result.exitCode}`
      )
      return
    }

    let afterStats = ''
    try {
      afterStats = fs.readFileSync(statPath, 'utf8').trim()
    } catch {
      core.info(
        `[git-mirror] Could not read block device stats after flush: ${statPath}`
      )
    }

    core.info(
      `[git-mirror] guest flush duration: ${duration}ms, device: ${devicePath}, before_stats: ${beforeStats}, after_stats: ${afterStats}`
    )
  } catch (error) {
    const duration = Date.now() - startTime
    const msg = (error as Error).message || String(error)
    core.warning(
      `[git-mirror] Flush failed for ${devicePath} after ${duration}ms: ${msg}`
    )
  }
}

/**
 * Sleep for the given number of milliseconds.
 */
async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Blacksmith VM agent (native "git_mirror" mode): GetStickyDisk returns a raw
 * block device the privileged runner formats, mounts, unmounts and flushes
 * itself. Reached at the fixed VM-agent address 192.168.127.1.
 */
export class BlacksmithBackend implements StickyDiskBackend {
  readonly name = 'blacksmith' as const
  readonly host = '192.168.127.1'
  readonly stickyDiskType = 'git_mirror' as const

  async provisionMount(
    resp: GetStickyDiskResponse,
    mountTarget: string,
    signal?: AbortSignal
  ): Promise<string> {
    const device = resp.diskIdentifier

    // Format if needed — checks signal before mkfs.ext4
    await maybeFormatDevice(device, signal)

    signal?.throwIfAborted()

    // Mount the device at a unique path for this repository
    await exec.exec('sudo', ['mkdir', '-p', mountTarget])
    await exec.exec('sudo', ['mount', device, mountTarget])
    core.info(`[git-mirror] Mounted ${device} at ${mountTarget}`)

    return mountTarget
  }

  async prepareMirrorDir(mirrorDir: string): Promise<void> {
    await exec.exec('sudo', ['mkdir', '-p', mirrorDir])
    // Change ownership so git can write to it
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    await exec.exec('sudo', ['chown', '-R', `${uid}:${gid}`, mirrorDir])
  }

  async releaseMount(mountPoint: string): Promise<{released: boolean}> {
    // Get device path before unmount for durability flush
    let devicePath: string | null = null
    try {
      devicePath = await getDeviceFromMount(mountPoint)
      if (devicePath) {
        core.info(
          `[git-mirror] Found device ${devicePath} for mount point ${mountPoint}`
        )
      }
    } catch {
      core.info(`[git-mirror] Could not determine device for ${mountPoint}`)
    }

    // Unmount the sticky disk with retry and backoff
    let unmountSuccess = false
    let delayMs = UMOUNT_INITIAL_DELAY_MS

    for (let attempt = 1; attempt <= UMOUNT_MAX_RETRIES; attempt++) {
      core.info(
        `[git-mirror] Unmounting ${mountPoint} (attempt ${attempt}/${UMOUNT_MAX_RETRIES})`
      )
      try {
        const umountResult = await exec.getExecOutput(
          'timeout',
          [String(UMOUNT_TIMEOUT_SECS), 'sudo', 'umount', mountPoint],
          {ignoreReturnCode: true}
        )
        if (umountResult.exitCode === 0) {
          unmountSuccess = true
          core.info(`[git-mirror] Successfully unmounted ${mountPoint}`)
          break
        }

        if (umountResult.exitCode === TIMEOUT_EXIT_CODE) {
          core.warning(
            `[git-mirror] Unmount attempt ${attempt} timed out after ${UMOUNT_TIMEOUT_SECS}s`
          )
        } else {
          core.warning(
            `[git-mirror] Unmount attempt ${attempt} failed with exit code ${umountResult.exitCode}`
          )
        }

        // Print diagnostic info about what's using the mount point (with 5s timeout to avoid hanging)
        core.info(`[git-mirror] Checking for processes using ${mountPoint}...`)
        try {
          const lsofResult = await exec.getExecOutput(
            'timeout',
            ['5', 'lsof', '+D', mountPoint],
            {ignoreReturnCode: true, silent: true}
          )
          if (lsofResult.exitCode === TIMEOUT_EXIT_CODE) {
            core.info(`[git-mirror] lsof timed out after 5s`)
          } else if (lsofResult.stdout.trim()) {
            core.warning(
              `[git-mirror] Processes using ${mountPoint}:\n${lsofResult.stdout}`
            )
          } else {
            core.info(`[git-mirror] No processes found using ${mountPoint}`)
          }
        } catch {
          // lsof may not be available, try fuser as fallback
          try {
            const fuserResult = await exec.getExecOutput(
              'timeout',
              ['5', 'fuser', '-vm', mountPoint],
              {ignoreReturnCode: true, silent: true}
            )
            if (fuserResult.exitCode === TIMEOUT_EXIT_CODE) {
              core.info(`[git-mirror] fuser timed out after 5s`)
            } else if (fuserResult.stdout.trim() || fuserResult.stderr.trim()) {
              core.warning(
                `[git-mirror] Processes using ${mountPoint}:\n${fuserResult.stdout}${fuserResult.stderr}`
              )
            }
          } catch {
            core.info(
              `[git-mirror] Could not determine processes using ${mountPoint}`
            )
          }
        }

        if (attempt < UMOUNT_MAX_RETRIES) {
          core.info(`[git-mirror] Waiting ${delayMs}ms before retry...`)
          await delay(delayMs)
          delayMs *= UMOUNT_BACKOFF_MULTIPLIER
        }
      } catch (error) {
        core.warning(
          `[git-mirror] Unmount attempt ${attempt} threw error: ${(error as Error).message}`
        )
        if (attempt < UMOUNT_MAX_RETRIES) {
          core.info(`[git-mirror] Waiting ${delayMs}ms before retry...`)
          await delay(delayMs)
          delayMs *= UMOUNT_BACKOFF_MULTIPLIER
        }
      }
    }

    if (!unmountSuccess) {
      core.warning(
        `[git-mirror] Failed to unmount ${mountPoint} after ${UMOUNT_MAX_RETRIES} attempts, will not commit sticky disk`
      )
    }

    // Flush block device buffers after unmount to ensure data durability
    // before the Ceph RBD snapshot is taken. The device is still mapped even
    // though unmounted.
    if (devicePath) {
      await flushBlockDevice(devicePath)
    } else {
      core.info(
        '[git-mirror] Skipping durability flush: device path not found for mount point'
      )
    }

    return {released: unmountSuccess}
  }
}

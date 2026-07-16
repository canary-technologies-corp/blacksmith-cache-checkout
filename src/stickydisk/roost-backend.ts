import * as core from '@actions/core'
import * as fs from 'fs'
import type {GetStickyDiskResponse} from '../gen/stickydisk/v1/stickydisk_pb'
import type {StickyDiskBackend} from './backend'

/**
 * Self-hosted roost agent (broker/"mount" mode): the agent formats and mounts
 * the disk and returns a host path, because the ARC runner container is
 * unprivileged. Reached via STICKY_DISK_GRPC_HOST (the node IP).
 */
export class RoostBackend implements StickyDiskBackend {
  readonly name = 'roost' as const
  readonly stickyDiskType = 'mount' as const

  get host(): string {
    return process.env.STICKY_DISK_GRPC_HOST || ''
  }

  async provisionMount(
    resp: GetStickyDiskResponse,
    _mountTarget: string,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted()
    const exposePath = resp.diskIdentifier
    if (!exposePath.startsWith('/') || !fs.existsSync(exposePath)) {
      throw new Error(`roost expose path not visible in pod: ${exposePath}`)
    }
    core.info(`[git-mirror] roost broker mount at ${exposePath}`)
    return exposePath
  }

  async prepareMirrorDir(mirrorDir: string): Promise<void> {
    // Expose root is world-writable and the container has no sudo.
    await fs.promises.mkdir(mirrorDir, {recursive: true})
  }

  async releaseMount(mountPoint: string): Promise<{released: boolean}> {
    // Agent unmounts/flushes/snapshots during the commit RPC.
    core.info(
      `[git-mirror] roost broker mount ${mountPoint}: agent unmounts and flushes during commit`
    )
    return {released: true}
  }
}

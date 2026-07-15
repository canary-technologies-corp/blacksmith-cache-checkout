import * as core from '@actions/core'
import type {GetStickyDiskResponse} from '../gen/stickydisk/v1/stickydisk_pb'
import {BlacksmithBackend} from './blacksmith-backend'
import {RoostBackend} from './roost-backend'

export type ProviderName = 'blacksmith' | 'roost'

/**
 * A stickydisk provider. The orchestrator (`blacksmith-cache.ts`) owns all the
 * shared gRPC + git logic and delegates the five points where Blacksmith VMs
 * and self-hosted roost agents diverge to the selected backend.
 */
export interface StickyDiskBackend {
  readonly name: ProviderName
  // #1 gRPC target host (bare; IPv6 bracketing happens in the shared transport).
  readonly host: string
  // #2 GetStickyDisk `sticky_disk_type` field.
  readonly stickyDiskType: 'git_mirror' | 'mount'

  // #3 turn a GetStickyDisk response into a ready mount-point directory.
  // Blacksmith: mkfs (if needed) + mkdir + mount at `mountTarget`; returns it.
  // Roost: `resp.diskIdentifier` must be an absolute, existing path (the agent
  //   already mounted it, visible via HostToContainer propagation); returns it
  //   and ignores `mountTarget`. Throws otherwise, so setupCache falls back to
  //   standard checkout.
  provisionMount(
    resp: GetStickyDiskResponse,
    mountTarget: string,
    signal?: AbortSignal
  ): Promise<string>

  // #4 create the mirror parent directory with the right privileges.
  // Blacksmith: sudo mkdir -p + chown to runner uid/gid. Roost: fs.mkdir.
  prepareMirrorDir(mirrorDir: string): Promise<void>

  // #5 release the mount before the CommitStickyDisk RPC. Takes the mount point
  // (cleanup runs in a separate process and only has the saved mount point).
  // Blacksmith: getDeviceFromMount -> unmount (retries) -> blockdev --flushbufs;
  //   returns {released:false} if unmount ultimately failed.
  // Roost: no-op, returns {released:true} (the agent owns unmount/flush).
  releaseMount(mountPoint: string): Promise<{released: boolean}>
}

/**
 * Choose the stickydisk backend for the current run from the environment.
 *
 * Precedence (see the design spec):
 *   1. STICKY_DISK_PROVIDER=roost -> RoostBackend, but only if
 *      STICKY_DISK_GRPC_HOST is set; otherwise warn and fall back to Blacksmith
 *      (an empty-host roost backend would dial http://:5557 and burn the whole
 *      cacheTimeoutSeconds before falling back).
 *   2. STICKY_DISK_PROVIDER=blacksmith -> BlacksmithBackend.
 *   3. auto / unset -> RoostBackend if STICKY_DISK_GRPC_HOST is set, else
 *      BlacksmithBackend.
 *   4. Any other value -> warn and auto-detect (rule 3). A typo'd flag must not
 *      fail checkout.
 *
 * This runs in both the main and post steps; because it reads only the
 * environment (stable across both processes) the selection is deterministic.
 */
export function selectBackend(): StickyDiskBackend {
  const flag = process.env.STICKY_DISK_PROVIDER?.toLowerCase()
  const hasHost = !!process.env.STICKY_DISK_GRPC_HOST
  if (flag === 'blacksmith') return new BlacksmithBackend()
  if (flag === 'roost') {
    if (!hasHost) {
      core.warning(
        '[git-mirror] STICKY_DISK_PROVIDER=roost but STICKY_DISK_GRPC_HOST is unset; using Blacksmith'
      )
      return new BlacksmithBackend()
    }
    return new RoostBackend()
  }
  if (flag && flag !== 'auto') {
    core.warning(
      `[git-mirror] Unknown STICKY_DISK_PROVIDER "${flag}"; auto-detecting`
    )
  }
  return hasHost ? new RoostBackend() : new BlacksmithBackend()
}

import type {GetStickyDiskResponse} from '../gen/stickydisk/v1/stickydisk_pb'

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

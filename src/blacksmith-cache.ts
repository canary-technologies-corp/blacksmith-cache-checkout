import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import {createClient, ConnectError, Code} from '@connectrpc/connect'
import {createGrpcTransport} from '@connectrpc/connect-node'
import {StickyDiskService} from './gen/stickydisk/v1/stickydisk_connect'
import {selectBackend} from './stickydisk/backend'
import * as retryHelper from './retry-helper'

const GRPC_PORT = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || '5557'
const MOUNT_BASE = '/blacksmith-git-mirror'
const MIRROR_VERSION = 'v1'

const REFRESH_TIMEOUT_SECS = 90 // 90 seconds, single attempt
const GC_TIMEOUT_SECS = 120 // 2 minutes

// Exit code returned by the `timeout` command when the child is killed.
const TIMEOUT_EXIT_CODE = 124

/**
 * Result of a git mirror operation that may fail or time out.
 */
export interface OperationResult {
  success: boolean
  timedOut: boolean
  error?: string
}

/**
 * Result of the cleanup phase, used for metric reporting.
 */
export interface CleanupResult {
  gcResult: OperationResult
}

/**
 * Get the mount point for a specific repository.
 * Each repository gets its own mount point to support multiple checkouts.
 * Uses directory structure (owner/repo) to avoid collisions from hyphenated names
 * (e.g., foo-bar/baz vs foo/bar-baz would collide with a flat naming scheme).
 */
export function getMountPoint(owner: string, repo: string): string {
  return path.join(MOUNT_BASE, owner, repo)
}

export interface CacheInfo {
  exposeId: string
  stickyDiskKey: string
  repoName: string
  mountPoint: string
  mirrorPath: string
  // hydrationInProgress indicates that another job is currently hydrating the git mirror.
  // When true, the caller should fall back to regular checkout without using the cache.
  hydrationInProgress: boolean
  hydrationMessage?: string
  // performedHydration indicates that this job performed the initial git mirror clone.
  // Used to notify the backend on commit so it can mark hydration as complete.
  performedHydration: boolean
}

/**
 * Check if running in a Blacksmith environment by detecting BLACKSMITH_VM_ID
 */
export function isBlacksmithEnvironment(): boolean {
  return !!process.env.BLACKSMITH_VM_ID
}

/**
 * Check if running against a self-hosted roost agent (SRE-930).
 * ARC runner pods inject STICKY_DISK_GRPC_HOST (the node IP) and mount the
 * agent's expose directory; Blacksmith VMs never set this variable.
 * Roost serves the same stickydisk gRPC protocol but in broker mode: the
 * agent formats and mounts the disk itself and returns a path, because the
 * runner container is unprivileged.
 */
export function isRoostEnvironment(): boolean {
  return !!process.env.STICKY_DISK_GRPC_HOST
}

/**
 * Control plane short circuit: when an installation has the
 * `bypass_blacksmith_checkout` flag flipped on, the agent exports
 * BLACKSMITH_BYPASS_CHECKOUT=true into the runner environment. We
 * use that as a kill switch to skip every Blacksmith-specific code path
 * (mirror cache setup, alternates, dissociate, post-step commit). The
 * action then behaves identically to upstream actions/checkout.
 */
export function shouldUseBlacksmithCache(): boolean {
  if (!isBlacksmithEnvironment() && !isRoostEnvironment()) {
    return false
  }
  if (process.env.BLACKSMITH_BYPASS_CHECKOUT === 'true') {
    core.info(
      '[blacksmith] BLACKSMITH_BYPASS_CHECKOUT=true — skipping Blacksmith git mirror cache and falling back to actions/checkout behavior'
    )
    return false
  }
  return true
}

/**
 * Get the path where the bare git mirror will be stored.
 * Uses owner-repo.git filename to maintain backward compatibility with existing sticky disks.
 */
export function getMirrorPath(owner: string, repo: string): string {
  const mountPoint = getMountPoint(owner, repo)
  return path.join(mountPoint, MIRROR_VERSION, `${owner}-${repo}.git`)
}

/**
 * Create a gRPC client for communicating with the stickydisk agent at `host`.
 * The host is bare; a self-hosted roost agent's node IP is IPv6 on ARC
 * runners, hence the brackets.
 */
function createBlacksmithClient(host: string) {
  core.debug(`Creating stickydisk agent client at ${host}:${GRPC_PORT}`)
  const authority = host.includes(':') ? `[${host}]` : host
  const transport = createGrpcTransport({
    baseUrl: `http://${authority}:${GRPC_PORT}`,
    httpVersion: '2'
  })

  return createClient(StickyDiskService, transport)
}

/**
 * Request a sticky disk from the VM agent, format if needed, and mount it.
 * Returns CacheInfo with hydrationInProgress=true if another job is hydrating,
 * allowing the caller to fall back to regular checkout.
 */
export async function setupCache(
  owner: string,
  repo: string,
  signal?: AbortSignal
): Promise<CacheInfo> {
  const backend = selectBackend()
  const client = createBlacksmithClient(backend.host)
  const stickyDiskKey = `${owner}-${repo}`

  // Test connection
  core.info(`[git-mirror] Connecting to Blacksmith agent for ${stickyDiskKey}`)
  try {
    await client.up({}, {signal})
    core.debug('[git-mirror] Successfully connected to Blacksmith agent')
  } catch (error) {
    // roost agents don't implement Up; an UNIMPLEMENTED reply still proves
    // the server is reachable.
    if (error instanceof ConnectError && error.code === Code.Unimplemented) {
      core.debug('[git-mirror] Agent has no Up RPC (roost); continuing')
    } else {
      throw new Error(
        `gRPC connection test failed: ${(error as Error).message}`
      )
    }
  }

  core.info(`[git-mirror] Requesting sticky disk for ${stickyDiskKey}`)

  // Request sticky disk from VM agent
  // Use the actual repo being checked out (owner/repo), not GITHUB_REPO_NAME
  // This ensures each repo gets its own isolated sticky disk
  const repoName = `${owner}/${repo}`
  let response
  try {
    response = await client.getStickyDisk(
      {
        stickyDiskKey: stickyDiskKey,
        // Blacksmith VMs use native "git_mirror" (a raw block device); roost
        // broker mode uses "mount" (the agent formats/mounts and returns a
        // path, since the runner container cannot mount block devices itself).
        stickyDiskType: backend.stickyDiskType,
        region: process.env.BLACKSMITH_REGION || '',
        installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
        vmId: process.env.BLACKSMITH_VM_ID || '',
        repoName: repoName,
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
      },
      {signal}
    )
  } catch (error) {
    // Check if this is a gRPC Aborted error indicating hydration in progress
    if (error instanceof ConnectError && error.code === Code.Aborted) {
      const hydrationMessage =
        error.message || 'Initial mirror clone is running'
      core.warning(
        `[git-mirror] Another job is hydrating the git mirror cache: ${hydrationMessage}`
      )
      core.warning(
        '[git-mirror] No sticky disk will be mounted for this run; checkout will clone directly from GitHub onto the runner disk (no mirror cache). The mirror cache will be available on subsequent runs once hydration completes.'
      )
      return {
        exposeId: '',
        stickyDiskKey,
        repoName,
        mountPoint: '',
        mirrorPath: '',
        hydrationInProgress: true,
        hydrationMessage,
        performedHydration: false
      }
    }
    // Re-throw other errors
    throw error
  }

  const exposeId = (response as {exposeId?: string}).exposeId || ''
  const diskIdentifier =
    (response as {diskIdentifier?: string}).diskIdentifier || ''

  if (!diskIdentifier) {
    throw new Error('No device found in sticky disk response')
  }

  if (!exposeId) {
    throw new Error('No exposeId found in sticky disk response')
  }

  core.info(
    `[git-mirror] Got sticky disk identifier: ${diskIdentifier}, exposeId: ${exposeId}`
  )

  // Delegate provider-specific provisioning. Blacksmith formats the block
  // device and mounts it at the computed mount target; roost validates the
  // path the agent already mounted (ignoring the target). Either way we get
  // the ready mount-point directory back, and the mirror path is derived from
  // it identically for both providers.
  const mountPoint = await backend.provisionMount(
    response,
    getMountPoint(owner, repo),
    signal
  )

  return {
    exposeId,
    stickyDiskKey,
    repoName,
    mountPoint,
    mirrorPath: path.join(mountPoint, MIRROR_VERSION, `${owner}-${repo}.git`),
    hydrationInProgress: false,
    performedHydration: false // Will be set by ensureMirror if we do initial clone
  }
}

/**
 * Get the extraheader config value for git authentication.
 * Uses the same format as upstream actions/checkout:
 * http.<origin>/.extraheader = AUTHORIZATION: basic <base64(x-access-token:TOKEN)>
 *
 * This is more secure than embedding credentials in the URL because:
 * 1. The header value is not visible in process arguments
 * 2. It follows the same pattern used by the upstream checkout action
 */
function getAuthConfigArgs(
  repoUrl: string,
  authToken: string
): {configKey: string; configValue: string} {
  const url = new URL(repoUrl)
  const origin = url.origin // SCHEME://HOSTNAME[:PORT]
  const basicCredential = Buffer.from(
    `x-access-token:${authToken}`,
    'utf8'
  ).toString('base64')
  core.setSecret(basicCredential)

  return {
    configKey: `http.${origin}/.extraheader`,
    configValue: `AUTHORIZATION: basic ${basicCredential}`
  }
}

/**
 * Build git environment with optional verbose flags
 */
function buildGitEnv(verbose: boolean): {[key: string]: string} {
  const gitEnv: {[key: string]: string} = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      gitEnv[key] = value
    }
  }
  if (verbose) {
    gitEnv['GIT_TRACE'] = '1'
    gitEnv['GIT_CURL_VERBOSE'] = '1'
  }
  return gitEnv
}

/**
 * Ensure a bare git mirror exists. If the mirror doesn't exist, clone it.
 * If the mirror already exists, skip the fetch (it will be updated in the post step).
 *
 * This approach moves the mirror refresh to the post step to avoid step-level timeouts
 * affecting checkout performance. The alternates mechanism allows checkout to work
 * with a stale mirror - missing objects will be fetched from the network.
 *
 * Uses http.extraheader for authentication (same as upstream checkout action).
 *
 * @param mirrorPath - Path to the bare git mirror
 * @param repoUrl - URL of the repository to mirror
 * @param authToken - Authentication token for the repository
 * @param verbose - Enable verbose output with GIT_TRACE and GIT_CURL_VERBOSE
 * @returns true if a new mirror was created (initial hydration), false if mirror already existed
 */
export async function ensureMirror(
  mirrorPath: string,
  repoUrl: string,
  authToken: string,
  verbose: boolean = false
): Promise<boolean> {
  if (fs.existsSync(mirrorPath)) {
    // Mirror exists - skip fetch here, it will be done in the post step
    core.info(
      `[git-mirror] Found existing mirror at ${mirrorPath}, deferring refresh to post step`
    )
    return false // Not initial hydration
  }

  // First time - create a bare mirror clone (initial hydration)
  core.info(
    `[git-mirror] Creating new mirror at ${mirrorPath} (initial hydration)`
  )
  const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
  const gitEnv = buildGitEnv(verbose)

  const mirrorDir = path.dirname(mirrorPath)
  // Blacksmith needs sudo mkdir + chown (privileged runner); roost uses a plain
  // mkdir as the runner user (world-writable expose, no sudo). The env is
  // stable across steps so re-selecting here is deterministic.
  await selectBackend().prepareMirrorDir(mirrorDir)
  await retryHelper.execute(async () => {
    // Clean up any partial clone from a previous failed attempt
    if (fs.existsSync(mirrorPath)) {
      core.info(
        `[git-mirror] Removing partial mirror directory from failed attempt`
      )
      await fs.promises.rm(mirrorPath, {recursive: true, force: true})
    }
    // gc.auto=0: disable auto-gc during clone (see comment in refreshMirror)
    const cloneArgs = [
      '-c',
      `${configKey}=${configValue}`,
      '-c',
      'gc.auto=0',
      'clone',
      '--mirror',
      '--progress',
      repoUrl,
      mirrorPath
    ]
    if (verbose) {
      cloneArgs.splice(cloneArgs.indexOf('--progress') + 1, 0, '--verbose')
    }
    await exec.exec('git', cloneArgs, {env: gitEnv})
  })
  core.info('[git-mirror] Initial mirror clone complete')
  return true // Initial hydration performed
}

/**
 * Refresh an existing git mirror by fetching updates from the remote.
 * This is called in the post step to update the mirror for future runs,
 * outside of the critical checkout path.
 *
 * @param mirrorPath - Path to the bare git mirror
 * @param repoUrl - URL of the repository to mirror
 * @param authToken - Authentication token for the repository
 * @param verbose - Enable verbose output with GIT_TRACE and GIT_CURL_VERBOSE
 */
export async function refreshMirror(
  mirrorPath: string,
  repoUrl: string,
  authToken: string,
  verbose: boolean = false,
  timeoutSecs: number = REFRESH_TIMEOUT_SECS
): Promise<OperationResult> {
  if (!fs.existsSync(mirrorPath)) {
    core.debug(
      `[git-mirror] Mirror does not exist at ${mirrorPath}, skipping refresh`
    )
    return {success: true, timedOut: false}
  }

  core.info(
    `[git-mirror] Refreshing mirror at ${mirrorPath} (timeout: ${timeoutSecs}s)`
  )

  try {
    const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
    const gitEnv = buildGitEnv(verbose)
    // gc.auto=0: disable git's internal auto-gc that porcelain commands like
    // fetch run after completing. Without this, fetch can spawn a background
    // gc daemon (gc.autoDetach defaults to true) that holds cwd + mmap'd pack
    // files on the mirror mount, causing the subsequent umount to fail with
    // EBUSY. We run gc explicitly in runMirrorGC() with gc.autoDetach=false.
    const fetchArgs = [
      '-c',
      `${configKey}=${configValue}`,
      '-c',
      'gc.auto=0',
      '-C',
      mirrorPath,
      'fetch',
      '--prune',
      'origin'
    ]
    if (verbose) {
      fetchArgs.splice(
        fetchArgs.indexOf('origin'),
        0,
        '--progress',
        '--verbose'
      )
    }
    const result = await exec.getExecOutput(
      'timeout',
      [String(timeoutSecs), 'git', ...fetchArgs],
      {env: gitEnv, ignoreReturnCode: true, silent: !verbose}
    )
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      throw new Error(`git fetch timed out after ${timeoutSecs}s`)
    }
    if (result.exitCode !== 0) {
      // Include stderr in error message so failure details are visible even when silent
      const stderr = result.stderr.trim()
      const details = stderr ? `: ${stderr}` : ''
      throw new Error(
        `git fetch failed with exit code ${result.exitCode}${details}`
      )
    }
    core.info('[git-mirror] Mirror refresh complete')
    return {success: true, timedOut: false}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    const timedOut = msg.includes('timed out')
    if (timedOut) {
      core.warning(`[git-mirror] Mirror refresh timed out: ${msg}`)
    } else {
      core.warning(`[git-mirror] Mirror refresh failed: ${msg}`)
    }
    return {success: false, timedOut, error: msg}
  }
}

/**
 * Write the alternates file to enable object sharing from the mirror
 * This allows the workspace git repo to use objects from the mirror
 * without copying them
 */
export async function writeAlternates(
  workspacePath: string,
  mirrorPath: string
): Promise<void> {
  const alternatesDir = path.join(workspacePath, '.git', 'objects', 'info')
  const alternatesFile = path.join(alternatesDir, 'alternates')

  await fs.promises.mkdir(alternatesDir, {recursive: true})
  await fs.promises.writeFile(alternatesFile, `${mirrorPath}/objects\n`)
  core.debug(`Wrote alternates file pointing to ${mirrorPath}/objects`)
}

/**
 * Dissociate the repository from the mirror by copying all objects locally
 * This is needed for Docker-based actions that may not have access to the mirror mount
 */
export async function dissociate(workspacePath: string): Promise<void> {
  core.info('Dissociating repository from mirror')

  // Copy all objects from alternates into local repo
  await exec.exec('git', ['-C', workspacePath, 'repack', '-a', '-d'])

  // Remove alternates file
  const alternatesFile = path.join(
    workspacePath,
    '.git',
    'objects',
    'info',
    'alternates'
  )
  try {
    await fs.promises.unlink(alternatesFile)
    core.debug('Removed alternates file')
  } catch {
    // File may not exist, that's fine
  }
}

/**
 * Run lightweight garbage collection on the mirror.
 * Uses --auto to only run GC when git determines it's needed (based on loose object count).
 * This avoids expensive full repacks on every run while still keeping the repo tidy over time.
 */
async function runMirrorGC(
  mirrorPath: string,
  timeoutSecs: number = GC_TIMEOUT_SECS
): Promise<OperationResult> {
  core.info(
    `[git-mirror] Running auto garbage collection (timeout: ${timeoutSecs}s)`
  )

  try {
    // --auto: only run if thresholds exceeded (default: 6700 loose objects or 50 packs)
    // This is much faster than a full gc when not needed
    // gc.autoDetach=false: prevent git from forking a background daemon for GC.
    // Without this, the parent `git gc --auto` returns immediately while the
    // daemonized child keeps running with cwd and mmap'd pack files on the
    // mirror mount, causing the subsequent `umount` to fail with EBUSY.
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(timeoutSecs),
        'git',
        '-c',
        'gc.autoDetach=false',
        '-C',
        mirrorPath,
        'gc',
        '--auto'
      ],
      {ignoreReturnCode: true}
    )
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(`[git-mirror] GC timed out after ${timeoutSecs}s`)
      return {
        success: false,
        timedOut: true,
        error: `git gc timed out after ${timeoutSecs}s`
      }
    }
    if (result.exitCode !== 0) {
      core.warning(`[git-mirror] GC failed with exit code ${result.exitCode}`)
      return {
        success: false,
        timedOut: false,
        error: `git gc failed with exit code ${result.exitCode}`
      }
    }
    core.debug('[git-mirror] Completed git gc --auto')
    return {success: true, timedOut: false}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    core.warning(`[git-mirror] GC failed: ${msg}`)
    return {success: false, timedOut: false, error: msg}
  }
}

export interface CleanupOptions {
  exposeId: string
  stickyDiskKey: string
  repoName?: string
  mountPoint?: string
  mirrorPath?: string
  // shouldCommit indicates whether changes should be persisted.
  // Set to false if the job failed/was cancelled to avoid committing bad state.
  shouldCommit: boolean
  // vmHydratedGitMirror indicates this job performed initial git mirror clone.
  // Used by backend to mark hydration as complete.
  vmHydratedGitMirror: boolean
  // Mirror refresh outcome from the post step (run before cleanup is called).
  mirrorRefreshFailed?: boolean
  mirrorRefreshTimedOut?: boolean
}

/**
 * Cleanup: run GC, sync, unmount, and commit the sticky disk.
 *
 * Execution order: GC → sync → release mount (backend) → commit
 * If any of mirror refresh / GC / mount release fail, shouldCommit is set to
 * false (but the commit RPC is still sent so the agent releases the expose).
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
  const {
    exposeId,
    stickyDiskKey,
    repoName,
    mountPoint,
    mirrorPath,
    mirrorRefreshFailed,
    mirrorRefreshTimedOut
  } = options
  let {shouldCommit} = options
  // vmHydratedGitMirror must track shouldCommit: if we decide not to commit
  // (due to GC/refresh failure), we must not tell the backend that
  // hydration completed, otherwise it marks the entry as ready despite no
  // valid disk being persisted.
  let vmHydratedGitMirror = options.vmHydratedGitMirror

  const result: CleanupResult = {
    gcResult: {success: true, timedOut: false}
  }

  core.info(
    `[git-mirror] Starting cleanup: exposeId=${exposeId}, stickyDiskKey=${stickyDiskKey}, shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )

  // If mirror refresh failed or timed out, don't commit
  if (mirrorRefreshFailed || mirrorRefreshTimedOut) {
    const reason = mirrorRefreshTimedOut ? 'timed out' : 'failed'
    core.warning(
      `[git-mirror] Mirror refresh ${reason}, will not commit sticky disk`
    )
    shouldCommit = false
    vmHydratedGitMirror = false
  }

  if (mirrorPath) {
    // Run GC on the mirror
    result.gcResult = await runMirrorGC(mirrorPath)
    if (!result.gcResult.success) {
      core.warning(
        '[git-mirror] GC failed or timed out, will not commit sticky disk'
      )
      shouldCommit = false
      vmHydratedGitMirror = false
    }
  }

  // Sync filesystem before unmount to ensure all writes are flushed
  core.debug('[git-mirror] Syncing filesystem before unmount')
  try {
    await exec.exec('sync')
  } catch {
    core.warning('[git-mirror] Failed to sync filesystem')
  }

  // Release the mount before committing. cleanup runs in a separate process
  // from setup, so we re-select the backend from the (stable) environment.
  // Blacksmith unmounts (with retries) and flushes the block device, reporting
  // released=false if the unmount ultimately failed; roost is a no-op (its
  // agent unmounts, flushes, and snapshots the disk itself during the commit
  // RPC below). Guard on a non-empty mountPoint (the hydration-fallback path
  // saves none).
  const backend = selectBackend()
  if (mountPoint) {
    const {released} = await backend.releaseMount(mountPoint)
    if (!released) {
      // The unmount ultimately failed: don't snapshot a still-mounted, dirty
      // filesystem. We still send the commit RPC below (with should_commit
      // false) so the agent releases the expose without persisting bad state.
      shouldCommit = false
      vmHydratedGitMirror = false
    }
  }

  // Commit the sticky disk to persist changes
  core.info(
    `[git-mirror] Committing sticky disk: shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )
  try {
    const client = createBlacksmithClient(backend.host)

    await client.commitStickyDisk({
      exposeId: exposeId,
      stickyDiskKey: stickyDiskKey,
      vmId: process.env.BLACKSMITH_VM_ID || '',
      shouldCommit: shouldCommit,
      repoName: repoName || process.env.GITHUB_REPO_NAME || '',
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || '',
      vmHydratedGitMirror: vmHydratedGitMirror
    })

    core.info('[git-mirror] Successfully committed sticky disk')
  } catch (error) {
    core.warning(
      `[git-mirror] Failed to commit sticky disk: ${(error as any)?.message ?? error}`
    )
  }

  return result
}

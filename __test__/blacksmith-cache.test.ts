// Mock the gRPC dependencies before importing blacksmith-cache
jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(),
  ConnectError: class ConnectError extends Error {},
  Code: {Aborted: 'ABORTED'}
}))

jest.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: jest.fn()
}))

// Avoid the real `sync` exec in cleanup and let the backend be swapped out.
jest.mock('@actions/exec')
jest.mock('../src/stickydisk/backend', () => ({
  selectBackend: jest.fn()
}))

import {createClient} from '@connectrpc/connect'
import {selectBackend} from '../src/stickydisk/backend'
import * as blacksmithCache from '../src/blacksmith-cache'

const mockCreateClient = createClient as jest.MockedFunction<
  typeof createClient
>
const mockSelectBackend = selectBackend as jest.MockedFunction<
  typeof selectBackend
>

describe('blacksmith-cache tests', () => {
  describe('getMountPoint', () => {
    it('returns unique mount point for each repository', () => {
      const mountPoint1 = blacksmithCache.getMountPoint('owner1', 'repo1')
      const mountPoint2 = blacksmithCache.getMountPoint('owner1', 'repo2')
      const mountPoint3 = blacksmithCache.getMountPoint('owner2', 'repo1')

      // Each should be unique
      expect(mountPoint1).not.toBe(mountPoint2)
      expect(mountPoint1).not.toBe(mountPoint3)
      expect(mountPoint2).not.toBe(mountPoint3)
    })

    it('returns consistent mount point for same repository', () => {
      const mountPoint1 = blacksmithCache.getMountPoint('myorg', 'myrepo')
      const mountPoint2 = blacksmithCache.getMountPoint('myorg', 'myrepo')

      expect(mountPoint1).toBe(mountPoint2)
    })

    it('includes owner and repo in mount point path', () => {
      const mountPoint = blacksmithCache.getMountPoint(
        'descriptinc',
        'descript'
      )

      expect(mountPoint).toContain('descriptinc')
      expect(mountPoint).toContain('descript')
      expect(mountPoint).toBe('/blacksmith-git-mirror/descriptinc/descript')
    })

    it('avoids collisions from hyphenated names', () => {
      // These would collide with a flat naming scheme like -owner-repo
      // but are unique with directory structure /owner/repo
      const mountPoint1 = blacksmithCache.getMountPoint('foo-bar', 'baz')
      const mountPoint2 = blacksmithCache.getMountPoint('foo', 'bar-baz')

      expect(mountPoint1).toBe('/blacksmith-git-mirror/foo-bar/baz')
      expect(mountPoint2).toBe('/blacksmith-git-mirror/foo/bar-baz')
      expect(mountPoint1).not.toBe(mountPoint2)
    })
  })

  describe('getMirrorPath', () => {
    it('returns path under the unique mount point', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')
      const mountPoint = blacksmithCache.getMountPoint('myorg', 'myrepo')

      expect(mirrorPath.startsWith(mountPoint)).toBe(true)
    })

    it('returns unique mirror paths for different repositories', () => {
      const mirrorPath1 = blacksmithCache.getMirrorPath('owner1', 'repo1')
      const mirrorPath2 = blacksmithCache.getMirrorPath('owner1', 'repo2')
      const mirrorPath3 = blacksmithCache.getMirrorPath('owner2', 'repo1')

      // Each should be unique
      expect(mirrorPath1).not.toBe(mirrorPath2)
      expect(mirrorPath1).not.toBe(mirrorPath3)
      expect(mirrorPath2).not.toBe(mirrorPath3)
    })

    it('includes version directory in path', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')

      expect(mirrorPath).toContain('/v1/')
    })

    it('ends with .git extension', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')

      expect(mirrorPath).toMatch(/\.git$/)
    })

    it('returns expected full path format', () => {
      const mirrorPath = blacksmithCache.getMirrorPath(
        'descriptinc',
        'descript'
      )

      expect(mirrorPath).toBe(
        '/blacksmith-git-mirror/descriptinc/descript/v1/descriptinc-descript.git'
      )
    })
  })

  describe('isBlacksmithEnvironment', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('returns true when BLACKSMITH_VM_ID is set', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(true)
    })

    it('returns false when BLACKSMITH_VM_ID is not set', () => {
      delete process.env['BLACKSMITH_VM_ID']
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(false)
    })

    it('returns false when BLACKSMITH_VM_ID is empty string', () => {
      process.env['BLACKSMITH_VM_ID'] = ''
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(false)
    })
  })

  describe('isRoostEnvironment', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('returns true when STICKY_DISK_GRPC_HOST is set', () => {
      process.env['STICKY_DISK_GRPC_HOST'] = 'fd33::1'
      expect(blacksmithCache.isRoostEnvironment()).toBe(true)
    })

    it('returns false when STICKY_DISK_GRPC_HOST is not set', () => {
      delete process.env['STICKY_DISK_GRPC_HOST']
      expect(blacksmithCache.isRoostEnvironment()).toBe(false)
    })

    it('returns false when STICKY_DISK_GRPC_HOST is empty string', () => {
      process.env['STICKY_DISK_GRPC_HOST'] = ''
      expect(blacksmithCache.isRoostEnvironment()).toBe(false)
    })
  })

  describe('shouldUseBlacksmithCache', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('returns true when in Blacksmith env and kill switch is unset', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      delete process.env['BLACKSMITH_BYPASS_CHECKOUT']
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('returns false outside of a Blacksmith env regardless of kill switch', () => {
      delete process.env['BLACKSMITH_VM_ID']
      delete process.env['STICKY_DISK_GRPC_HOST']
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns true in a roost env (STICKY_DISK_GRPC_HOST) without BLACKSMITH_VM_ID', () => {
      delete process.env['BLACKSMITH_VM_ID']
      process.env['STICKY_DISK_GRPC_HOST'] = 'fd33::1'
      delete process.env['BLACKSMITH_BYPASS_CHECKOUT']
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('honors the kill switch in a roost env', () => {
      delete process.env['BLACKSMITH_VM_ID']
      process.env['STICKY_DISK_GRPC_HOST'] = 'fd33::1'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns false when BLACKSMITH_BYPASS_CHECKOUT=true (control-plane kill switch)', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns true when BLACKSMITH_BYPASS_CHECKOUT is any value other than "true"', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'false'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)

      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = '1'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)

      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = ''
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })
  })

  describe('multiple checkout scenario', () => {
    it('each repo gets isolated paths that do not conflict', () => {
      // Simulate the multiple checkout scenario from the customer issue:
      // 1. First checkout: descriptinc/descript (workflow repo)
      // 2. Second checkout: descriptinc/shared-actions

      const repo1 = {owner: 'descriptinc', repo: 'descript'}
      const repo2 = {owner: 'descriptinc', repo: 'shared-actions'}

      const mountPoint1 = blacksmithCache.getMountPoint(repo1.owner, repo1.repo)
      const mountPoint2 = blacksmithCache.getMountPoint(repo2.owner, repo2.repo)

      const mirrorPath1 = blacksmithCache.getMirrorPath(repo1.owner, repo1.repo)
      const mirrorPath2 = blacksmithCache.getMirrorPath(repo2.owner, repo2.repo)

      // Mount points should be different
      expect(mountPoint1).toBe('/blacksmith-git-mirror/descriptinc/descript')
      expect(mountPoint2).toBe(
        '/blacksmith-git-mirror/descriptinc/shared-actions'
      )
      expect(mountPoint1).not.toBe(mountPoint2)

      // Mirror paths should be under their respective mount points
      expect(mirrorPath1.startsWith(mountPoint1)).toBe(true)
      expect(mirrorPath2.startsWith(mountPoint2)).toBe(true)

      // Mirror paths should not overlap
      expect(mirrorPath1.startsWith(mountPoint2)).toBe(false)
      expect(mirrorPath2.startsWith(mountPoint1)).toBe(false)
    })
  })

  describe('cleanup mount release', () => {
    const commitStickyDisk = jest.fn()
    const releaseMount = jest.fn()

    function fakeBackend(): unknown {
      return {
        name: 'blacksmith',
        host: '192.168.127.1',
        stickyDiskType: 'git_mirror',
        provisionMount: jest.fn(),
        prepareMirrorDir: jest.fn(),
        releaseMount
      }
    }

    beforeEach(() => {
      mockCreateClient.mockReturnValue({
        commitStickyDisk,
        up: jest.fn(),
        getStickyDisk: jest.fn()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      mockSelectBackend.mockReturnValue(fakeBackend() as never)
    })

    it('still commits with shouldCommit=false and vmHydratedGitMirror=false when releaseMount reports released:false', async () => {
      releaseMount.mockResolvedValue({released: false})

      await blacksmithCache.cleanup({
        exposeId: 'expose-1',
        stickyDiskKey: 'owner-repo',
        repoName: 'owner/repo',
        mountPoint: '/blacksmith-git-mirror/owner/repo',
        shouldCommit: true,
        vmHydratedGitMirror: true
      })

      expect(releaseMount).toHaveBeenCalledWith(
        '/blacksmith-git-mirror/owner/repo'
      )
      // The commit RPC is still sent (so the agent releases the expose)...
      expect(commitStickyDisk).toHaveBeenCalledTimes(1)
      // ...but with committing suppressed.
      expect(commitStickyDisk).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldCommit: false,
          vmHydratedGitMirror: false
        })
      )
    })

    it('commits normally when releaseMount reports released:true', async () => {
      releaseMount.mockResolvedValue({released: true})

      await blacksmithCache.cleanup({
        exposeId: 'expose-1',
        stickyDiskKey: 'owner-repo',
        repoName: 'owner/repo',
        mountPoint: '/blacksmith-git-mirror/owner/repo',
        shouldCommit: true,
        vmHydratedGitMirror: true
      })

      expect(commitStickyDisk).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldCommit: true,
          vmHydratedGitMirror: true
        })
      )
    })

    it('skips releaseMount when mountPoint is empty but still commits', async () => {
      await blacksmithCache.cleanup({
        exposeId: 'expose-1',
        stickyDiskKey: 'owner-repo',
        shouldCommit: true,
        vmHydratedGitMirror: false
      })

      expect(releaseMount).not.toHaveBeenCalled()
      expect(commitStickyDisk).toHaveBeenCalledTimes(1)
    })
  })

  describe('setupCache expose release on provisioning failure', () => {
    const commitStickyDisk = jest.fn()

    beforeEach(() => {
      commitStickyDisk.mockReset()
      commitStickyDisk.mockResolvedValue({})
      mockCreateClient.mockReturnValue({
        up: jest.fn().mockResolvedValue({}),
        getStickyDisk: jest.fn().mockResolvedValue({
          exposeId: 'expose-1',
          diskIdentifier: '/mnt/roost/expose'
        }),
        commitStickyDisk
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      mockSelectBackend.mockReturnValue({
        name: 'roost',
        host: 'fd00::1',
        stickyDiskType: 'mount',
        provisionMount: jest
          .fn()
          .mockRejectedValue(
            new Error('roost expose path not visible in pod: /mnt/roost/expose')
          ),
        prepareMirrorDir: jest.fn(),
        releaseMount: jest.fn()
      } as never)
    })

    it('releases the expose (shouldCommit=false) when provisionMount throws, then rethrows', async () => {
      await expect(blacksmithCache.setupCache('owner', 'repo')).rejects.toThrow(
        'roost expose path not visible'
      )

      // The expose GetStickyDisk allocated must be released, not leaked...
      expect(commitStickyDisk).toHaveBeenCalledTimes(1)
      expect(commitStickyDisk).toHaveBeenCalledWith(
        expect.objectContaining({
          exposeId: 'expose-1',
          shouldCommit: false,
          vmHydratedGitMirror: false
        }),
        // ...under an independent short timeout (no signal) so a hung agent
        // cannot block the fallback to standard checkout.
        expect.objectContaining({timeoutMs: expect.any(Number)})
      )
    })
  })
})

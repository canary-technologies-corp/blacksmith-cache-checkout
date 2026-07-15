import * as fs from 'fs'
import {RoostBackend} from '../src/stickydisk/roost-backend'
import {GetStickyDiskResponse} from '../src/gen/stickydisk/v1/stickydisk_pb'

// Keep the [git-mirror] log lines out of the test output.
jest.mock('@actions/core')
// `fs` namespace properties are non-configurable, so spyOn cannot re-spy across
// tests. Mock only the two functions the backends touch and keep the rest real
// (so @actions/core's top-level `fs.promises` destructuring still works).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(),
    promises: {...actual.promises, mkdir: jest.fn()}
  }
})

const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>
const mockMkdir = fs.promises.mkdir as jest.MockedFunction<
  typeof fs.promises.mkdir
>

describe('RoostBackend', () => {
  const backend = new RoostBackend()

  it('advertises name=roost and stickyDiskType=mount', () => {
    expect(backend.name).toBe('roost')
    expect(backend.stickyDiskType).toBe('mount')
  })

  describe('host', () => {
    const original = process.env.STICKY_DISK_GRPC_HOST

    afterEach(() => {
      if (original === undefined) {
        delete process.env.STICKY_DISK_GRPC_HOST
      } else {
        process.env.STICKY_DISK_GRPC_HOST = original
      }
    })

    it('reads STICKY_DISK_GRPC_HOST', () => {
      process.env.STICKY_DISK_GRPC_HOST = 'fd33::1'
      expect(new RoostBackend().host).toBe('fd33::1')
    })

    it('is the empty string when STICKY_DISK_GRPC_HOST is unset', () => {
      delete process.env.STICKY_DISK_GRPC_HOST
      expect(new RoostBackend().host).toBe('')
    })
  })

  describe('provisionMount', () => {
    it('returns the disk identifier when it is absolute and exists', async () => {
      mockExistsSync.mockReturnValue(true)
      const resp = new GetStickyDiskResponse({
        diskIdentifier: '/mnt/roost/expose-1'
      })
      const result = await backend.provisionMount(resp, '/ignored/mount/target')
      expect(result).toBe('/mnt/roost/expose-1')
    })

    it('ignores the mountTarget argument (roost is already mounted)', async () => {
      mockExistsSync.mockReturnValue(true)
      const resp = new GetStickyDiskResponse({
        diskIdentifier: '/mnt/roost/expose-2'
      })
      const result = await backend.provisionMount(
        resp,
        '/blacksmith-git-mirror/owner/repo'
      )
      expect(result).toBe('/mnt/roost/expose-2')
    })

    it('throws when the disk identifier is not absolute', async () => {
      mockExistsSync.mockReturnValue(true)
      const resp = new GetStickyDiskResponse({diskIdentifier: 'relative/path'})
      await expect(backend.provisionMount(resp, '/ignored')).rejects.toThrow(
        /not visible in pod/
      )
    })

    it('throws when the disk identifier does not exist', async () => {
      mockExistsSync.mockReturnValue(false)
      const resp = new GetStickyDiskResponse({
        diskIdentifier: '/mnt/roost/missing'
      })
      await expect(backend.provisionMount(resp, '/ignored')).rejects.toThrow(
        /not visible in pod/
      )
    })

    it('throws immediately when the signal is already aborted', async () => {
      const resp = new GetStickyDiskResponse({
        diskIdentifier: '/mnt/roost/expose-1'
      })
      const controller = new AbortController()
      controller.abort()
      await expect(
        backend.provisionMount(resp, '/ignored', controller.signal)
      ).rejects.toThrow()
    })
  })

  describe('prepareMirrorDir', () => {
    it('creates the directory recursively with a plain (unprivileged) mkdir', async () => {
      mockMkdir.mockResolvedValue(undefined)
      await backend.prepareMirrorDir('/mnt/roost/expose-1/v1')
      expect(mockMkdir).toHaveBeenCalledWith('/mnt/roost/expose-1/v1', {
        recursive: true
      })
    })
  })

  describe('releaseMount', () => {
    it('is a no-op that reports released=true', async () => {
      await expect(
        backend.releaseMount('/mnt/roost/expose-1')
      ).resolves.toEqual({released: true})
    })
  })
})

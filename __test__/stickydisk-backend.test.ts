import * as fs from 'fs'
import * as exec from '@actions/exec'
import {RoostBackend} from '../src/stickydisk/roost-backend'
import {BlacksmithBackend} from '../src/stickydisk/blacksmith-backend'
import {selectBackend} from '../src/stickydisk/backend'
import {GetStickyDiskResponse} from '../src/gen/stickydisk/v1/stickydisk_pb'

// Keep the [git-mirror] log lines out of the test output.
jest.mock('@actions/core')
jest.mock('@actions/exec')
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
const mockExec = exec.exec as jest.MockedFunction<typeof exec.exec>
const mockGetExecOutput = exec.getExecOutput as jest.MockedFunction<
  typeof exec.getExecOutput
>

// Minimal ExecOutput shaped result for the getExecOutput mock.
function execOutput(
  exitCode: number,
  stdout = '',
  stderr = ''
): {exitCode: number; stdout: string; stderr: string} {
  return {exitCode, stdout, stderr}
}

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

describe('BlacksmithBackend', () => {
  const backend = new BlacksmithBackend()

  it('advertises name=blacksmith, the fixed host, and stickyDiskType=git_mirror', () => {
    expect(backend.name).toBe('blacksmith')
    expect(backend.host).toBe('192.168.127.1')
    expect(backend.stickyDiskType).toBe('git_mirror')
  })

  describe('provisionMount', () => {
    it('formats an unformatted device, mounts it, and returns the mount target', async () => {
      // blkid reports no filesystem -> format path.
      mockGetExecOutput.mockResolvedValue(execOutput(2))
      mockExec.mockResolvedValue(0)
      const resp = new GetStickyDiskResponse({diskIdentifier: '/dev/vdb'})

      const result = await backend.provisionMount(
        resp,
        '/blacksmith-git-mirror/owner/repo'
      )

      expect(result).toBe('/blacksmith-git-mirror/owner/repo')
      expect(mockGetExecOutput).toHaveBeenCalledWith(
        'sudo',
        ['blkid', '/dev/vdb'],
        expect.anything()
      )
      expect(mockExec).toHaveBeenCalledWith(
        'sudo',
        expect.arrayContaining(['mkfs.ext4', '-F', '/dev/vdb'])
      )
      expect(mockExec).toHaveBeenCalledWith('sudo', [
        'mkdir',
        '-p',
        '/blacksmith-git-mirror/owner/repo'
      ])
      expect(mockExec).toHaveBeenCalledWith('sudo', [
        'mount',
        '/dev/vdb',
        '/blacksmith-git-mirror/owner/repo'
      ])
    })

    it('resizes an already-formatted device instead of reformatting', async () => {
      // blkid reports an existing filesystem -> resize2fs path.
      mockGetExecOutput.mockResolvedValue(execOutput(0, 'TYPE="ext4"'))
      mockExec.mockResolvedValue(0)
      const resp = new GetStickyDiskResponse({diskIdentifier: '/dev/vdb'})

      const result = await backend.provisionMount(resp, '/mnt/target')

      expect(result).toBe('/mnt/target')
      expect(mockExec).toHaveBeenCalledWith('sudo', [
        'resize2fs',
        '-f',
        '/dev/vdb'
      ])
      expect(mockExec).not.toHaveBeenCalledWith(
        'sudo',
        expect.arrayContaining(['mkfs.ext4'])
      )
    })

    it('honors an already-aborted signal', async () => {
      const resp = new GetStickyDiskResponse({diskIdentifier: '/dev/vdb'})
      const controller = new AbortController()
      controller.abort()
      await expect(
        backend.provisionMount(resp, '/mnt/target', controller.signal)
      ).rejects.toThrow()
    })
  })

  describe('prepareMirrorDir', () => {
    it('creates the dir with sudo and chowns it to the runner uid/gid', async () => {
      mockExec.mockResolvedValue(0)
      await backend.prepareMirrorDir('/blacksmith-git-mirror/owner/repo/v1')

      const uid = process.getuid?.() ?? 1000
      const gid = process.getgid?.() ?? 1000
      expect(mockExec).toHaveBeenCalledWith('sudo', [
        'mkdir',
        '-p',
        '/blacksmith-git-mirror/owner/repo/v1'
      ])
      expect(mockExec).toHaveBeenCalledWith('sudo', [
        'chown',
        '-R',
        `${uid}:${gid}`,
        '/blacksmith-git-mirror/owner/repo/v1'
      ])
    })
  })

  describe('releaseMount', () => {
    it('returns {released:true} when unmount succeeds on the first attempt', async () => {
      mockGetExecOutput.mockImplementation(
        async (cmd: string, args?: string[]) => {
          const a = args ?? []
          if (cmd === 'findmnt') {
            return execOutput(0, '/dev/vdb\n')
          }
          // timeout <secs> sudo umount <mp>
          if (cmd === 'timeout' && a[2] === 'umount') {
            return execOutput(0)
          }
          return execOutput(0)
        }
      )

      const result = await backend.releaseMount('/mnt/target')

      expect(result).toEqual({released: true})
      expect(mockGetExecOutput).toHaveBeenCalledWith(
        'timeout',
        ['10', 'sudo', 'umount', '/mnt/target'],
        expect.anything()
      )
    })

    it('returns {released:false} after exhausting the unmount retries', async () => {
      jest.useFakeTimers()
      mockGetExecOutput.mockImplementation(
        async (cmd: string, args?: string[]) => {
          const a = args ?? []
          if (cmd === 'findmnt') {
            return execOutput(0, '/dev/vdb\n')
          }
          if (cmd === 'timeout' && a[2] === 'umount') {
            return execOutput(1) // every unmount attempt fails
          }
          if (cmd === 'timeout' && a[1] === 'lsof') {
            return execOutput(0) // diagnostic probe resolves (no processes)
          }
          return execOutput(0)
        }
      )

      const promise = backend.releaseMount('/mnt/target')
      await jest.runAllTimersAsync()
      const result = await promise
      jest.useRealTimers()

      expect(result).toEqual({released: false})
      // Three unmount attempts were made.
      const umountCalls = mockGetExecOutput.mock.calls.filter(
        call => call[0] === 'timeout' && (call[1] as string[])[2] === 'umount'
      )
      expect(umountCalls).toHaveLength(3)
    })
  })
})

describe('selectBackend', () => {
  const originalProvider = process.env.STICKY_DISK_PROVIDER
  const originalHost = process.env.STICKY_DISK_GRPC_HOST

  function setEnv(
    provider: string | undefined,
    host: string | undefined
  ): void {
    if (provider === undefined) {
      delete process.env.STICKY_DISK_PROVIDER
    } else {
      process.env.STICKY_DISK_PROVIDER = provider
    }
    if (host === undefined) {
      delete process.env.STICKY_DISK_GRPC_HOST
    } else {
      process.env.STICKY_DISK_GRPC_HOST = host
    }
  }

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }

  afterEach(() => {
    restore('STICKY_DISK_PROVIDER', originalProvider)
    restore('STICKY_DISK_GRPC_HOST', originalHost)
  })

  // provider flag, host present?, expected backend name
  const cases: [string | undefined, boolean, string][] = [
    ['roost', true, 'roost'],
    ['roost', false, 'blacksmith'], // host-less roost -> Blacksmith fallback
    ['Roost', true, 'roost'], // case-insensitive
    ['blacksmith', true, 'blacksmith'],
    ['blacksmith', false, 'blacksmith'],
    ['auto', true, 'roost'],
    ['auto', false, 'blacksmith'],
    [undefined, true, 'roost'], // unset + host -> auto-detect roost
    [undefined, false, 'blacksmith'], // unset + no host -> Blacksmith
    ['bogus', true, 'roost'], // unknown flag -> auto-detect
    ['bogus', false, 'blacksmith']
  ]

  it.each(cases)('provider=%s host=%s -> %s', (provider, hasHost, expected) => {
    setEnv(provider, hasHost ? 'fd33::1' : undefined)
    expect(selectBackend().name).toBe(expected)
  })

  it('warns when roost is requested without a host, then falls back', () => {
    const core = jest.requireMock('@actions/core') as {
      warning: jest.Mock
    }
    core.warning.mockClear()
    setEnv('roost', undefined)
    expect(selectBackend().name).toBe('blacksmith')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('STICKY_DISK_GRPC_HOST is unset')
    )
  })

  it('warns on an unknown provider flag, then auto-detects', () => {
    const core = jest.requireMock('@actions/core') as {
      warning: jest.Mock
    }
    core.warning.mockClear()
    setEnv('bogus', 'fd33::1')
    expect(selectBackend().name).toBe('roost')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown STICKY_DISK_PROVIDER')
    )
  })
})

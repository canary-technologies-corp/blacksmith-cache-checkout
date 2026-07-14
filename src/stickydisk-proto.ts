// Vendored stickydisk.v1 message and service definitions.
//
// These were previously imported from the BSR-generated package
// @buf/blacksmith_vm-agent.connectrpc_es, which buf.build has since removed
// from its npm registry (the module 404s, so `npm ci` fails on a clean
// checkout). The definitions below replicate the generated code verbatim —
// message names, field numbers, and types are copied from the last dist
// bundle built against the real package, so wire compatibility with
// Blacksmith's VM agent (and roost, which reimplements the same protocol)
// is unchanged. Only the three RPCs this action calls are included.
import {proto3, ScalarType, MethodKind} from '@bufbuild/protobuf'

export const GetStickyDiskRequest = proto3.makeMessageType(
  'stickydisk.v1.GetStickyDiskRequest',
  () => [
    {no: 1, name: 'sticky_disk_key', kind: 'scalar', T: ScalarType.STRING},
    {no: 2, name: 'region', kind: 'scalar', T: ScalarType.STRING},
    {
      no: 3,
      name: 'installation_model_id',
      kind: 'scalar',
      T: ScalarType.STRING
    },
    {no: 4, name: 'vm_id', kind: 'scalar', T: ScalarType.STRING},
    {no: 5, name: 'sticky_disk_type', kind: 'scalar', T: ScalarType.STRING},
    {no: 6, name: 'repo_name', kind: 'scalar', T: ScalarType.STRING},
    {no: 7, name: 'sticky_disk_token', kind: 'scalar', T: ScalarType.STRING}
  ]
)

export const GetStickyDiskResponse = proto3.makeMessageType(
  'stickydisk.v1.GetStickyDiskResponse',
  () => [
    {no: 1, name: 'expose_id', kind: 'scalar', T: ScalarType.STRING},
    {no: 2, name: 'disk_identifier', kind: 'scalar', T: ScalarType.STRING},
    {
      no: 3,
      name: 'parent_snapshot_name',
      kind: 'scalar',
      T: ScalarType.STRING
    },
    {no: 4, name: 'clone_name', kind: 'scalar', T: ScalarType.STRING}
  ]
)

export const CommitStickyDiskRequest = proto3.makeMessageType(
  'stickydisk.v1.CommitStickyDiskRequest',
  () => [
    {no: 1, name: 'expose_id', kind: 'scalar', T: ScalarType.STRING},
    {no: 2, name: 'sticky_disk_key', kind: 'scalar', T: ScalarType.STRING},
    {no: 3, name: 'vm_id', kind: 'scalar', T: ScalarType.STRING},
    {no: 4, name: 'should_commit', kind: 'scalar', T: ScalarType.BOOL},
    {no: 5, name: 'repo_name', kind: 'scalar', T: ScalarType.STRING},
    {no: 6, name: 'sticky_disk_token', kind: 'scalar', T: ScalarType.STRING},
    {no: 7, name: 'fs_disk_usage_bytes', kind: 'scalar', T: ScalarType.INT64},
    {
      no: 8,
      name: 'vm_hydrated_git_mirror',
      kind: 'scalar',
      T: ScalarType.BOOL
    }
  ]
)

export const CommitStickyDiskResponse = proto3.makeMessageType(
  'stickydisk.v1.CommitStickyDiskResponse',
  () => []
)

export const UpRequest = proto3.makeMessageType('stickydisk.v1.UpRequest', [])

export const UpResponse = proto3.makeMessageType('stickydisk.v1.UpResponse', [])

export const StickyDiskService = {
  typeName: 'stickydisk.v1.StickyDiskService',
  methods: {
    getStickyDisk: {
      name: 'GetStickyDisk',
      I: GetStickyDiskRequest,
      O: GetStickyDiskResponse,
      kind: MethodKind.Unary
    },
    commitStickyDisk: {
      name: 'CommitStickyDisk',
      I: CommitStickyDiskRequest,
      O: CommitStickyDiskResponse,
      kind: MethodKind.Unary
    },
    up: {
      name: 'Up',
      I: UpRequest,
      O: UpResponse,
      kind: MethodKind.Unary
    }
  }
} as const

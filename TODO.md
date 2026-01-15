# TODO: Fix cache key for cross-repository checkouts

## Problem

When `blacksmith-cache-checkout` is used in a reusable workflow that checks out a different repository, the cache key is incorrect.

### Example Scenario

`canary-kubernetes` calls a reusable workflow in `canary`:

```yaml
# In canary-kubernetes/.github/workflows/create-environment-dispatch.yml
build-canary:
  uses: canary-technologies-corp/canary/.github/workflows/canary_multi_region_build_and_push_eks.yml@master
```

The reusable workflow checks out the canary repo:

```yaml
# In canary/.github/workflows/canary_multi_region_build_and_push_eks.yml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v0.0.5
  with:
    repository: canary-technologies-corp/canary
    ref: ${{ inputs.image_version }}
```

### Current Behavior (Bug)

The stickydisk step uses:

```yaml
key: ${{ inputs.cache-key || format('{0}-git', github.repository) }}
```

- `inputs.repository` = `canary-technologies-corp/canary` (correct)
- Cache key uses `github.repository` = `canary-technologies-corp/canary-kubernetes` (wrong!)

This causes cache misses because the cache key doesn't match the repository being checked out.

## Root Cause

`github.repository` always refers to the **caller's repository** (the workflow that triggered the run), not the repository being checked out.

When an input has a default like `default: ${{ github.repository }}`, that default is evaluated at call time. But using `github.repository` directly inside the action always evaluates to the caller's repo, ignoring any explicit `repository` input.

| Expression | When `repository` input is passed | When `repository` input is NOT passed |
|------------|-----------------------------------|---------------------------------------|
| `inputs.repository` | Uses passed value | Uses default (`github.repository`) |
| `github.repository` | Always caller's repo | Always caller's repo |

## Fix

In `action.yml`, change the stickydisk step from:

```yaml
- name: Mount sticky disk for .git
  id: stickydisk
  if: steps.detect.outputs.is-blacksmith == 'true'
  continue-on-error: true
  uses: useblacksmith/stickydisk@v1
  with:
    key: ${{ inputs.cache-key || format('{0}-git', github.repository) }}
    path: ${{ inputs.path && format('{0}/{1}', github.workspace, inputs.path) || github.workspace }}/.git
```

To:

```yaml
- name: Mount sticky disk for .git
  id: stickydisk
  if: steps.detect.outputs.is-blacksmith == 'true'
  continue-on-error: true
  uses: useblacksmith/stickydisk@v1
  with:
    key: ${{ inputs.cache-key || format('{0}-git', inputs.repository) }}
    path: ${{ inputs.path && format('{0}/{1}', github.workspace, inputs.path) || github.workspace }}/.git
```

This ensures the cache key matches the repository actually being checked out.

## Expected Behavior After Fix

| Scenario | `inputs.repository` | Cache Key |
|----------|---------------------|-----------|
| Cross-repo: `repository: canary` passed | `canary-technologies-corp/canary` | `canary-technologies-corp/canary-git` |
| Same-repo: no `repository` passed | `canary-technologies-corp/canary-kubernetes` (default) | `canary-technologies-corp/canary-kubernetes-git` |

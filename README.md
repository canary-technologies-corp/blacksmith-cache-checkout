# Blacksmith Cache Checkout

A GitHub Action that uses [Blacksmith sticky disk](https://github.com/useblacksmith/stickydisk) to cache git mirrors for faster checkouts. Uses raw git commands with `--reference-if-able --dissociate` pattern to prevent cache poisoning.

## Features

- **Fast Checkouts**: Reuses objects from cached mirror via `git clone --reference`
- **Cache Isolation**: Mirror is read-only during normal checkouts, preventing poisoning
- **Safety First**: Uses `--dissociate` to create fully independent workspace clones
- **Automatic Fallback**: Falls back to plain clone if cache unavailable or corrupted
- **Cross-repo Support**: Correctly handles checkouts of different repositories
- **Refresh Mode**: Manual cache invalidation via `refresh-cache: true`

## Usage

### Basic Usage

```yaml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v1.0.0
  with:
    repository: owner/repo
```

### Advanced Usage

```yaml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v1.0.0
  with:
    repository: owner/repo
    ref: feature-branch
    fetch-depth: 0  # Full history
    path: subdir    # Checkout to subdirectory
```

### SSH Authentication

```yaml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v1.0.0
  with:
    repository: owner/private-repo
    ssh-key: ${{ secrets.DEPLOY_KEY }}
```

### Fix Poisoned Cache

If you suspect cache corruption, run workflow with `refresh-cache: true` once:

```yaml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v1.0.0
  with:
    repository: owner/repo
    refresh-cache: true  # Clears and rebuilds mirror
```

## Inputs

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `repository` | Repository name with owner (e.g., `owner/repo`) | `${{ github.repository }}` | No |
| `ref` | Branch, tag, or SHA to checkout | `${{ github.ref }}` | No |
| `token` | GitHub token for HTTPS auth | `${{ github.token }}` | No |
| `ssh-key` | SSH private key for SSH auth | | No |
| `fetch-depth` | Number of commits to fetch (0 for full history) | `1` | No |
| `path` | Relative path to checkout | | No |
| `refresh-cache` | Clear cache and re-clone fresh (use to fix poisoned cache) | `false` | No |

## Outputs

| Output | Description |
|--------|-------------|
| `ref` | Branch or SHA checked out |
| `commit` | Commit SHA checked out |

## How It Works

### Architecture

```
┌─────────────────────────────────────┐
│     STICKY DISK (cached mirror)     │
│     /tmp/git-mirror/.git            │
│  - Only written in refresh mode     │
│  - Read-only during normal checkout │
└──────────────────┬──────────────────┘
                   │ --reference-if-able --dissociate
                   ▼
┌─────────────────────────────────────┐
│   WORKSPACE (ephemeral)             │
│   $GITHUB_WORKSPACE/.git            │
│  - Fresh clone each run             │
│  - Objects copied from mirror       │
│  - Fully independent (dissociated)  │
│  - Never committed to cache         │
└─────────────────────────────────────┘
```

### Safety Guarantees

1. **`--reference-if-able`**: If mirror is missing/corrupt, git warns but continues without it
2. **`--dissociate`**: Workspace is fully independent after clone (no alternates link)
3. **Fallback**: If reference clone fails entirely, retries without reference
4. **Mirror isolation**: Mirror only updated in `refresh-cache` mode, never during normal checkout

### Cache Key

Cache key format: `v1-{repository}-git-mirror`

- `v1` prefix allows future cache invalidation on breaking changes
- Uses `inputs.repository` (not `github.repository`) to support cross-repo checkouts
- Shared across all branches (base branch cache available to PRs)

### Non-Blacksmith Runners

On non-Blacksmith or non-Linux runners, the action gracefully skips caching and performs a regular clone.

## Migration from v0.x

The v1.0.0 release changes the caching strategy from caching workspace `.git` to caching a separate mirror. Existing workflows need no changes - inputs are backward compatible.

### Breaking Changes

- Removed unused inputs: `cache-key`, `clean`, `filter`, `sparse-checkout`, `sparse-checkout-cone-mode`, `fetch-tags`, `show-progress`, `lfs`, `submodules`, `ssh-known-hosts`, `ssh-strict`, `ssh-user`, `persist-credentials`, `set-safe-directory`, `github-server-url`
- Removed `cache-hit` output (not meaningful with new mirror-based architecture)
- Changed from using `actions/checkout` internally to raw git commands

If you were using any of the removed inputs, they will be silently ignored. Consider switching to raw `actions/checkout@v4` if you need those features.

## Performance

First run (cold cache):
- Initializes mirror with `git clone --mirror --filter=blob:none`
- Performs regular clone to workspace
- ~same speed as `actions/checkout`

Subsequent runs (warm cache):
- Updates mirror with `git fetch --all --prune --prune-tags`
- Clones workspace using `--reference-if-able --dissociate`
- **2-5x faster** than full clone, depending on repo size

## License

MIT

## Credits

- Inspired by [nscloud-checkout-action](https://github.com/namespacelabs/nscloud-checkout-action)
- Uses [Blacksmith sticky disk](https://github.com/useblacksmith/stickydisk) for caching
- Auth logic adapted from [actions/checkout](https://github.com/actions/checkout)

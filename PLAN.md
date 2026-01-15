# blacksmith-cache-checkout v2 Plan

## Goal

Replace `actions/checkout` with raw git commands using `--reference` pattern to prevent cache poisoning.

## Architecture

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

## Git `--reference` Research

### Failure Modes

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| Reference path doesn't exist | `--reference`: fails (exit 128) | Use `--reference-if-able` |
| Reference is corrupted | Clone succeeds but later ops fail | Use `--dissociate` to copy objects |
| Reference missing objects | Silent corruption, fails on access | Use `--dissociate` + fallback |
| Reference deleted after clone | Subsequent git ops fail | Use `--dissociate` |

### `--dissociate` Option

- Runs `git repack -a -d` after clone to copy all objects locally
- Removes `.git/objects/info/alternates` (severs dependency)
- Result: fully independent clone, immune to reference corruption
- Trade-off: slightly slower (repack step), but safer for CI

### Best Practice for CI

Use `--reference-if-able --dissociate`:
- `--reference-if-able`: graceful fallback if reference unavailable (warns but continues)
- `--dissociate`: creates independent clone, no ongoing dependency on mirror

## Inputs (Simplified)

Only support what Canary actually uses:

```yaml
inputs:
  repository:
    description: 'Repository name with owner (e.g., owner/repo)'
    default: ${{ github.repository }}
  ref:
    description: 'Branch, tag, or SHA to checkout'
    required: false
  token:
    description: 'GitHub token for HTTPS auth'
    default: ${{ github.token }}
  ssh-key:
    description: 'SSH private key for SSH auth'
    required: false
  fetch-depth:
    description: 'Number of commits to fetch (0 for full history)'
    default: '1'
  path:
    description: 'Relative path to checkout'
    required: false
  refresh-cache:
    description: 'Clear cache and re-clone fresh (use to fix poisoned cache)'
    default: 'false'
```

**Removed inputs** (not used by Canary):
- `clean`, `filter`, `sparse-checkout`, `sparse-checkout-cone-mode`
- `fetch-tags`, `show-progress`, `lfs`, `submodules`
- `ssh-known-hosts`, `ssh-strict`, `ssh-user`
- `persist-credentials`, `set-safe-directory`, `github-server-url`

## Implementation

### Step 1: Detect Blacksmith Runner

```yaml
- name: Detect Blacksmith runner
  id: detect
  shell: bash
  run: |
    if [ -n "$BLACKSMITH_VM_ID" ] && [ "$RUNNER_OS" = "Linux" ]; then
      echo "is-blacksmith=true" >> $GITHUB_OUTPUT
    else
      echo "is-blacksmith=false" >> $GITHUB_OUTPUT
    fi
```

### Step 2: Mount Sticky Disk

```yaml
- name: Mount sticky disk
  id: stickydisk
  if: steps.detect.outputs.is-blacksmith == 'true'
  continue-on-error: true
  uses: useblacksmith/stickydisk@v1
  with:
    # FIX: Use inputs.repository not github.repository
    # Version prefix (v1) allows cache invalidation on breaking changes
    key: ${{ format('v1-{0}-git-mirror', inputs.repository) }}
    path: /tmp/git-mirror
```

### Step 3: Setup Auth + Clone with Reference

Git logic adapted from [actions/checkout](https://github.com/actions/checkout). Key source references:

| Operation | Source File | Link |
|-----------|-------------|------|
| SSH key setup | `src/git-auth-helper.ts` | [configureGlobalAuth()](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L90-L150) |
| Known hosts | `src/git-auth-helper.ts` | [configureGlobalAuth()](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L120-L140) |
| Token auth header | `src/git-auth-helper.ts` | [configureToken()](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L200-L230) |
| URL construction | `src/url-helper.ts` | [getFetchUrl()](https://github.com/actions/checkout/blob/main/src/url-helper.ts#L20-L50) |
| Ref checkout | `src/git-source-provider.ts` | [getSource()](https://github.com/actions/checkout/blob/main/src/git-source-provider.ts#L100-L200) |
| SSH cleanup | `src/git-auth-helper.ts` | [removeGlobalAuth()](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L250-L280) |

```yaml
- name: Checkout
  id: checkout
  shell: bash
  env:
    REPO: ${{ inputs.repository }}
    REF: ${{ inputs.ref || github.ref }}
    TOKEN: ${{ inputs.token }}
    SSH_KEY: ${{ inputs.ssh-key }}
    FETCH_DEPTH: ${{ inputs.fetch-depth }}
    WORKSPACE: ${{ inputs.path && format('{0}/{1}', github.workspace, inputs.path) || github.workspace }}
    MIRROR_PATH: /tmp/git-mirror
    REFRESH_CACHE: ${{ inputs.refresh-cache }}
    USE_MIRROR: ${{ steps.detect.outputs.is-blacksmith == 'true' && steps.stickydisk.outcome == 'success' }}
  run: |
    set -euo pipefail

    # === Refresh cache mode ===
    if [ "$REFRESH_CACHE" = "true" ] && [ "$USE_MIRROR" = "true" ]; then
      echo "🔄 Refresh mode: clearing mirror cache"
      rm -rf "$MIRROR_PATH"/* "$MIRROR_PATH"/.[!.]* 2>/dev/null || true
    fi

    # === Setup auth (from actions/checkout) ===
    if [ -n "$SSH_KEY" ]; then
      # SSH auth
      SSH_KEY_PATH="$RUNNER_TEMP/ssh_key_$$"
      echo "$SSH_KEY" > "$SSH_KEY_PATH"
      chmod 600 "$SSH_KEY_PATH"

      KNOWN_HOSTS_PATH="$RUNNER_TEMP/known_hosts_$$"
      [ -f ~/.ssh/known_hosts ] && cat ~/.ssh/known_hosts > "$KNOWN_HOSTS_PATH"
      echo "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=" >> "$KNOWN_HOSTS_PATH"

      export GIT_SSH_COMMAND="ssh -i '$SSH_KEY_PATH' -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$KNOWN_HOSTS_PATH'"
      REPO_URL="git@github.com:${REPO}.git"
    else
      # HTTPS auth with token
      REPO_URL="https://github.com/${REPO}"
      AUTH_HEADER="AUTHORIZATION: basic $(echo -n "x-access-token:${TOKEN}" | base64)"
    fi

    # === Helper function for git with auth ===
    git_auth() {
      if [ -n "${AUTH_HEADER:-}" ]; then
        git -c "http.https://github.com/.extraheader=$AUTH_HEADER" "$@"
      else
        git "$@"
      fi
    }

    # === Mask credentials in logs ===
    if [ -n "${TOKEN:-}" ]; then
      echo "::add-mask::$TOKEN"
    fi

    # === Ensure mirror exists (only if USE_MIRROR) ===
    if [ "$USE_MIRROR" = "true" ]; then
      if [ ! -d "$MIRROR_PATH/objects" ]; then
        echo "📦 Initializing mirror cache"
        git_auth clone --mirror --filter=blob:none "$REPO_URL" "$MIRROR_PATH" || true
      else
        echo "🔄 Updating mirror cache"
        # --prune and --prune-tags keep mirror lean (from nscloud pattern)
        git_auth -C "$MIRROR_PATH" fetch --all --prune --prune-tags 2>/dev/null || true
      fi
    fi

    # === Clone workspace ===
    mkdir -p "$WORKSPACE"
    cd "$WORKSPACE"

    DEPTH_ARG=""
    [ "$FETCH_DEPTH" != "0" ] && DEPTH_ARG="--depth $FETCH_DEPTH"

    # Try with reference first, fallback to plain clone
    CLONE_SUCCESS=false

    if [ "$USE_MIRROR" = "true" ] && [ -d "$MIRROR_PATH/objects" ]; then
      echo "🚀 Cloning with reference (--reference-if-able --dissociate)"
      # --reference-if-able: warns but continues if reference unavailable
      # --dissociate: copies objects locally, removes alternates dependency
      if git_auth clone $DEPTH_ARG --reference-if-able "$MIRROR_PATH" --dissociate "$REPO_URL" .; then
        CLONE_SUCCESS=true
        echo "✅ Clone with reference succeeded"
      else
        echo "⚠️ Clone with reference failed, falling back to plain clone"
        rm -rf .git 2>/dev/null || true
      fi
    fi

    if [ "$CLONE_SUCCESS" = "false" ]; then
      echo "📥 Cloning without reference"
      git_auth clone $DEPTH_ARG "$REPO_URL" .
    fi

    # === Checkout specific ref ===
    if [ -n "$REF" ]; then
      CURRENT_REF="refs/heads/$(git symbolic-ref --short HEAD 2>/dev/null || true)"
      if [ "$REF" != "$CURRENT_REF" ]; then
        echo "🔀 Checking out $REF"
        git_auth fetch origin "$REF" $DEPTH_ARG || true
        git checkout FETCH_HEAD --quiet 2>/dev/null || git checkout "$REF" --quiet
      fi
    fi

    # === Output ===
    echo "ref=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse HEAD)" >> $GITHUB_OUTPUT
    echo "commit=$(git rev-parse HEAD)" >> $GITHUB_OUTPUT

    # === Cleanup SSH ===
    rm -f "${SSH_KEY_PATH:-}" "${KNOWN_HOSTS_PATH:-}" 2>/dev/null || true
```

## Outputs

```yaml
outputs:
  ref:
    description: 'Branch or SHA checked out'
    value: ${{ steps.checkout.outputs.ref }}
  commit:
    description: 'Commit SHA checked out'
    value: ${{ steps.checkout.outputs.commit }}
```

## Key Differences from v1

| Aspect | v1 (current) | v2 (new) |
|--------|--------------|----------|
| Checkout method | `actions/checkout@v4` | Raw git with `--reference-if-able --dissociate` |
| Cache target | Workspace `.git` | Separate mirror at `/tmp/git-mirror` |
| Cache writes | Every run | Only in `refresh-cache` mode |
| Poisoning risk | High | None (mirror read-only, workspace dissociated) |
| Cache key | `github.repository` (bug) | `inputs.repository` (fixed) |
| Fallback | None | Auto-fallback to plain clone if reference fails |

## Safety Guarantees

1. **`--reference-if-able`**: If mirror is missing/corrupt, git warns but continues without it
2. **`--dissociate`**: Workspace is fully independent after clone (no alternates link)
3. **Fallback**: If reference clone fails entirely, retries without reference
4. **Mirror isolation**: Mirror only updated in `refresh-cache` mode, never during normal checkout

## Migration

Existing workflows need no changes - inputs are backward compatible.

To fix a poisoned cache, run workflow with `refresh-cache: true` once.

## Learnings from nscloud-checkout-action

Reference: [nscloud-checkout-action](https://github.com/namespacelabs/nscloud-checkout-action/blob/main/src/main.ts)

### Key Patterns Adopted

| Pattern | Their Approach | Our Adoption |
|---------|----------------|--------------|
| Cache versioning | `v2/owner-repo` path prefix | Add `v1` to cache key for future invalidation |
| Alternates vs dissociate | Default to alternates (faster), dissociate optional | Use `--dissociate` always for safety in CI |
| Mirror pruning | `git fetch --prune --prune-tags` | Add `--prune --prune-tags` to mirror updates |
| Error handling | Simple - delegate to orchestration | Keep simple, add fallback only |
| Cleanup robustness | `ignoreReturnCode: true` for cleanup | Use `|| true` for cleanup commands |
| Credential masking | Uses `core.setSecret()` | Use `::add-mask::` in bash |

### Patterns Not Adopted

| Pattern | Reason |
|---------|--------|
| `GIT_ALTERNATE_OBJECTS_DIRECTORIES` env var | `--reference` is simpler and equivalent |
| No dissociate by default | We prefer safety over speed in CI |
| Version-based cache invalidation only | We add `refresh-cache` input for manual control |

## Testing

1. Normal checkout (no cache) → fresh clone works
2. Cache hit → uses reference, fast clone, dissociated
3. Cache miss → populates mirror, then clones
4. Corrupted cache → `--reference-if-able` warns, clone succeeds anyway
5. Reference clone fails → fallback to plain clone works
6. Poisoned cache + `refresh-cache: true` → clears and rebuilds
7. Cross-repo checkout → correct cache key used
8. SSH auth → key setup and cleanup works
9. Token auth → extraheader works
10. `fetch-depth: 0` → full history fetched
11. `ref: <sha>` → specific commit checked out

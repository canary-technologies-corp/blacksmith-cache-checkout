# Review: blacksmith-cache-checkout vs nscloud-checkout-action vs actions/checkout

## Architecture Comparison

| Aspect | blacksmith-cache-checkout | nscloud-checkout-action | actions/checkout |
|--------|---------------------------|------------------------|------------------|
| **Language** | Bash (composite action) | TypeScript | TypeScript |
| **Cache mechanism** | Blacksmith sticky disk | `NSC_GIT_MIRROR` env | None (stateless) |
| **Mirror strategy** | `--reference-if-able --dissociate` | `GIT_ALTERNATE_OBJECT_DIRECTORIES` env | N/A |
| **Fallback** | Auto-fallback to plain clone | Hard fail without cache | N/A |

## Strengths of Current Implementation

1. **Safety-first with `--dissociate`** - Always creates independent clone, immune to cache corruption
2. **Graceful fallback** - Won't fail builds if cache unavailable
3. **SSH support** - nscloud doesn't support SSH auth
4. **Simple bash** - Easy to debug and understand
5. **`refresh-cache` manual control** - Users can fix poisoned cache

## Proposed Fixes

### 1. Add `clean` Input

**Problem**: Stale files from previous runs may cause issues.

**Current behavior** (line 140-144):
```bash
# Clean workspace if it has existing .git (from previous failed run)
if [ -d ".git" ]; then
  echo "⚠️ Cleaning existing .git directory"
  rm -rf .git
fi
```

Only removes `.git`, not workspace files.

**Proposed fix** - Add input and clean logic:
```yaml
# In inputs section:
clean:
  description: 'Remove untracked files before checkout'
  default: 'true'
```

```bash
# In env section:
CLEAN: ${{ inputs.clean }}

# Before clone:
if [ "$CLEAN" = "true" ] && [ -d ".git" ]; then
  echo "🧹 Cleaning workspace"
  git clean -ffdx || true
  git reset --hard || true
fi
rm -rf .git 2>/dev/null || true
```

---

### 2. Improve Ref Resolution

**Problem**: Current ref handling is simplistic (line 170-178):
```bash
if [ -n "$REF" ]; then
  CURRENT_REF="refs/heads/$(git symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ "$REF" != "$CURRENT_REF" ]; then
    echo "🔀 Checking out $REF"
    git_auth fetch origin "$REF" $DEPTH_ARG || true
    git checkout FETCH_HEAD --quiet 2>/dev/null || git checkout "$REF" --quiet
  fi
fi
```

**Fails for**:
- PR refs (`refs/pull/123/merge`, `refs/pull/123/head`)
- SHA-only checkouts with shallow depth
- Tags (`refs/tags/v1.0.0`)
- Unqualified refs that don't match remote

**How nscloud handles it** (`getCheckoutInfo` function):
```typescript
// refs/heads/
if (upperRef.startsWith('REFS/HEADS/')) {
  const branch = ref.substring('refs/heads/'.length)
  result.originalRef = ref
  result.pointerRef = `refs/remotes/origin/${branch}`
  result.startBranch = branch
}
// refs/pull/
else if (upperRef.startsWith('REFS/PULL/')) {
  const branch = ref.substring('refs/pull/'.length)
  result.originalRef = ref
  result.pointerRef = `refs/remotes/pull/${branch}`
}
// tags and other refs
else if (ref) {
  result.originalRef = ref
  result.pointerRef = ref
}
// commit SHA only
else {
  result.originalRef = commit
  result.pointerRef = commit
}
```

**Proposed fix** - Bash equivalent:
```bash
# === Resolve ref type and build fetch refspec ===
resolve_ref() {
  local ref="$1"
  local sha_pattern='^[0-9a-fA-F]{40}$'

  # SHA-only (40 hex chars)
  if [[ "$ref" =~ $sha_pattern ]]; then
    echo "sha:$ref"
    return
  fi

  # Fully qualified refs
  case "$ref" in
    refs/heads/*)
      local branch="${ref#refs/heads/}"
      echo "branch:$branch"
      ;;
    refs/pull/*/head|refs/pull/*/merge)
      echo "pr:$ref"
      ;;
    refs/tags/*)
      echo "tag:$ref"
      ;;
    refs/*)
      echo "ref:$ref"
      ;;
    *)
      # Unqualified - could be branch, tag, or SHA prefix
      echo "unqualified:$ref"
      ;;
  esac
}

# === Checkout specific ref ===
if [ -n "$REF" ]; then
  REF_INFO=$(resolve_ref "$REF")
  REF_TYPE="${REF_INFO%%:*}"
  REF_VALUE="${REF_INFO#*:}"

  echo "🔀 Checking out $REF (type: $REF_TYPE)"

  case "$REF_TYPE" in
    sha)
      # Fetch specific commit - need unshallow for shallow clones
      if [ "$FETCH_DEPTH" != "0" ]; then
        git_auth fetch --depth=1 origin "$REF_VALUE" || git_auth fetch --unshallow origin
      fi
      git checkout "$REF_VALUE" --quiet
      ;;
    branch)
      git_auth fetch origin "$REF" $DEPTH_ARG
      git checkout -B "$REF_VALUE" "origin/$REF_VALUE" --quiet
      ;;
    pr)
      # PR refs need explicit refspec
      git_auth fetch origin "+$REF:refs/remotes/origin/${REF#refs/}" $DEPTH_ARG
      git checkout FETCH_HEAD --quiet
      ;;
    tag)
      git_auth fetch origin "$REF:$REF" --no-tags $DEPTH_ARG
      git checkout "$REF" --quiet
      ;;
    *)
      # Unqualified - let git figure it out
      git_auth fetch origin "$REF" $DEPTH_ARG || true
      git checkout "$REF" --quiet 2>/dev/null || git checkout FETCH_HEAD --quiet
      ;;
  esac
fi
```

---

### 3. Always Persist Credentials

**Problem**: Subsequent git operations (fetch, push) fail without credentials.

**How actions/checkout does it**: Defaults to `true`, stores token in `.git/config`.

**How nscloud does it**:
```typescript
if (config.persistCredentials) {
  await configGitAuth(config.token, { repoDir })
}
```

**Proposed fix** - Always persist (no input needed):
```bash
# After checkout, always persist credentials:
echo "🔑 Persisting credentials"
if [ -n "$SSH_KEY" ]; then
  # For SSH, configure insteadOf to use SSH for github.com
  git config --local url."git@github.com:".insteadOf "https://github.com/"
  # Note: SSH key itself isn't persisted (user should use ssh-agent)
else
  # For HTTPS, store the extraheader
  git config --local "http.https://github.com/.extraheader" "$AUTH_HEADER"
fi

# Keep SSH cleanup (temp files only, credentials already persisted in git config)
rm -f "${SSH_KEY_PATH:-}" "${KNOWN_HOSTS_PATH:-}" 2>/dev/null || true
```

---

## Summary of Changes

| Fix | Priority | Complexity | Impact |
|-----|----------|------------|--------|
| Improve ref resolution | High | Medium | Fixes PR/tag/SHA checkout failures |
| Always persist credentials | Medium | Low | Enables subsequent git operations |
| Add `clean` input | Low | Low | Prevents stale file issues |

## Decision: `--filter=blob:none` for Mirror?

**Answer: No, keep full mirror.**

| Approach | Mirror Size | Clone Speed | Network on Clone |
|----------|-------------|-------------|------------------|
| `--filter=blob:none` | Small | Slower | Must fetch blobs from remote |
| Full mirror (current) | Larger | **Fastest** | Zero network for cached objects |

The current implementation correctly uses full mirror for maximum performance.

# Blacksmith Cache Checkout

A GitHub Action that wraps [actions/checkout](https://github.com/actions/checkout) with [Blacksmith sticky disk](https://github.com/useblacksmith/stickydisk) caching for faster checkouts.

## Usage

```yaml
- uses: canary-technologies-corp/blacksmith-cache-checkout@v1
  with:
    cache-key: ${{ github.repository }}-git
```

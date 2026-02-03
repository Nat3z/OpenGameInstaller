# Typecheck with GitHub Comments

This directory contains tools for running typecheck and automatically posting results to GitHub PRs.

## Scripts

### `typecheck-with-comment.sh`

Runs the typecheck suite and optionally posts a comment to a GitHub PR with the results.

**Usage:**

```bash
# Just run typecheck locally
bash scripts/typecheck-with-comment.sh

# Run and post results to a GitHub PR
bash scripts/typecheck-with-comment.sh \
  --post-comment \
  --pr-number 57 \
  --token $GITHUB_TOKEN
```

**Output:**
- Displays a formatted table with typecheck results
- Counts Svelte errors/warnings
- Counts TypeScript errors
- Posts to GitHub PR comments if requested
- Returns exit code 0 if all checks pass, 1 if any fail

### `post-typecheck-comment.sh`

Standalone script for posting typecheck results to GitHub. Less featured than the above.

```bash
./post-typecheck-comment.sh <owner> <repo> <pr-number> <github-token>
```

## GitHub Actions Workflow

`.github/workflows/typecheck-comment.yml` - Automatically runs on every PR that touches TypeScript/Svelte files.

**Features:**
- ✅ Runs on PR with relevant file changes
- ✅ Auto-posts comment with results
- ✅ Links to workflow run
- ✅ Extracts error details
- ✅ Works with GitHub secrets

**Configuration:**

The workflow uses `secrets.GITHUB_TOKEN` which is automatically provided by GitHub Actions.

## Example Comment Output

```
✅ Typecheck Results: ✅ PASSED

Summary
Check           Status
Svelte Check    0 errors, 371 warnings
TypeScript      0 errors

[View full workflow run](https://github.com/Nat3z/OpenGameInstaller/actions/runs/12345)
```

## Error Example

```
❌ Typecheck Results: ❌ FAILED

Summary
Check           Status
Svelte Check    0 errors, 371 warnings
TypeScript      2 errors

Errors Found
src/electron/main.ts(8,40): error TS2307: Cannot find module 'ogi-addon/config'
src/electron/startup.ts(67,15): error TS1378: Top-level 'await' expressions...

[View full workflow run](...)
```

## Integration with CI/CD

To use in your CI pipeline:

```yaml
- name: Typecheck
  run: bash scripts/typecheck-with-comment.sh \
    --post-comment \
    --pr-number ${{ github.event.pull_request.number }} \
    --token ${{ secrets.GITHUB_TOKEN }}
  continue-on-error: true
```

The `continue-on-error: true` allows the job to report even if checks fail.

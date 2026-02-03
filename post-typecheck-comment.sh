#!/bin/bash

# Post typecheck results to GitHub PR comment
# Usage: ./post-typecheck-comment.sh <owner> <repo> <pr-number> <token>

set -e

OWNER="${1:-Nat3z}"
REPO="${2:-OpenGameInstaller}"
PR_NUMBER="${3}"
GITHUB_TOKEN="${4}"

if [ -z "$PR_NUMBER" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "Usage: $0 <owner> <repo> <pr-number> <github-token>"
  exit 1
fi

# Run typecheck and capture output
echo "Running typecheck..."
TYPECHECK_OUTPUT=$(bun run typecheck 2>&1 || true)

# Parse results
SVELTE_ERRORS=$(echo "$TYPECHECK_OUTPUT" | grep "svelte-check found" | grep -oP '\d+(?= errors)' || echo "0")
SVELTE_WARNINGS=$(echo "$TYPECHECK_OUTPUT" | grep "svelte-check found" | grep -oP '\d+(?= warnings)' || echo "0")

# Check for TypeScript errors
TS_ERRORS=$(echo "$TYPECHECK_OUTPUT" | grep -c "error TS" || echo "0")

# Extract error details
ERROR_DETAILS=$(echo "$TYPECHECK_OUTPUT" | grep -A1 "error TS" | head -20 || echo "")

# Determine status
if [ "$SVELTE_ERRORS" -eq 0 ] && [ "$TS_ERRORS" -eq 0 ]; then
  STATUS="✅ PASSED"
  COLOR="green"
else
  STATUS="❌ FAILED"
  COLOR="red"
fi

# Create GitHub comment
COMMENT="## Typecheck Results $STATUS

### Summary
- **Svelte:** $SVELTE_ERRORS errors, $SVELTE_WARNINGS warnings
- **TypeScript:** $TS_ERRORS errors

### Details
\`\`\`
$TYPECHECK_OUTPUT
\`\`\`
"

# If there are errors, add error details
if [ "$TS_ERRORS" -gt 0 ]; then
  COMMENT+="

### Errors Found
\`\`\`
$ERROR_DETAILS
\`\`\`
"
fi

# Post to GitHub
echo "Posting comment to GitHub PR #$PR_NUMBER..."
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"body\": $(echo "$COMMENT" | jq -R -s '.')}" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/$PR_NUMBER/comments"

echo "Comment posted!"

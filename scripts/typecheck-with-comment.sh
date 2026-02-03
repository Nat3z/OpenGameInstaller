#!/bin/bash

# Typecheck runner with GitHub comment posting
# Usage: ./scripts/typecheck-with-comment.sh [--post-comment] [--pr-number 123] [--token xxx]

set -e

POST_COMMENT=false
PR_NUMBER=""
GITHUB_TOKEN=""
OWNER="Nat3z"
REPO="OpenGameInstaller"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --post-comment)
      POST_COMMENT=true
      shift
      ;;
    --pr-number)
      PR_NUMBER="$2"
      shift 2
      ;;
    --token)
      GITHUB_TOKEN="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Run typecheck
echo "▶️  Running typecheck..."
TYPECHECK_OUTPUT=$(bun run typecheck 2>&1 || true)
TYPECHECK_EXIT_CODE=$?

# Parse results
SVELTE_LINE=$(echo "$TYPECHECK_OUTPUT" | grep "svelte-check found" || echo "")
SVELTE_ERRORS=$(echo "$SVELTE_LINE" | grep -oP '\d+(?= errors)' | head -1 || echo "0")
SVELTE_WARNINGS=$(echo "$SVELTE_LINE" | grep -oP '\d+(?= warnings)' | head -1 || echo "0")

# Clean up any newlines
SVELTE_ERRORS=$(echo "$SVELTE_ERRORS" | tr -d '\n' | tr -d ' ')
SVELTE_WARNINGS=$(echo "$SVELTE_WARNINGS" | tr -d '\n' | tr -d ' ')

# Count TypeScript errors
TS_ERROR_COUNT=$(echo "$TYPECHECK_OUTPUT" | grep -c "error TS" || true)
TS_ERRORS=$((TS_ERROR_COUNT))

# Extract error lines
ERROR_LINES=$(echo "$TYPECHECK_OUTPUT" | grep "error TS" | head -10 || echo "")

# Determine status
if [ "${SVELTE_ERRORS:-0}" = "0" ] && [ "$TS_ERRORS" -eq 0 ]; then
  STATUS="✅ PASSED"
  EMOJI="✅"
  EXIT_CODE=0
else
  STATUS="❌ FAILED"
  EMOJI="❌"
  EXIT_CODE=1
fi

# Display results locally
echo ""
echo "================================================"
echo "Typecheck Results: $STATUS"
echo "================================================"
echo "Svelte:      ${SVELTE_ERRORS:-0} errors, ${SVELTE_WARNINGS:-0} warnings"
echo "TypeScript:  $TS_ERRORS errors"
echo "================================================"
echo ""

# Post to GitHub if requested and we have credentials
if [ "$POST_COMMENT" = true ] && [ -n "$PR_NUMBER" ] && [ -n "$GITHUB_TOKEN" ]; then
  echo "📝 Posting comment to GitHub PR #$PR_NUMBER..."
  
  # Create the comment body
  read -r -d '' COMMENT_BODY << EOF || true
## $EMOJI Typecheck Results: $STATUS

### Summary
| Check | Status |
|-------|--------|
| Svelte Check | ${SVELTE_ERRORS:-0} errors, ${SVELTE_WARNINGS:-0} warnings |
| TypeScript | $TS_ERRORS errors |

EOF

  # Add error details if there are any
  if [ -n "$ERROR_LINES" ]; then
    COMMENT_BODY+="### Errors Found
\`\`\`
$ERROR_LINES
\`\`\`
"
  fi

  # Add link to workflow if running in GitHub Actions
  if [ -n "$GITHUB_RUN_ID" ]; then
    COMMENT_BODY+="
[View full workflow run](https://github.com/$OWNER/$REPO/actions/runs/$GITHUB_RUN_ID)
"
  fi

  # Post to GitHub
  PAYLOAD=$(jq -n --arg body "$COMMENT_BODY" '{body: $body}')
  
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "https://api.github.com/repos/$OWNER/$REPO/issues/$PR_NUMBER/comments")
  
  if echo "$RESPONSE" | jq . > /dev/null 2>&1; then
    echo "✅ Comment posted successfully!"
  else
    echo "⚠️  Failed to post comment:"
    echo "$RESPONSE"
  fi
elif [ "$POST_COMMENT" = true ]; then
  echo "⚠️  Cannot post comment: missing PR_NUMBER and/or GITHUB_TOKEN"
  echo "   Usage: $0 --post-comment --pr-number <num> --token <token>"
fi

exit $EXIT_CODE

#!/bin/sh
# Required MR trace note: SHA, git log, diff stat. Version context lives on the MR.
set -eu

apk add --no-cache git curl jq >/dev/null

TARGET_NAME="${CI_MERGE_REQUEST_TARGET_BRANCH_NAME}"
BASE="${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}"

if [ -n "${BASE}" ] && git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  RANGE="${BASE}..HEAD"
  STAT_RANGE="${BASE}...HEAD"
else
  git fetch origin "${TARGET_NAME}" --depth=200 || git fetch origin "${TARGET_NAME}" || true
  RANGE="origin/${TARGET_NAME}..HEAD"
  STAT_RANGE="origin/${TARGET_NAME}...HEAD"
fi

LOG=$(git log --oneline ${RANGE} | head -n 30)
STAT=$(git diff --stat ${STAT_RANGE} | tail -n 40)

echo "${CI_MERGE_REQUEST_TITLE}" | grep -Eq '^KAN-[0-9]+' || {
  echo "MR title must start with KAN-n"
  exit 1
}

NOTE=$(printf '%s\n' \
  '## Trace log (required CI note)' \
  '' \
  "- Jira/MR title: \`${CI_MERGE_REQUEST_TITLE}\`" \
  "- Source: \`${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME}\` → target: \`${CI_MERGE_REQUEST_TARGET_BRANCH_NAME}\`" \
  "- SHA: \`${CI_COMMIT_SHORT_SHA}\` (\`${CI_COMMIT_SHA}\`)" \
  "- Pipeline: ${CI_PIPELINE_URL}" \
  '' \
  "### git log" \
  '```' \
  "${LOG}" \
  '```' \
  '' \
  '### git diff --stat' \
  '```' \
  "${STAT}" \
  '```' \
  '' \
  "CLI: \`git log --oneline --grep=KAN-\` then \`git show --stat ${CI_COMMIT_SHORT_SHA}\`" \
  '' \
  'Do not add a docs/*.md file for this ticket. Stable maps stay in docs/; this MR is the version log.')

BODY=$(jq -n --arg body "${NOTE}" '{body: $body}')

echo "${NOTE}"

if [ -n "${GITLAB_TOKEN:-}" ]; then
  AUTH_HEADER="PRIVATE-TOKEN: ${GITLAB_TOKEN}"
else
  AUTH_HEADER="JOB-TOKEN: ${CI_JOB_TOKEN}"
fi

curl --fail --silent --show-error \
  --header "${AUTH_HEADER}" \
  --header "Content-Type: application/json" \
  --data "${BODY}" \
  "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests/${CI_MERGE_REQUEST_IID}/notes" \
  || {
    echo "Failed to post MR note. Add CI/CD variable GITLAB_TOKEN (api) if Job-Token is denied."
    exit 1
  }

#!/bin/sh
# Required MR trace: SHA, git log, diff stat. Posted to the MR when the token allows it.
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

git fetch origin refs/notes/commits:refs/notes/commits 2>/dev/null || true

LOG=$(git log --oneline ${RANGE} | head -n 30)
STAT=$(git diff --stat ${STAT_RANGE} | tail -n 40)
NOTES=$(git log --show-notes --format='%h %s%n%N' ${RANGE} | head -n 80)

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
  '### git notes' \
  '```' \
  "${NOTES}" \
  '```' \
  '' \
  "CLI: \`git log --oneline --show-notes --grep=KAN-\` then \`git show --stat ${CI_COMMIT_SHORT_SHA}\`" \
  '' \
  'Context as Code: types/JSDoc = what. This MR + git notes + git log = why. No docs/KAN-n.md.')

printf '%s\n' "${NOTE}" | tee mr-trace.md

BODY=$(jq -n --arg body "${NOTE}" '{body: $body}')
API_URL="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/merge_requests/${CI_MERGE_REQUEST_IID}/notes"
HTTP_CODE=""
RESP=""

post_note() {
  header="$1"
  RESP=$(curl -sS -o /tmp/note-resp.json -w '%{http_code}' \
    --header "${header}" \
    --header "Content-Type: application/json" \
    --data "${BODY}" \
    "${API_URL}") || RESP="000"
  HTTP_CODE="${RESP}"
  cat /tmp/note-resp.json 2>/dev/null || true
}

if [ -n "${GITLAB_TOKEN:-}" ]; then
  post_note "PRIVATE-TOKEN: ${GITLAB_TOKEN}"
else
  post_note "JOB-TOKEN: ${CI_JOB_TOKEN}"
fi

if [ "${HTTP_CODE}" = "201" ]; then
  echo "Posted MR note (${HTTP_CODE})."
  exit 0
fi

echo "Could not post MR note (HTTP ${HTTP_CODE}). Trace is in this job log and artifact mr-trace.md."
echo "Optional: set CI/CD variable GITLAB_TOKEN (scope api) so the same text is copied onto the MR Notes tab."
# Job-Token is often denied for POST /notes. Blocking merge on that 403 is not an Angular or API defect.
exit 0

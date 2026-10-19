import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const appId = process.env.RELEASE_APP_ID;
const privateKey = process.env.RELEASE_APP_PRIVATE_KEY;
const repository = process.env.GITHUB_REPOSITORY;
const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
if (!/^\d+$/.test(appId || '') || !privateKey || !repository || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
  throw new Error('Configure RELEASE_APP_ID and RELEASE_APP_PRIVATE_KEY for a GitHub App installed only on this repository with Contents and Pull requests write. GITHUB_TOKEN is deliberately not used to author PRs because it suppresses PR workflows.');
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
console.log(`::add-mask::${jwt}`);

async function request(path, token, body) {
  const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub App authentication failed: HTTP ${response.status}`);
  return response.json();
}

const installation = await request(`/repos/${repository}/installation`, jwt);
const result = await request(`/app/installations/${installation.id}/access_tokens`, jwt, {
  repository_ids: [repositoryId],
  permissions: { contents: 'write', pull_requests: 'write' },
});
console.log(`::add-mask::${result.token}`);
appendFileSync(process.env.GITHUB_OUTPUT, `token=${result.token}\n`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs, catalog, runCli, executeFile, evaluatePolicy, summarizeLogs } from './velura-ops.mjs';

const uid = '11111111-2222-3333-4444-555555555555';
const sha = 'a'.repeat(40);
const imageDigest = 'b'.repeat(64);
const now = Date.parse('2026-10-08T12:00:00Z');
const nodeVersion = '22.14.0';
const clusterFlags = ['--context', 'staging', '--expected-cluster', uid];
const ready = { conditions: [{ type: 'Ready', status: 'True' }] };
const source = { kind: 'GitRepository', metadata: { name: 'velura-repo', namespace: 'flux-system' }, spec: { ref: { commit: sha } }, status: { ...ready, artifact: { revision: `main@sha1:${sha}` } } };
const workload = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'velura-api', namespace: 'velura', generation: 2 }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'api', image: `registry.test/api@sha256:${imageDigest}`, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } } }] } } }, status: { observedGeneration: 2, readyReplicas: 1 } };
const pod = { metadata: { name: 'api-pod', namespace: 'velura' }, status: { ...ready, phase: 'Running', containerStatuses: [{ name: 'api', ready: true, restartCount: 0, imageID: `registry.test/api@sha256:${imageDigest}` }] } };
function fixture(overrides = {}) {
  const calls = [];
  const execute = async (binary, args, options) => {
    calls.push({ binary, args, options });
    const text = args.join(' ');
    if (overrides.execute) return overrides.execute(binary, args, options);
    if (text.includes('get namespace kube-system')) return JSON.stringify({ metadata: { uid: overrides.uid ?? uid } });
    if (text.includes('get deployments,statefulsets,daemonsets')) return JSON.stringify({ items: overrides.workloads ?? [workload] });
    if (text.includes('get pods')) return JSON.stringify({ items: overrides.pods ?? [pod] });
    if (text.includes('get jobs,cronjobs')) return JSON.stringify({ items: overrides.batch ?? [] });
    if (text.includes('get services')) return JSON.stringify({ items: [] });
    if (text.includes('get networkpolicies')) return JSON.stringify({ items: overrides.policies ?? [{ metadata: { name: 'default-deny', namespace: 'velura' }, spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } }] });
    if (text.includes('get gitrepositories.source.toolkit.fluxcd.io velura-repo')) return JSON.stringify(overrides.source ?? source);
    if (text.includes('get gitrepositories.source.toolkit.fluxcd.io')) return JSON.stringify({ items: overrides.flux ?? [source] });
    if (text.includes('get kustomizations.kustomize.toolkit.fluxcd.io velura-staging')) return JSON.stringify(overrides.target ?? { spec: { sourceRef: { kind: 'GitRepository', name: 'velura-repo' }, path: './deploy/k8s/overlays/staging' } });
    if (text.includes('get kustomizations.kustomize.toolkit.fluxcd.io velura-infra')) return JSON.stringify(overrides.target ?? { spec: { sourceRef: { kind: 'GitRepository', name: 'velura-repo' }, path: './deploy/k8s/overlays/production' } });
    if (text.includes('get kustomizations.kustomize.toolkit.fluxcd.io')) return JSON.stringify({ items: overrides.kustomizations ?? [{ kind: 'Kustomization', metadata: { name: 'velura-infra' }, status: { ...ready, lastAppliedRevision: `main@sha1:${sha}` } }] });
    if (text.includes('annotate ')) return 'annotated';
    if (text.includes('logs deployment/')) return '2026-10-08T11:59:00Z ERROR token=synthetic-sensitive-value prompt=private image=data:image/png;base64,abc';
    if (binary === 'git' && args[0] === 'rev-list') return `${sha} ${'c'.repeat(40)}\n`;
    if (binary === 'git' && args[0] === 'status') return overrides.dirty ? ' M changed-file\n' : '';
    if (binary === 'git' && args[0] === 'revert') return '';
    throw new Error('Unexpected fixture invocation');
  };
  return { calls, dependencies: { execute, env: {}, now, nodeVersion } };
}
async function withFiles(records, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'velura-ops-'));
  const paths = {};
  try {
    for (const [key, value] of Object.entries(records)) {
      paths[key] = join(dir, `${key}.json`);
      await writeFile(paths[key], JSON.stringify(value));
    }
    return await fn(paths, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function approval(command, extra = {}) {
  return { version: 1, approvedBy: 'owner@example.test', environment: 'staging', clusterUid: uid, command, revision: sha, expiresAt: '2026-10-08T13:00:00Z', ...extra };
}

test('help and schema expose every command, prerequisites, constraints and stable exit codes without execution', async () => {
  for (const args of [[], ['--help'], ['schema'], ['--schema']]) {
    const result = await runCli(args, { execute: () => assert.fail('help must not execute') });
    assert.equal(result.exitCode, 0);
    assert.equal(result.result.ok, true);
    for (const command of ['doctor', 'inventory', 'render', 'validate', 'status', 'health', 'logs', 'reconcile', 'backup-check', 'acceptance', 'rollback-plan']) {
      assert.ok(result.result.data.commands[command].prerequisites.length);
    }
  }
  assert.deepEqual(catalog().exitCodes, { ok: 0, checksFailed: 1, usage: 2, dependency: 3, identity: 4, approval: 5, execution: 6 });
});

test('parser uses configured alias but never a default local context', () => {
  assert.equal(parseArgs(['status'], {}).ssh, 'ai1-k3s');
  assert.equal(parseArgs(['status'], { VELURA_OPS_SSH_ALIAS: 'staging-k3s' }).ssh, 'staging-k3s');
  assert.equal(parseArgs(['status', '--context', 'staging']).ssh, undefined);
  assert.throws(() => parseArgs(['status', '--context', 'staging', '--ssh', 'ai1-k3s']));
});

test('injection, arbitrary targets, namespaces, services, revisions and hidden mutations are rejected before subprocess', async () => {
  const invalid = [
    ['status', '--ssh', 'ai1-k3s;shutdown'], ['status', '--ssh', 'user@192.0.2.1'],
    ['status', '--context', 'staging$(touch pwn)'], ['status', '--namespace', 'secrets'],
    ['logs', '--service', 'velura-api;whoami'], ['logs', '--service', 'unapproved'],
    ['status', '--execute'], ['status', '--namespace', 'velura', '--namespace', 'ai'],
    ['reconcile', '--revision', `${sha};reboot`], ['rollback-plan', '--mainline', '2'],
    ['upgrade'], ['apply'], ['reboot'], ['rotate'], ['logs', '--tail', '201'],
    ['status', '--timeout', '60001'], ['render', '--path', '-malicious'],
    ['status', '--command', 'cat /etc/shadow'], ['status', '--context=staging'],
  ];
  for (const args of invalid) {
    const outcome = await runCli(args, { execute: () => assert.fail('invalid input must not execute') });
    assert.equal(outcome.exitCode, 2, JSON.stringify(args));
    assert.equal(outcome.result.ok, false);
  }
});

test('cluster reads require explicit expected identity and stop immediately on wrong cluster', async () => {
  const missing = fixture();
  const result = await runCli(['status', '--context', 'staging'], missing.dependencies);
  assert.equal(result.exitCode, 4);
  assert.equal(missing.calls.length, 0);
  const wrong = fixture({ uid: 'wrong-cluster-uid' });
  const rejected = await runCli(['status', ...clusterFlags], wrong.dependencies);
  assert.equal(rejected.exitCode, 4);
  assert.equal(wrong.calls.length, 1);
  assert.deepEqual(wrong.calls[0].args.slice(0, 2), ['--context', 'staging']);
  assert.equal(rejected.result.executed, false);
});

test('SSH transport is noninteractive, verifies host key and uses sudo -n k3s kubectl', async () => {
  const calls = [];
  const result = await runCli(['status', '--expected-cluster', uid], { nodeVersion, env: {}, execute: async (binary, args) => {
    calls.push({ binary, args });
    return JSON.stringify({ metadata: { uid: 'wrong-cluster' } });
  } });
  assert.equal(result.exitCode, 4);
  assert.equal(calls[0].binary, 'ssh');
  assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
  assert.ok(calls[0].args.includes('ai1-k3s'));
  assert.match(calls[0].args.at(-1), /'sudo' '-n' 'k3s' 'kubectl'/);
});

test('status reports current replicas, Flux revision and digests without env/config/credential output', async () => {
  const sensitiveWorkload = structuredClone(workload);
  sensitiveWorkload.spec.template.spec.containers[0].env = [{ name: 'API_TOKEN', value: 'synthetic-sensitive-value' }];
  const f = fixture({ workloads: [sensitiveWorkload] });
  const result = await runCli(['status', ...clusterFlags], f.dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.data.workloads[0].healthy, true);
  assert.equal(result.result.data.pods[0].containers[0].digest, `sha256:${imageDigest}`);
  assert.equal(result.result.data.flux[0].revision, `main@sha1:${sha}`);
  assert.doesNotMatch(JSON.stringify(result.result), /synthetic-sensitive-value|API_TOKEN|registry\.test/);
  assert.ok(f.calls.every(call => !call.args.some(arg => /^(apply|patch|annotate|delete|revert)$/.test(arg))));
});

test('zero workloads, stale generations and missing Flux never report healthy', async () => {
  for (const overrides of [{ workloads: [], pods: [] }, { workloads: [{ ...workload, status: { observedGeneration: 1, readyReplicas: 1 } }] }, { flux: [], kustomizations: [] }]) {
    const f = fixture(overrides);
    const result = await runCli(['status', ...clusterFlags], f.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.ok, false);
  }
});

test('logs suppress all messages, including unknown secrets, prompts, images and environment text', async () => {
  const raw = '2026-10-08T11:59:00Z INFO ordinary text\n2026-10-08T11:59:01Z ERROR prompt=private Authorization: Bearer unknown-value image=data:image/jpeg;base64,long\npassword=x env={SECRET:y}';
  const summary = summarizeLogs(raw);
  assert.equal(summary.entries.length, 3);
  assert.ok(summary.entries.every(entry => entry.message === '[redacted]'));
  assert.doesNotMatch(JSON.stringify(summary), /ordinary|private|unknown-value|base64|password|SECRET/);
  const f = fixture();
  const result = await runCli(['logs', ...clusterFlags, '--service', 'velura-api'], f.dependencies);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(result.result), /synthetic-sensitive-value|prompt=|data:image/);
  assert.ok(f.calls.at(-1).args.includes('--limit-bytes=32768'));
});

test('strict manifest policy catches mutable init images, literal credentials and forged SOPS metadata', () => {
  const bad = structuredClone(workload);
  bad.spec.template.spec.initContainers = [{ name: 'init', image: 'registry.test/init:latest' }];
  bad.spec.template.spec.containers[0].env = [{ name: 'DATABASE_URL', value: 'synthetic-sensitive-value' }];
  const findings = evaluatePolicy([bad, { kind: 'Secret', metadata: { name: 'bad-secret' }, sops: {}, data: { password: 'cGxhaW4=' } }, { kind: 'ConfigMap', metadata: { name: 'bad-config' }, data: { API_TOKEN: 'synthetic-sensitive-value' } }]);
  assert.ok(findings.length >= 4);
  assert.ok(findings.every(item => item.status === 'fail'));
  assert.doesNotMatch(JSON.stringify(findings), /synthetic-sensitive-value|cGxhaW4=/);
  assert.equal(evaluatePolicy([workload])[0].status, 'pass');
});

test('manifest validation never exposes rendered credentials or image locations', async () => {
  await withFiles({}, async (_paths, dir) => {
    await writeFile(join(dir, 'deployment.yaml'), 'apiVersion: apps/v1\nkind: Deployment\n');
    const execute = async (binary) => {
      if (binary === 'kustomize') return 'sensitive YAML body';
      if (binary === 'yq') return `${JSON.stringify(workload)}\n${JSON.stringify({ kind: 'Secret', apiVersion: 'v1', metadata: { name: 'hidden' }, data: { password: 'sensitive' } })}\n`;
      if (binary === 'yamllint' || binary === 'kubeconform') return '';
      assert.fail(`Unexpected binary ${binary}`);
    };
    const render = await runCli(['render', '--path', dir], { execute, nodeVersion, env: {} });
    assert.equal(render.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(render.result), /sensitive YAML body|"password"|registry\.test/);
    const result = await runCli(['validate', '--path', dir], { execute, nodeVersion, env: {} });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result.result), /sensitive YAML body|"password"|registry\.test/);
  });
});

test('missing binary returns dependency exit with JSON blocker, never silently succeeds', async () => {
  const result = await runCli(['render'], { nodeVersion, env: {}, execute: () => executeFile('velura-ops-intentionally-absent-binary', []) });
  assert.equal(result.exitCode, 3);
  assert.equal(result.result.ok, false);
  assert.match(result.result.error.message, /Required binary unavailable/);
});

test('subprocess nonzero stderr is withheld, timeouts/output limits are bounded', async () => {
  await assert.rejects(executeFile(process.execPath, ['-e', 'process.stderr.write("synthetic-sensitive-value");process.exit(7)']), error => error.code === 6 && !error.message.includes('synthetic-sensitive-value'));
  await assert.rejects(executeFile(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 20 }), /timed out/);
  await assert.rejects(executeFile(process.execPath, ['-e', 'process.stdout.write("x".repeat(1100000))']), /safe limit/);
});

test('reconcile defaults to readonly, requires pinned revision and mutation owner gate', async () => {
  const base = ['reconcile', ...clusterFlags, '--environment', 'staging', '--revision', sha];
  const f = fixture();
  const plan = await runCli(base, f.dependencies);
  assert.equal(plan.exitCode, 0);
  assert.equal(plan.result.executed, false);
  assert.ok(!f.calls.some(call => call.args.includes('annotate')));
  const rejected = await runCli([...base, '--execute'], fixture().dependencies);
  assert.equal(rejected.exitCode, 5);
  const wrongRevision = fixture({ source: { ...source, spec: { ref: { branch: 'main' } } } });
  const wrong = await runCli(base, wrongRevision.dependencies);
  assert.equal(wrong.exitCode, 1);
  assert.ok(!wrongRevision.calls.some(call => call.args.includes('annotate')));
  await withFiles({ approval: approval('reconcile') }, async paths => {
    const approved = fixture();
    const executed = await runCli([...base, '--execute', '--approval', paths.approval], approved.dependencies);
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.result.executed, true);
    assert.equal(approved.calls.filter(call => call.args.includes('annotate')).length, 1);
    assert.ok(approved.calls.every(call => !call.args.includes('apply')));
    assert.ok(approved.calls.filter(call => call.args.includes('annotate')).every(call => call.args.includes('velura-staging') && !call.args.includes('velura-infra')));
  });
});

test('expired/mismatched approval is denied before any cluster mutation', async () => {
  for (const record of [approval('reconcile', { expiresAt: '2026-10-07T12:00:00Z' }), approval('reconcile', { environment: 'production' }), approval('rollback-plan'), approval('reconcile', { clusterUid: 'wrong-cluster' })]) {
    await withFiles({ approval: record }, async paths => {
      const f = fixture();
      const result = await runCli(['reconcile', ...clusterFlags, '--environment', 'staging', '--revision', sha, '--execute', '--approval', paths.approval], f.dependencies);
      assert.equal(result.exitCode, 5);
      assert.equal(f.calls.length, 0);
    });
  }
});

test('rollback prepares Git revert only and refuses dirty trees; conflicts report attempted mutation', async () => {
  const base = ['rollback-plan', ...clusterFlags, '--environment', 'staging', '--revision', sha];
  const planFixture = fixture();
  const plan = await runCli(base, planFixture.dependencies);
  assert.equal(plan.exitCode, 0);
  assert.equal(plan.result.executed, false);
  assert.deepEqual(plan.result.data.plan.command, ['git', 'revert', '--no-commit', sha]);
  assert.ok(!planFixture.calls.some(call => call.args.includes('revert')));
  const dirty = await runCli(base, fixture({ dirty: true }).dependencies);
  assert.equal(dirty.exitCode, 1);
  await withFiles({ approval: approval('rollback-plan') }, async paths => {
    const f = fixture();
    const execute = async (...args) => {
      if (args[0] === 'git' && args[1][0] === 'revert') throw new Error('sensitive conflict details');
      return f.dependencies.execute(...args);
    };
    const result = await runCli([...base, '--execute', '--approval', paths.approval], { ...f.dependencies, execute });
    assert.equal(result.exitCode, 6);
    assert.equal(result.result.mutationAttempted, true);
    assert.doesNotMatch(JSON.stringify(result.result), /sensitive conflict details/);
  });
});

test('acceptance enumerates all exact baseline AC IDs as unknown without runtime or externally verified scenarios', async () => {
  const result = await runCli(['acceptance'], { nodeVersion, execute: () => assert.fail('no cluster identity means no remote commands') });
  assert.equal(result.exitCode, 1);
  assert.ok(result.result.data.requirements.length >= 60);
  for (const id of ['host-supported', 'secret-encryption', 'AC-DASH-05', 'AC-VTO-05', 'AC-IMG-04', 'AC-SEARCH-05', 'AC-LOYAL-03', 'AC-REF-03', 'AC-COLOR-05', 'AC-CHAT-05', 'AC-SEO-04']) assert.ok(result.result.data.requirements.some(item => item.id === id && item.status === 'unknown'));
});

test('acceptance wrong cluster still enumerates every requirement, never collects subsequent runtime evidence', async () => {
  const f = fixture({ uid: 'wrong-cluster-uid' });
  const result = await runCli(['acceptance', ...clusterFlags], f.dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(result.result.data.requirements.length >= 60);
  assert.ok(result.result.data.requirements.every(item => item.status === 'unknown'));
});

test('manual/signed pass claims do not become automatic runtime pass; stale/missing evidence remains unknown', async () => {
  await withFiles({ requirements: { version: 1, requirements: [{ id: 'manual', description: 'Must be exercised' }, { id: 'stale', description: 'Must be fresh' }, { id: 'absent', description: 'Must exist' }] }, evidence: { version: 1, clusterUid: uid, evidence: [{ id: 'manual', status: 'pass', verifier: 'operator', source: 'https://audit.example.test/record', type: 'signed', observedAt: '2026-10-08T11:00:00Z', expiresAt: '2026-10-09T11:00:00Z' }, { id: 'stale', status: 'pass', verifier: 'operator', source: 'https://audit.example.test/record', type: 'manual', observedAt: '2026-01-01T11:00:00Z', expiresAt: '2026-10-09T11:00:00Z' }] } }, async paths => {
    const f = fixture();
    const result = await runCli(['acceptance', ...clusterFlags, '--requirements', paths.requirements, '--evidence', paths.evidence], f.dependencies);
    assert.ok(result.result.data.requirements.every(item => item.status === 'unknown'));
    assert.equal(result.result.data.requirements[0].evidence.independentlyVerified, false);
    assert.equal(result.result.data.requirements[1].evidence, undefined);
  });
});

test('backup-check rejects local VM copies before contacting provider', async () => {
  const result = await runCli(['backup-check', '--backup-provider', 'restic', '--environment', 'staging', '--expected-cluster', uid, '--evidence', 'unused.json'], { nodeVersion, env: { RESTIC_REPOSITORY: '/var/backups' }, execute: () => assert.fail('local backups cannot count as external DR') });
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.ok, false);
});

test('backup-check queries declared provider snapshot and keeps restore attestation separate from runtime proof', async () => {
  const repository = 's3:https://external-provider.example.test/bucket';
  const snapshotId = 'd'.repeat(64);
  const record = { version: 1, provider: 'restic', environment: 'staging', clusterUid: uid, repositorySha256: createHash('sha256').update(repository).digest('hex'), snapshotId, restoredSnapshotId: snapshotId, backupAt: '2026-10-08T11:00:00Z', restoreVerifiedAt: '2026-10-08T11:30:00Z', restoreDurationSeconds: 120, rpoSeconds: 86400, rtoSeconds: 3600, restoreMaxAgeSeconds: 2592000, storageLocation: 'external', verifiedBy: 'operator', verificationType: 'manual', source: 'https://audit.example.test/restore' };
  await withFiles({ evidence: record }, async paths => {
    const calls = [];
    const result = await runCli(['backup-check', '--backup-provider', 'restic', '--environment', 'staging', '--expected-cluster', uid, '--evidence', paths.evidence], { nodeVersion, now, env: { RESTIC_REPOSITORY: repository, RESTIC_PASSWORD: 'synthetic-sensitive-value' }, execute: async (binary, args) => { calls.push({ binary, args }); return JSON.stringify([{ id: snapshotId, time: record.backupAt, tags: [`velura-cluster:${uid}`, 'environment:staging'] }]); } });
    assert.equal(calls[0].binary, 'restic');
    assert.deepEqual(calls[0].args, ['snapshots', '--json', '--no-lock']);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.data.backup.meetsRpo, true);
    assert.equal(result.result.data.backup.runtimeRestoreVerified, false);
    assert.equal(result.result.checks.find(item => item.id === 'restore-evidence').status, 'unknown');
    assert.doesNotMatch(JSON.stringify(result.result), /synthetic-sensitive-value|external-provider/);
  });
});

test('actual CLI process emits one JSON document and stable OS exit codes for help/invalid input', async () => {
  const script = fileURLToPath(new URL('./velura-ops.mjs', import.meta.url));
  for (const [args, expected] of [[['--help'], 0], [['not-a-command'], 2]]) {
    const outcome = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [script, ...args], { shell: false, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolvePromise({ stdout, stderr, code }));
    });
    assert.equal(outcome.code, expected);
    assert.equal(outcome.stderr, '');
    assert.equal(outcome.stdout.trim().split('\n').length, 1);
    const parsed = JSON.parse(outcome.stdout);
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(Array.isArray(parsed.blockers));
    assert.equal(parsed.ok, expected === 0);
  }
});

test('staging status isolates suspended production Flux and recognizes empty matchLabels default deny', async () => {
  const stagedWorkload = structuredClone(workload);
  stagedWorkload.metadata.namespace = 'velura-staging';
  const stagedPod = structuredClone(pod);
  stagedPod.metadata.namespace = 'velura-staging';
  const f = fixture({
    workloads: [stagedWorkload], pods: [stagedPod],
    policies: [{ metadata: { namespace: 'velura-staging', name: 'default-deny' }, spec: { podSelector: { matchLabels: {} }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } }],
    kustomizations: [
      { kind: 'Kustomization', metadata: { name: 'velura-infra' }, spec: { suspend: true }, status: ready },
      { kind: 'Kustomization', metadata: { name: 'velura-staging' }, status: ready },
    ],
  });
  const result = await runCli(['health', ...clusterFlags, '--namespace', 'velura-staging'], f.dependencies);
  assert.equal(result.result.checks.find(check => check.id === 'flux-ready').status, 'pass');
  assert.equal(result.result.checks.find(check => check.id === 'defaultdeny').status, 'pass');
  assert.equal(result.result.checks.find(check => check.id === 'application-smoke').status, 'unknown');
  assert.equal(result.result.ok, false);
});

test('environment/path mismatch and unsupported mutation environments never annotate Flux', async () => {
  const f = fixture({ target: { spec: { sourceRef: { kind: 'GitRepository', name: 'velura-repo' }, path: './deploy/k8s/overlays/production' } } });
  const result = await runCli(['reconcile', ...clusterFlags, '--environment', 'staging', '--revision', sha], f.dependencies);
  assert.equal(result.exitCode, 1);
  assert.ok(!f.calls.some(call => call.args.includes('annotate')));
  const invalid = await runCli(['reconcile', ...clusterFlags, '--environment', 'other', '--revision', sha], { nodeVersion, execute: () => assert.fail('invalid environment cannot execute') });
  assert.equal(invalid.exitCode, 2);
});

test('suspended batch templates participate in limits and immutable image acceptance', async () => {
  await withFiles({ requirements: { version: 1, requirements: [
    { id: 'images', description: 'Every declared workload image', runtime: 'immutable-images' },
    { id: 'limits', description: 'Every declared workload container', runtime: 'resource-limits' },
  ] } }, async paths => {
    const f = fixture({ batch: [{ kind: 'CronJob', metadata: { namespace: 'database', name: 'backup' }, spec: { suspend: true, jobTemplate: { spec: { template: { spec: { containers: [{ image: 'registry.test/backup:mutable' }] } } } } } }] });
    const result = await runCli(['acceptance', ...clusterFlags, '--requirements', paths.requirements], f.dependencies);
    assert.equal(result.result.data.requirements.find(item => item.id === 'images').status, 'fail');
    assert.equal(result.result.data.requirements.find(item => item.id === 'limits').status, 'fail');
  });
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_REQUIREMENTS = fileURLToPath(new URL('./production-requirements.json', import.meta.url));
const PRODUCTION_NAMESPACES = ['velura', 'ai', 'database', 'storage', 'auth', 'networking', 'observability', 'flux-system'];
const NAMESPACES = [...PRODUCTION_NAMESPACES, 'velura-staging', 'ai-staging', 'kube-system'];
const SERVICES = {
  'velura-api': 'velura', 'velura-admin': 'velura', 'velura-storefront': 'velura',
  'ai-worker': 'ai-staging', 'litellm': 'observability', 'grafana': 'observability',
  'loki': 'observability', 'victoriametrics': 'observability', 'cloudflared': 'networking',
  'oauth2-proxy': 'networking', 'keycloak': 'auth', 'source-controller': 'flux-system',
  'kustomize-controller': 'flux-system',
};
const CLUSTER_OPTIONS = ['ssh', 'context', 'expected-cluster', 'timeout'];
const COMMANDS = {
  doctor: { description: 'Check Node/tool prerequisites and explicitly selected cluster identity.', options: CLUSTER_OPTIONS, prerequisites: ['Node >=22', 'ssh alias or explicit kubectl context', 'kube-system namespace UID'] },
  inventory: { description: 'Read safe OS/CPU/memory/root-disk/GPU/k3s and Kubernetes node summaries.', options: CLUSTER_OPTIONS, prerequisites: ['SSH inventory requires noninteractive alias and uname/lscpu/free/df/nvidia-smi/k3s on host'] },
  render: { description: 'Render Kustomize and return resource identities only; no YAML, Secrets or environment values.', options: ['path', 'timeout'], prerequisites: ['kustomize', 'Mike Farah yq v4'] },
  validate: { description: 'Strict YAML, Kubernetes schema and immutable-image/credential policy validation.', options: ['path', 'schema-location', 'timeout'], prerequisites: ['yamllint', 'kustomize', 'Mike Farah yq v4', 'kubeconform', 'local CRD schemas for non-core resources'] },
  status: { description: 'Read workload readiness, Flux revisions, image digests, Services and NetworkPolicies.', options: [...CLUSTER_OPTIONS, 'namespace'], prerequisites: ['Read access to pods/workloads/services/networkpolicies/Flux resources'] },
  health: { description: 'Check workload readiness, Flux readiness and default-deny presence; not application smoke proof.', options: [...CLUSTER_OPTIONS, 'namespace'], prerequisites: ['Same as status'] },
  logs: { description: 'Read bounded logs from an allowlisted deployment; return only timestamps/severity and counts, never message bodies.', options: [...CLUSTER_OPTIONS, 'service', 'tail'], prerequisites: ['Allowlisted deployment and pods/log read permission'] },
  reconcile: { description: 'Plan Flux reconciliation; execute only an approved, SHA-pinned Git source already fetched by Flux.', options: [...CLUSTER_OPTIONS, 'environment', 'revision', 'execute', 'approval'], prerequisites: ['Owner approval file for execution', 'GitRepository flux-system/velura-repo pinned spec.ref.commit', 'Kustomization flux-system/velura-staging or velura-infra matching environment', 'Matching artifact revision'], mutation: 'Only explicit --execute annotates the environment-specific Flux Kustomization; never applies YAML or unsuspends production' },
  'backup-check': { description: 'Verify external Restic snapshot identity/freshness and separately declared restore evidence.', options: ['backup-provider', 'evidence', 'environment', 'expected-cluster', 'timeout'], prerequisites: ['restic', 'RESTIC_REPOSITORY external provider and noninteractive credentials', 'Fresh external restore evidence file'] },
  acceptance: { description: 'Enumerate every requirement. External attestations remain unknown pending independent verification, never automatic pass.', options: [...CLUSTER_OPTIONS, 'namespace', 'requirements', 'evidence'], prerequisites: ['Requirement catalog; optional external evidence and explicit cluster identity for runtime checks'] },
  'rollback-plan': { description: 'Prepare Git revert in a clean working tree only; no commit/push/direct Kubernetes image mutation.', options: [...CLUSTER_OPTIONS, 'environment', 'revision', 'execute', 'approval', 'repo', 'mainline'], prerequisites: ['git', 'Full commit SHA', 'Clean worktree', 'Owner approval and matching cluster identity for execution'], mutation: 'Only explicit --execute runs git revert --no-commit; merge commits require --mainline 1' },
  schema: { description: 'Return exact catalog, option syntax, JSON file contracts and exit codes.', options: [], prerequisites: [] },
};
const STRING_OPTIONS = new Set(['ssh', 'context', 'expected-cluster', 'path', 'schema-location', 'namespace', 'service', 'environment', 'revision', 'approval', 'backup-provider', 'evidence', 'requirements', 'repo', 'mainline', 'timeout', 'tail']);
const EXIT = { ok: 0, checksFailed: 1, usage: 2, dependency: 3, identity: 4, approval: 5, execution: 6 };
class OpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function check(id, status, detail, evidence) {
  return { id, status, detail, ...(evidence === undefined ? {} : { evidence }) };
}
function ensure(condition, code, message) { if (!condition) throw new OpsError(code, message); }
function bounded(value, max = 160) { return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max); }
function safeName(value) { return /^[a-z0-9][a-z0-9.-]{0,62}$/.test(value ?? '') ? value : '[redacted]'; }
function safeRevision(value) { return /^[a-zA-Z0-9._:/@+-]{1,160}$/.test(value ?? '') ? value : '[redacted]'; }
function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new OpsError(EXIT.execution, `${label} returned invalid JSON`); }
}

/** Parse only documented options without executing commands or consulting a default Kubernetes context. */
export function parseArgs(argv, env = {}) {
  ensure(Array.isArray(argv), EXIT.usage, 'Arguments must be an array');
  if (argv.length === 0 || argv.includes('--help') || argv.includes('--schema')) return { command: 'schema', timeout: 15000 };
  const [command, ...tokens] = argv;
  ensure(Object.hasOwn(COMMANDS, command), EXIT.usage, 'Unknown command; use --help');
  const opts = { command, timeout: 15000 };
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    ensure(/^--[a-z-]+$/.test(token), EXIT.usage, 'Use --option value syntax; positional arguments and option=value are not supported');
    const key = token.slice(2);
    ensure(COMMANDS[command].options.includes(key) && !seen.has(key), EXIT.usage, 'Unknown, disallowed or duplicate option');
    seen.add(key);
    if (key === 'execute') opts[key] = true;
    else {
      ensure(STRING_OPTIONS.has(key) && i + 1 < tokens.length && !tokens[i + 1].startsWith('--'), EXIT.usage, 'Option requires a value');
      opts[key] = tokens[++i];
    }
  }
  ensure(!(seen.has('ssh') && seen.has('context')), EXIT.usage, 'Choose SSH or an explicit context, not both');
  if (COMMANDS[command].options.includes('ssh') && !opts.context) opts.ssh = opts.ssh ?? env.VELURA_OPS_SSH_ALIAS ?? 'ai1-k3s';
  if (opts.ssh) ensure(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(opts.ssh), EXIT.usage, 'SSH target must be a configured alias, not a host address or shell expression');
  if (opts.context) ensure(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(opts.context), EXIT.usage, 'Invalid context');
  if (opts['expected-cluster']) ensure(/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(opts['expected-cluster']), EXIT.usage, 'Expected cluster must be kube-system namespace UID');
  if (opts.namespace) ensure(NAMESPACES.includes(opts.namespace), EXIT.usage, 'Namespace is not allowlisted');
  if (opts.service) ensure(Object.hasOwn(SERVICES, opts.service), EXIT.usage, 'Service is not allowlisted');
  if (opts.environment) ensure(/^[a-z][a-z0-9-]{0,31}$/.test(opts.environment), EXIT.usage, 'Invalid environment');
  if (['reconcile', 'rollback-plan'].includes(command)) ensure(['staging', 'production'].includes(opts.environment), EXIT.usage, 'Mutation plans require --environment staging or production');
  if (opts.revision) ensure(/^[a-f0-9]{40}$/.test(opts.revision), EXIT.usage, 'Revision must be a full lowercase Git commit SHA');
  if (opts.mainline) ensure(opts.mainline === '1', EXIT.usage, 'Only --mainline 1 is supported');
  if (seen.has('timeout')) {
    ensure(/^\d+$/.test(opts.timeout) && +opts.timeout >= 1000 && +opts.timeout <= 60000, EXIT.usage, 'Timeout must be 1000–60000 milliseconds');
    opts.timeout = +opts.timeout;
  }
  if (opts.tail) ensure(/^\d+$/.test(opts.tail) && +opts.tail >= 1 && +opts.tail <= 200, EXIT.usage, 'Tail must be 1–200');
  for (const key of ['path', 'schema-location', 'approval', 'evidence', 'requirements', 'repo']) {
    if (opts[key]) ensure(!/[\x00-\x1f]/.test(opts[key]) && !opts[key].startsWith('-') && opts[key].length <= 1024, EXIT.usage, 'Invalid file path');
  }
  return opts;
}

/** Agent-discoverable syntax and evidence contracts; never includes credentials. */
export function catalog() {
  return {
    schemaVersion: VERSION, usage: 'node tools/ops/velura-ops.mjs <command> [--option value] [--execute]',
    commands: COMMANDS, namespaces: NAMESPACES, services: SERVICES, exitCodes: EXIT,
    defaults: { ssh: 'VELURA_OPS_SSH_ALIAS or existing ai1-k3s alias', path: 'deploy/k8s/base', timeout: 15000, tail: 50, requirements: 'tools/ops/production-requirements.json' },
    safeguards: ['Readonly by default', 'Every cluster operation requires --expected-cluster kube-system UID', 'Local kubectl always requires --context', 'No shell, prompts, insecure TLS, apply, upgrade, reboot or secret rotation', 'No Secret/config/env/message-body output', 'External evidence is not runtime proof'],
    optionConstraints: { syntax: '--option value (no positional arguments or option=value)', ssh: 'configured alias matching [A-Za-z][A-Za-z0-9_-]{0,63}', context: 'explicit named kubecontext; never current-context', 'expected-cluster': 'kube-system namespace UID required before any cluster read/write', namespace: NAMESPACES, service: Object.keys(SERVICES), environment: 'lowercase identifier, 1–32 characters', revision: '40 lowercase hexadecimal Git SHA characters', timeout: 'milliseconds, 1000–60000; total command deadline 180000', tail: 'lines, 1–200', execute: 'boolean flag; only reconcile and rollback-plan accept it', 'schema-location': 'local kubeconform schema template path, e.g. schemas/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json', mainline: '1, required for reverting merge commits' },
    files: {
      requirements: { version: 1, requirements: [{ id: 'unique-id', description: 'Exact acceptance criterion', runtime: 'optional supported verifier: flux-ready|defaultdeny|resource-limits|immutable-images' }] },
      acceptanceEvidence: { version: 1, clusterUid: 'kube-system UID', evidence: [{ id: 'requirement-id', status: 'pass|fail|unknown', source: 'https://external-audit-or-restore-record', observedAt: 'ISO timestamp', expiresAt: 'ISO timestamp', verifier: 'named human or external verifier', type: 'manual|signed', signature: 'optional signature reference; CLI does not validate authenticity' }] },
      approval: { version: 1, approvedBy: 'owner identifier', environment: 'production', clusterUid: 'kube-system UID', command: 'reconcile|rollback-plan', revision: '40-character Git SHA', expiresAt: 'ISO timestamp (within 24h)' },
      backupEvidence: { version: 1, provider: 'restic', environment: 'production', clusterUid: 'kube-system UID', repositorySha256: 'SHA256 of RESTIC_REPOSITORY (do not store plaintext repository credentials)', snapshotId: 'full snapshot id', restoredSnapshotId: 'full snapshot id', backupAt: 'ISO timestamp', restoreVerifiedAt: 'ISO timestamp', restoreDurationSeconds: 120, rpoSeconds: 86400, rtoSeconds: 3600, restoreMaxAgeSeconds: 2592000, storageLocation: 'external', source: 'https://restore-record', verifiedBy: 'restore operator', verificationType: 'manual|signed' },
    },
  };
}

/** Execute bounded argument arrays with no shell, stdin prompts, or command output attached to exceptions. */
export function executeFile(binary, args, { timeout = 15000, input, env = process.env, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    const out = [], err = [];
    let bytes = 0, settled = false;
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure); else resolvePromise(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new OpsError(EXIT.execution, 'Subprocess timed out')); }, timeout);
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { child.kill(); finish(new OpsError(EXIT.execution, 'Subprocess output exceeded safe limit')); }
      else chunks.push(chunk);
    });
    child.on('error', error => finish(new OpsError(error.code === 'ENOENT' ? EXIT.dependency : EXIT.execution, error.code === 'ENOENT' ? `Required binary unavailable: ${binary}` : 'Subprocess could not start')));
    child.on('close', code => {
      if (code !== 0) finish(new OpsError(EXIT.execution, `${binary} failed (exit ${code ?? 'signal'}); stderr withheld to protect credentials`));
      else finish(null, Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function sshArgs(alias, args) {
  // OpenSSH invokes a remote shell. Every token is single-quoted, including fixed commands;
  // user-selected alias is separately validated and never embedded in that remote command.
  const quoted = args.map(arg => `'${String(arg).replaceAll("'", "'\\''")}'`).join(' ');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias, quoted];
}
async function jsonFile(path) {
  const info = await lstat(resolve(path));
  ensure(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_BYTES, EXIT.usage, 'Evidence/catalog must be a regular JSON file under 1 MiB');
  return parseJson(await readFile(resolve(path), 'utf8'), 'Evidence/catalog');
}
function ready(object) {
  return (object.metadata?.generation === undefined || (object.status?.observedGeneration ?? 0) >= object.metadata.generation)
    && (object.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ?? false);
}
function digest(value) { return /sha256:[a-f0-9]{64}/.exec(value ?? '')?.[0] ?? null; }
function timestamp(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN; }
function fresh(value, now, maxAge) { const time = timestamp(value); return Number.isFinite(time) && time <= now && now - time <= maxAge; }
function namespaceOf(object) { return safeName(object.metadata?.namespace ?? 'default'); }

/** Return only metadata/severity for logs. Message bodies are always suppressed, not heuristically trusted. */
export function summarizeLogs(text) {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-200);
  const counts = { error: 0, warning: 0, info: 0, unknown: 0 };
  const entries = lines.map(line => {
    const at = /^\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(line)?.[0] ?? null;
    const level = /\b(error|fatal)\b/i.test(line) ? 'error' : /\bwarn(?:ing)?\b/i.test(line) ? 'warning' : /\binfo\b/i.test(line) ? 'info' : 'unknown';
    counts[level]++;
    return { timestamp: at, level, message: '[redacted]' };
  });
  return { counts, entries, messageBodiesSuppressed: true };
}

/** Evaluate rendered objects without returning Secret, ConfigMap, environment or image-reference values. */
export function evaluatePolicy(objects) {
  const findings = [];
  const credentialKey = /(password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|connection[-_]?string|database[-_]?url|dsn)/i;
  for (const object of objects) {
    const identity = `${bounded(object.kind, 60)}/${safeName(object.metadata?.name)}`;
    const fail = detail => findings.push(check(identity, 'fail', detail));
    if (object.kind === 'Secret' && (!object.sops || Object.values({ ...object.data, ...object.stringData }).some(value => typeof value !== 'string' || !/^ENC\[AES256_GCM,/.test(value)))) fail('Plaintext Kubernetes Secret; every Secret value must be SOPS encrypted');
    if (object.kind === 'ConfigMap' && Object.entries(object.data ?? {}).some(([key, value]) => credentialKey.test(key) || /(?:password|token|api_key|secret)\s*[:=]\s*[^\s$]/i.test(String(value)))) fail('Credential-like ConfigMap content must use a Secret reference');
    const podSpec = object.kind === 'Pod' ? object.spec : object.spec?.template?.spec ?? object.spec?.jobTemplate?.spec?.template?.spec;
    if (podSpec) {
      for (const container of [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? []), ...(podSpec.ephemeralContainers ?? [])]) {
        if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(container.image ?? '')) fail('Every container image must be pinned to a SHA256 digest');
        if ((container.env ?? []).some(item => credentialKey.test(item.name ?? '') && Object.hasOwn(item, 'value'))) fail('Credential-like literal environment values must use valueFrom');
        if ([...(container.command ?? []), ...(container.args ?? [])].some(value => /(?:password|token|api[-_]?key|secret)(?:\s*(?:=|:)|$)/i.test(value))) fail('Credential-like command arguments are forbidden');
      }
      if (podSpec.imagePullSecrets?.some(item => !/^[a-z0-9][a-z0-9.-]*$/.test(item.name ?? ''))) fail('Invalid imagePullSecret reference');
    }
  }
  return findings.length ? findings : [check('image-credential-policy', 'pass', 'All rendered containers use immutable digests; no plaintext credential objects/literals found')];
}
async function yamlFiles(path, depth = 0) {
  ensure(depth < 16, EXIT.usage, 'Manifest directory nesting exceeds safe limit');
  const info = await lstat(path);
  ensure(!info.isSymbolicLink(), EXIT.usage, 'Manifest symlinks are not accepted');
  if (info.isFile()) return /\.ya?ml$/i.test(path) ? [path] : [];
  ensure(info.isDirectory(), EXIT.usage, 'Manifest path must be a directory');
  const names = await readdir(path);
  const result = [];
  for (const name of names) {
    if (name === '.git' || name === 'node_modules' || name.startsWith('.')) continue;
    result.push(...await yamlFiles(join(path, name), depth + 1));
    ensure(result.length <= 500, EXIT.usage, 'Manifest input exceeds 500 YAML files');
  }
  return result;
}

/** Run one operational command and return a bounded JSON envelope; injectable executors are used only by behavior tests. */
export async function runCli(argv, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const run = dependencies.execute ?? executeFile;
  const now = dependencies.now ?? Date.now();
  const checks = [];
  const data = {};
  let opts;
  const started = Date.now();
  const call = (binary, args, extras = {}) => {
    const remaining = 180000 - (Date.now() - started);
    ensure(remaining > 0, EXIT.execution, 'Operation exceeded three-minute deadline');
    return run(binary, args, { timeout: Math.min(opts.timeout, remaining), env, ...extras });
  };
  const kube = args => opts.context
    ? call('kubectl', ['--context', opts.context, `--request-timeout=${Math.ceil(opts.timeout / 1000)}s`, ...args])
    : call('ssh', sshArgs(opts.ssh, ['sudo', '-n', 'k3s', 'kubectl', `--request-timeout=${Math.ceil(opts.timeout / 1000)}s`, ...args]));
  const identity = async () => {
    ensure(opts['expected-cluster'], EXIT.identity, 'Required --expected-cluster kube-system namespace UID; refusing default/wrong cluster');
    const object = parseJson(await kube(['get', 'namespace', 'kube-system', '-o', 'json']), 'Cluster identity');
    ensure(object.metadata?.uid === opts['expected-cluster'], EXIT.identity, 'Cluster identity mismatch; no subsequent cluster operation executed');
    checks.push(check('cluster-identity', 'pass', 'kube-system namespace UID matches explicit expected identity'));
    data.clusterUid = opts['expected-cluster'];
  };
  const get = async (resource, namespace) => {
    const object = parseJson(await kube(['get', resource, ...(namespace ? ['-n', namespace] : ['-A']), '-o', 'json']), resource);
    ensure(Array.isArray(object.items), EXIT.execution, 'Kubernetes list response missing items');
    return object.items;
  };
  const fluxObjects = async () => [...await get('gitrepositories.source.toolkit.fluxcd.io', 'flux-system'), ...await get('kustomizations.kustomize.toolkit.fluxcd.io', 'flux-system')];
  const status = async (allProduction = false) => {
    const namespace = allProduction ? undefined : opts.namespace ?? 'velura';
    const scope = allProduction ? PRODUCTION_NAMESPACES.join(',') : namespace;
    const scoped = items => allProduction ? items.filter(item => PRODUCTION_NAMESPACES.includes(item.metadata?.namespace)) : items;
    const workloads = scoped(await get('deployments,statefulsets,daemonsets', namespace));
    const pods = scoped(await get('pods', namespace));
    const batch = scoped(await get('jobs,cronjobs', namespace));
    const services = scoped(await get('services', namespace));
    const policies = scoped(await get('networkpolicies', namespace));
    const targetName = !allProduction && ['velura-staging', 'ai-staging'].includes(namespace) ? 'velura-staging' : 'velura-infra';
    const flux = (await fluxObjects()).filter(item => item.kind === 'GitRepository' && item.metadata?.name === 'velura-repo' || item.kind === 'Kustomization' && item.metadata?.name === targetName);
    data.workloads = workloads.map(item => {
      const desired = item.kind === 'DaemonSet' ? item.status?.desiredNumberScheduled ?? 0 : item.spec?.replicas ?? 1;
      const available = item.kind === 'DaemonSet' ? item.status?.numberReady ?? 0 : item.status?.readyReplicas ?? 0;
      const generationObserved = (item.status?.observedGeneration ?? 0) >= (item.metadata?.generation ?? 1);
      return { kind: bounded(item.kind, 40), name: safeName(item.metadata?.name), namespace: namespaceOf(item), desired, ready: available, healthy: desired > 0 && available === desired && generationObserved };
    });
    data.pods = pods.map(item => ({ name: safeName(item.metadata?.name), namespace: namespaceOf(item), phase: bounded(item.status?.phase, 30), ready: ready(item), containers: (item.status?.containerStatuses ?? []).map(c => ({ name: safeName(c.name), ready: c.ready === true, restarts: c.restartCount ?? 0, digest: digest(c.imageID) })) }));
    data.batch = batch.map(item => ({ kind: bounded(item.kind, 40), name: safeName(item.metadata?.name), namespace: namespaceOf(item), suspended: item.spec?.suspend === true, active: item.status?.active?.length ?? item.status?.active ?? 0, succeeded: item.status?.succeeded ?? 0, failed: item.status?.failed ?? 0 }));
    data.flux = flux.map(item => ({ kind: bounded(item.kind, 40), name: safeName(item.metadata?.name), ready: ready(item), revision: safeRevision(item.status?.lastAppliedRevision ?? item.status?.artifact?.revision), suspended: item.spec?.suspend === true }));
    data.services = services.map(item => ({ name: safeName(item.metadata?.name), type: bounded(item.spec?.type, 30) }));
    data.networkPolicies = policies.map(item => ({ name: safeName(item.metadata?.name), namespace: namespaceOf(item), types: item.spec?.policyTypes ?? [] }));
    const podSpecs = [...workloads, ...batch].map(item => item.spec?.template?.spec ?? item.spec?.jobTemplate?.spec?.template?.spec);
    podSpecs.push(...pods.map(item => item.spec).filter(Boolean));
    const containers = podSpecs.flatMap(spec => [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])]);
    const requiredDefaultDeny = (allProduction ? PRODUCTION_NAMESPACES : [namespace]).every(ns => ['Ingress', 'Egress'].every(type => policies.some(p => {
      const selector = p.spec?.podSelector;
      const allPods = selector && Object.keys(selector).every(key => ['matchLabels', 'matchExpressions'].includes(key))
        && Object.keys(selector.matchLabels ?? {}).length === 0 && (selector.matchExpressions ?? []).length === 0;
      return p.metadata?.namespace === ns && allPods && p.spec?.policyTypes?.includes(type) && (p.spec?.[type.toLowerCase()] ?? []).length === 0;
    })));
    const proof = {
      'flux-ready': check('flux-ready', flux.some(item => item.kind === 'GitRepository') && flux.some(item => item.kind === 'Kustomization') && flux.every(item => ready(item) && item.spec?.suspend !== true) ? 'pass' : 'fail', 'Flux sources and kustomizations must exist, be Ready and not suspended'),
      defaultdeny: check('defaultdeny', requiredDefaultDeny ? 'pass' : 'fail', `Namespaces ${scope} need all-pod empty-rule ingress and egress policies`),
      'resource-limits': check('resource-limits', containers.length && containers.every(c => c.resources?.requests?.cpu && c.resources?.requests?.memory && c.resources?.limits?.cpu && c.resources?.limits?.memory) ? 'pass' : 'fail', `All ${scope} workload containers require CPU/memory requests and limits`),
      'immutable-images': check('immutable-images', containers.length && containers.every(c => /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(c.image ?? '')) ? 'pass' : 'fail', `All ${scope} workload container images must be digest-pinned`),
    };
    const servingPods = pods.filter(item => !item.metadata?.ownerReferences?.some(owner => owner.kind === 'Job'));
    checks.push(check('workload-readiness', data.workloads.length && data.workloads.every(item => item.healthy) && servingPods.length && servingPods.every(item => ready(item) && item.status?.phase === 'Running') ? 'pass' : 'fail', 'Serving workload generations/replicas and pods must be Ready; batch jobs are reported separately, not application or backup proof'));
    checks.push(proof['flux-ready']);
    return proof;
  };
  const approval = async () => {
    ensure(opts.environment && opts.revision && opts['expected-cluster'], EXIT.approval, 'Mutations require --environment, --revision and --expected-cluster');
    ensure(opts.approval, EXIT.approval, 'Execution requires explicit --approval owner approval JSON file');
    const record = await jsonFile(opts.approval);
    const expires = timestamp(record.expiresAt);
    ensure(record.version === 1 && typeof record.approvedBy === 'string' && /^[A-Za-z0-9@._ -]{3,120}$/.test(record.approvedBy) && record.environment === opts.environment && record.clusterUid === opts['expected-cluster'] && record.command === opts.command && record.revision === opts.revision && expires > now && expires - now <= 86400000, EXIT.approval, 'Owner approval is missing, expired, excessive-lifetime, or does not match command/environment/cluster/revision');
    checks.push(check('owner-approval', 'pass', 'Explicit local owner approval record matches operation; authentication of that record is an operator responsibility'));
  };
  try {
    opts = parseArgs(argv, env);
    if (opts.command === 'schema') return { exitCode: 0, result: { schemaVersion: VERSION, command: 'schema', ok: true, checks: [], blockers: [], data: catalog() } };
    ensure(+(dependencies.nodeVersion ?? process.versions.node).split('.')[0] >= 22, EXIT.dependency, 'Node 22 or newer is required');
    if (opts.command === 'doctor') {
      checks.push(check('node', 'pass', 'Node 22 or newer'));
      for (const [binary, args] of [['git', ['--version']], ['kustomize', ['version']], ['yamllint', ['--version']], ['yq', ['--version']], ['kubeconform', ['-v']], ['restic', ['version']]]) {
        try { await call(binary, args); checks.push(check(binary, 'pass', 'Dependency executable available')); }
        catch (error) { checks.push(check(binary, 'fail', error instanceof OpsError ? error.message : 'Dependency unavailable')); }
      }
      await identity();
    } else if (opts.command === 'inventory') {
      await identity();
      const nodes = await get('nodes');
      data.nodes = nodes.map(item => ({ name: safeName(item.metadata?.name), ready: ready(item), os: bounded(item.status?.nodeInfo?.osImage), kernel: bounded(item.status?.nodeInfo?.kernelVersion), kubelet: bounded(item.status?.nodeInfo?.kubeletVersion), cpu: bounded(item.status?.capacity?.cpu), memory: bounded(item.status?.capacity?.memory), gpu: bounded(item.status?.capacity?.['nvidia.com/gpu'] ?? '0') }));
      if (opts.ssh) {
        const hostCommands = [['os', ['cat', '/etc/os-release']], ['kernel', ['uname', '-sr']], ['cpu', ['lscpu', '--json']], ['memory', ['free', '-b']], ['disk', ['df', '-B1', '--output=size,avail,pcent', '/']], ['gpu', ['nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']], ['k3s', ['sudo', '-n', 'k3s', '--version']]];
        data.host = {};
        for (const [id, args] of hostCommands) {
          try {
            const text = await call('ssh', sshArgs(opts.ssh, args));
            if (id === 'os') data.host.os = bounded(/^PRETTY_NAME=(.*)$/m.exec(text)?.[1]?.replaceAll('"', '') ?? 'unknown');
            else if (id === 'cpu') {
              const fields = parseJson(text, 'CPU').lscpu ?? [];
              data.host.cpu = fields.filter(item => ['CPU(s):', 'Architecture:', 'Model name:'].includes(item.field)).map(item => ({ field: item.field, value: bounded(item.data) }));
            } else if (id === 'memory') data.host.memory = bounded(/^Mem:\s+([\d\s]+)$/m.exec(text)?.[0] ?? 'unknown');
            else if (id === 'disk') data.host.disk = bounded(text.split(/\r?\n/).find(line => /^\s*\d+\s+\d+\s+\d+%\s*$/.test(line)) ?? 'unknown');
            else if (id === 'gpu') data.host.gpu = text.trim().split(/\r?\n/).slice(0, 8).map(line => {
              const [model, memoryMiB, driver] = line.split(',').map(part => part.trim());
              return { model: bounded(model, 80), memoryMiB: /^\d+$/.test(memoryMiB) ? +memoryMiB : null, driver: /^[\d.]+$/.test(driver) ? driver : 'unknown' };
            });
            else data.host[id] = bounded(text.split(/\r?\n/)[0]);
            checks.push(check(`host-${id}`, 'pass', 'Safe fixed-command host summary collected'));
          } catch (error) { checks.push(check(`host-${id}`, 'unknown', error instanceof OpsError ? error.message : 'Host inventory unavailable')); }
        }
      } else checks.push(check('host-inventory', 'unknown', 'OS/GPU/disk host commands require SSH transport; Kubernetes node inventory collected'));
    } else if (['render', 'validate'].includes(opts.command)) {
      const path = resolve(opts.path ?? 'deploy/k8s/base');
      if (opts.command === 'validate') {
        const files = await yamlFiles(path);
        ensure(files.length, EXIT.usage, 'No YAML manifests found');
        await call('yamllint', ['--strict', '-d', '{rules: {key-duplicates: {level: error}, anchors: {forbid-undeclared-aliases: true}}}', ...files]);
        checks.push(check('strict-yaml', 'pass', 'All source YAML syntax, aliases and duplicate keys validated; existing formatting conventions preserved'));
      }
      const rendered = await call('kustomize', ['build', path]);
      const parsed = await call('yq', ['eval-all', '-o=json', '-I=0', '.', '-'], { input: rendered });
      const objects = parsed.split(/\r?\n/).filter(line => line.trim()).map(line => parseJson(line, 'yq')).filter(Boolean);
      ensure(objects.length, EXIT.execution, 'Kustomize rendered no resources');
      ensure(objects.every(item => typeof item === 'object' && item.apiVersion && item.kind && item.metadata?.name), EXIT.execution, 'Rendered resources lack Kubernetes identity');
      data.resources = objects.map(item => ({ kind: bounded(item.kind, 60), name: safeName(item.metadata?.name), namespace: namespaceOf(item) }));
      checks.push(check('render', 'pass', `${objects.length} resources rendered; contents withheld`));
      if (opts.command === 'validate') {
        await call('kubeconform', ['-strict', '-summary', '-output', 'json', '-kubernetes-version', '1.30.0', ...(opts['schema-location'] ? ['-schema-location', 'default', '-schema-location', resolve(opts['schema-location'])] : []), '-'], { input: rendered });
        checks.push(check('kubernetes-schema', 'pass', 'Strict schema validation passed; unknown CRDs are not ignored'));
        checks.push(...evaluatePolicy(objects));
      }
    } else if (['status', 'health'].includes(opts.command)) {
      await identity();
      const proof = await status();
      if (opts.command === 'health') {
        checks.push(proof.defaultdeny);
        checks.push(check('application-smoke', 'unknown', 'Workload readiness is not end-to-end application/GPU/model proof; independent acceptance evidence is required'));
      }
    } else if (opts.command === 'logs') {
      ensure(opts.service, EXIT.usage, 'Logs requires an allowlisted --service');
      await identity();
      const text = await kube(['logs', `deployment/${opts.service}`, '-n', SERVICES[opts.service], '--tail', opts.tail ?? '50', '--since=10m', '--limit-bytes=32768', '--timestamps=true', '--all-containers=true']);
      data.logs = summarizeLogs(text);
      checks.push(check('bounded-redacted-logs', 'pass', 'No log message bodies, prompts, images or credentials returned'));
    } else if (opts.command === 'reconcile') {
      ensure(opts.environment && opts.revision, EXIT.usage, 'Reconcile requires --environment and --revision');
      if (opts.execute) await approval();
      await identity();
      const source = parseJson(await kube(['get', 'gitrepositories.source.toolkit.fluxcd.io', 'velura-repo', '-n', 'flux-system', '-o', 'json']), 'Flux GitRepository');
      ensure(source.spec?.ref?.commit === opts.revision && source.status?.artifact?.revision?.endsWith(opts.revision) && ready(source) && source.spec?.suspend !== true, EXIT.checksFailed, 'Flux source must be pinned to the exact approved SHA, fetched and Ready before reconciliation');
      const targetName = opts.environment === 'staging' ? 'velura-staging' : 'velura-infra';
      const target = parseJson(await kube(['get', 'kustomizations.kustomize.toolkit.fluxcd.io', targetName, '-n', 'flux-system', '-o', 'json']), 'Flux Kustomization');
      ensure(target.spec?.sourceRef?.kind === 'GitRepository' && target.spec?.sourceRef?.name === 'velura-repo' && (target.spec.sourceRef.namespace ?? 'flux-system') === 'flux-system' && target.spec?.suspend !== true && target.spec?.path === `./deploy/k8s/overlays/${opts.environment}`, EXIT.checksFailed, 'Flux Kustomization must match the selected environment/path, reference the approved source and not be suspended');
      data.plan = { environment: opts.environment, revision: opts.revision, operation: 'Request Flux Kustomization reconciliation of already fetched Git revision', executed: false };
      if (opts.execute) {
        data.plan.executionAttempted = true;
        await kube(['annotate', 'kustomizations.kustomize.toolkit.fluxcd.io', targetName, '-n', 'flux-system', `reconcile.fluxcd.io/requestedAt=${new Date(now).toISOString()}`, '--overwrite']);
        data.plan.executed = true;
      }
      checks.push(check('git-reconcile', 'pass', opts.execute ? 'Flux reconciliation requested; later status must confirm convergence' : 'Readonly plan; rerun explicitly with --execute and owner approval to request reconciliation'));
    } else if (opts.command === 'rollback-plan') {
      ensure(opts.environment && opts.revision, EXIT.usage, 'Rollback plan requires --environment and full --revision of commit to revert');
      if (opts.execute) { await approval(); await identity(); }
      const cwd = resolve(opts.repo ?? '.');
      const parents = (await call('git', ['rev-list', '--parents', '-n', '1', opts.revision], { cwd })).trim().split(/\s+/);
      ensure(parents[0] === opts.revision, EXIT.checksFailed, 'Specified commit does not exist');
      ensure(parents.length <= 2 || opts.mainline === '1', EXIT.usage, 'Merge commit requires explicit --mainline 1');
      ensure(!(await call('git', ['status', '--porcelain'], { cwd })).trim(), EXIT.checksFailed, 'Rollback preparation requires clean working tree');
      const args = ['revert', '--no-commit', ...(opts.mainline ? ['--mainline', '1'] : []), opts.revision];
      data.plan = { operation: 'Prepare Git revert for review/promotion', revision: opts.revision, environment: opts.environment, command: ['git', ...args], executed: false, next: 'Review resulting diff, commit and submit approved promotion PR; never directly mutate images' };
      if (opts.execute) { data.plan.executionAttempted = true; await call('git', args, { cwd }); data.plan.executed = true; }
      checks.push(check('git-rollback', 'pass', opts.execute ? 'Git revert prepared without commit/push; review is required' : 'Readonly rollback plan'));
    } else if (opts.command === 'backup-check') {
      ensure(opts['backup-provider'] === 'restic' && opts.evidence && opts.environment && opts['expected-cluster'], EXIT.usage, 'Backup check requires --backup-provider restic, --evidence, --environment and --expected-cluster');
      const repository = env.RESTIC_REPOSITORY;
      ensure(typeof repository === 'string' && /^(?:s3:https:\/\/|b2:|azure:|gs:|sftp:|rest:https:\/\/)/.test(repository) && !/(?:localhost|127\.0\.0\.1|\[::1\])/.test(repository), EXIT.checksFailed, 'RESTIC_REPOSITORY must be a declared external encrypted/nonlocal provider, not a local VM copy');
      const record = await jsonFile(opts.evidence);
      ensure(record.version === 1 && record.provider === 'restic' && record.environment === opts.environment && record.clusterUid === opts['expected-cluster'] && record.storageLocation === 'external' && record.repositorySha256 === createHash('sha256').update(repository).digest('hex'), EXIT.checksFailed, 'Backup evidence provider/environment/cluster/repository does not match declared external provider');
      const snapshots = parseJson(await call('restic', ['snapshots', '--json', '--no-lock']), 'Restic snapshots');
      ensure(Array.isArray(snapshots), EXIT.execution, 'Restic snapshots response is not an array');
      const snapshot = snapshots.find(item => item.id === record.snapshotId && item.tags?.includes(`velura-cluster:${opts['expected-cluster']}`) && item.tags?.includes(`environment:${opts.environment}`));
      const positive = value => Number.isFinite(value) && value > 0;
      ensure(positive(record.rpoSeconds) && positive(record.rtoSeconds) && positive(record.restoreMaxAgeSeconds), EXIT.usage, 'Evidence must declare positive numeric RPO/RTO and restore freshness targets');
      const backupFresh = !!snapshot && fresh(snapshot.time, now, record.rpoSeconds * 1000) && timestamp(snapshot.time) === timestamp(record.backupAt);
      checks.push(check('provider-snapshot', backupFresh ? 'pass' : 'fail', 'Provider snapshot must match declared cluster/environment/repository and RPO timestamp'));
      checks.push(check('offsite-backup', 'unknown', 'External repository is declared; physical separation from this VM requires independently verified provider evidence'));
      const restore = record.restoredSnapshotId === record.snapshotId && fresh(record.restoreVerifiedAt, now, record.restoreMaxAgeSeconds * 1000) && timestamp(record.restoreVerifiedAt) >= timestamp(record.backupAt) && positive(record.restoreDurationSeconds) && record.restoreDurationSeconds <= record.rtoSeconds && typeof record.verifiedBy === 'string' && /^https:\/\//.test(record.source ?? '') && ['manual', 'signed'].includes(record.verificationType);
      checks.push(check('restore-evidence', restore ? 'unknown' : 'fail', restore ? 'Fresh external restore attestation meets declared RTO, but authenticity and restored data are not runtime verified by this CLI' : 'Missing/stale/mismatched restore evidence or RTO exceeded', { type: restore ? record.verificationType : 'missing', independentlyVerified: false }));
      data.backup = { provider: 'restic', snapshotPresent: !!snapshot, meetsRpo: backupFresh, externalRestoreEvidencePresent: restore, runtimeRestoreVerified: false };
    } else if (opts.command === 'acceptance') {
      const requirements = await jsonFile(opts.requirements ?? DEFAULT_REQUIREMENTS);
      ensure(requirements.version === 1 && Array.isArray(requirements.requirements) && requirements.requirements.length > 0, EXIT.usage, 'Requirements catalog must contain version 1 and nonempty requirements array');
      const ids = new Set();
      for (const requirement of requirements.requirements) {
        ensure(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(requirement.id) && typeof requirement.description === 'string' && !ids.has(requirement.id), EXIT.usage, 'Requirements need unique safe IDs and descriptions');
        ids.add(requirement.id);
      }
      const evidence = opts.evidence ? await jsonFile(opts.evidence) : { evidence: [] };
      ensure(Array.isArray(evidence.evidence), EXIT.usage, 'Acceptance evidence must contain evidence array');
      const proof = {};
      if (opts['expected-cluster']) {
        try { await identity(); Object.assign(proof, await status(true)); }
        catch (error) { checks.push(check('runtime-collection', 'unknown', error instanceof OpsError ? error.message : 'Runtime evidence unavailable')); }
      }
      data.requirements = requirements.requirements.map(requirement => {
        const runtime = requirement.runtime && proof[requirement.runtime];
        if (runtime) return { ...check(requirement.id, runtime.status, runtime.detail, { type: 'runtime', scope: PRODUCTION_NAMESPACES }), description: bounded(requirement.description, 400) };
        const record = evidence.evidence.find(item => item.id === requirement.id);
        const valid = record && evidence.version === 1 && evidence.clusterUid === opts['expected-cluster'] && typeof record.verifier === 'string' && /^https:\/\//.test(record.source ?? '') && ['manual', 'signed'].includes(record.type) && fresh(record.observedAt, now, 30 * 86400000) && timestamp(record.expiresAt) > now && ['pass', 'fail', 'unknown'].includes(record.status);
        return { ...check(requirement.id, valid && record.status === 'fail' ? 'fail' : 'unknown', valid ? 'External attestation recorded separately; not accepted as automatic runtime proof' : 'No fresh independently verified evidence; acceptance is unknown', valid ? { type: record.type, declaredStatus: record.status, independentlyVerified: false, observedAt: record.observedAt } : undefined), description: bounded(requirement.description, 400) };
      });
      checks.push(...data.requirements);
    }
    const blockers = checks.filter(item => item.status !== 'pass').map(item => ({ id: item.id, status: item.status, detail: item.detail }));
    const result = { schemaVersion: VERSION, command: opts.command, ok: blockers.length === 0, executed: opts.execute === true && data.plan?.executed === true, checks, blockers, data };
    ensure(Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES, EXIT.execution, 'Structured result exceeds safe output limit');
    return { exitCode: blockers.length ? EXIT.checksFailed : EXIT.ok, result };
  } catch (error) {
    const code = error instanceof OpsError ? error.code : EXIT.execution;
    const message = error instanceof OpsError ? error.message : 'Operation failed; filesystem/process details withheld to protect credentials';
    const blocker = { id: 'operation', status: 'fail', detail: message };
    const boundedChecks = checks.slice(0, 200);
    return { exitCode: code, result: { schemaVersion: VERSION, command: opts?.command ?? 'unknown', ok: false, executed: data.plan?.executed === true, mutationAttempted: data.plan?.executionAttempted === true, checks: boundedChecks, blockers: [...boundedChecks.filter(item => item.status !== 'pass'), blocker], error: { code, message } } };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outcome = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
}

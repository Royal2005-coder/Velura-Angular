#!/usr/bin/env bash
# Builds ai-lab/ctx-demo: a GitOps monorepo big enough to argue with.
#
# Everything is generated, deterministically, so the repo can be thrown away and
# rebuilt at any time and can never drift from what ctx reports about it.
#
# TO ADD A SCENARIO: use the helpers below and append to the relevant phase.
#   w    <path>            write a file from stdin (creates parent dirs)
#   plain   <date> <subject>                    a commit with no decision record
#   decide  <date> <subject> <trailer>...       a commit that records one
#   ran     <sha> <date> <pass|fail> [incident] a CI run note
#   incident <sha> <date> <open|closed> <text>  an incident note
set -euo pipefail

CTX="$(cd "$(dirname "$0")" && pwd)/bin/ctx"
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)/ctx-demo}"

rm -rf "$REPO"; mkdir -p "$REPO"; cd "$REPO"
git init -q -b main .
git config user.name  "ai-lab platform"
git config user.email "platform@ba-ailab.com"
git config commit.gpgsign false

say() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

_commit() { # date, then git commit args
  local d="$1"; shift
  git add -A
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit -q "$@"
}
plain()  { local d="$1" s="$2"; _commit "$d" -m "$s"; }
decide() {
  local d="$1" s="$2"; shift 2
  local args=(-m "$s")
  for t in "$@"; do args+=(--trailer "$t"); done
  _commit "$d" "${args[@]}"
}
ran() { # sha date status [incident]
  git notes --ref=runs append -m "at: $2 | status: $3 | incident: ${4:-none}" "$1"
}
incident() { # sha date status text
  git notes --ref=incidents append -m "at: $2 | status: $3 | summary: $4" "$1"
}

say "ctx init"
"$CTX" init -hooks >/dev/null
cat > .ctx-gate-paths <<'GATEEOF'
# Paths where a wrong change is expensive: provisioning, terraform state,
# anything ArgoCD applies directly to the cluster. Tracked, not local config,
# so a clone of this repo gets the same protection it was built to show.
platform
infra/terraform
clusters
GATEEOF
git add .git-blame-ignore-revs .ctx-gate-paths
GIT_AUTHOR_DATE="2026-01-06T09:00:00+07:00" GIT_COMMITTER_DATE="2026-01-06T09:00:00+07:00" \
  git commit -q -m "chore: adopt the ctx trailer contract" \
  --trailer "Decision:platform/, infra/terraform/ and clusters/ require a Decision: trailer before merge; everything else stays ungated until it earns it. Gated paths are tracked in .ctx-gate-paths, not local config, so a clone gets the same protection"

# ═══════════════════════════════════════════════ phase 1: cluster foundations
w clusters/prod/cluster.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata: { name: cluster-facts, namespace: kube-system }
data:
  name: ai-lab-prod
  apiEndpoint: "10.10.0.10:6443"
  cni: flannel
  nodes: "hyperion,z8-1,z8-2,z8-3"
EOF
w infra/terraform/live/k3s/main.tf <<'EOF'
locals {
  api_vip      = "10.10.0.10"
  cluster_cidr = "10.42.0.0/16"
  service_cidr = "10.43.0.0/16"
}

resource "null_resource" "k3s_server" {
  triggers = {
    args = join(" ", [
      "--tls-san=${local.api_vip}",
      "--advertise-address=${local.api_vip}",
      "--disable=traefik",
      "--disable=servicelb",
    ])
  }
}
EOF
decide "2026-01-08T09:00:00+07:00" "infra(k3s): pin the API server to a LAN VIP" \
  "Decision: the API advertises the LAN VIP 10.10.0.10, never a tailnet address, so the control plane survives a VPN outage" \
  "Rejected: advertising the tailscale IP, which makes every worker NotReady whenever the tailnet flaps" \
  "Rejected: a managed load balancer, a recurring cost and a SPOF outside the lab" \
  "Reversible: never" "Oracle: drift"
K3S=$(git rev-parse HEAD)

w platform/ingress/traefik/values.yaml <<'EOF'
deployment:
  replicas: 1
nodeSelector:
  kubernetes.io/hostname: ailab-hyperion
service:
  type: LoadBalancer
  spec:
    externalTrafficPolicy: Local
ports:
  websecure:
    tls:
      enabled: true
EOF
decide "2026-01-15T14:20:00+07:00" "platform(ingress): single Traefik pinned to hyperion" \
  "Decision: one Traefik replica pinned to ailab-hyperion; the SPOF is accepted because only that node holds the public address" \
  "Rejected: a DaemonSet across all nodes, which needs a VIP the lab network cannot provide" \
  "Reversible: restore-only" "Oracle: drift"
TRAEFIK=$(git rev-parse HEAD)

# ═══════════════════════════════════════════════ phase 2: platform services
w platform/secrets/vault/vso-auth.yaml <<'EOF'
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultAuth
metadata: { name: platform, namespace: vault-secrets }
spec:
  method: kubernetes
  mount: kubernetes
  kubernetes:
    role: platform
    serviceAccount: default
    audiences: ["vault"]
EOF
w infra/terraform/live/vault/auth.tf <<'EOF'
resource "vault_kubernetes_auth_backend_role" "platform" {
  role_name                        = "platform"
  bound_service_account_names      = ["default"]
  bound_service_account_namespaces = ["vault-secrets", "data", "observability"]
  token_policies                   = ["platform-read"]
  token_ttl                        = 3600
}
EOF
decide "2026-01-22T11:05:00+07:00" "platform(secrets): Vault Secrets Operator, not the sidecar injector" \
  "Decision: VSO syncs Vault into Kubernetes Secrets; workloads read plain Secrets and never learn Vault exists" \
  "Rejected: the agent sidecar injector, which doubles every pod and couples app startup to Vault being up" \
  "Rejected: sealed-secrets, which moves the rotation problem into git" \
  "Reversible: never" "Oracle: contract"
VSO=$(git rev-parse HEAD)

w platform/storage/minio/tenant.yaml <<'EOF'
apiVersion: minio.min.io/v2
kind: Tenant
metadata: { name: lake, namespace: storage }
spec:
  pools:
    - servers: 4
      volumesPerServer: 1
      size: 2Ti
  requestAutoCert: false
EOF
decide "2026-02-03T10:00:00+07:00" "platform(storage): MinIO tenant for the lakehouse" \
  "Decision: a four-server MinIO tenant backs Iceberg and the Airflow logs" \
  "Rejected: hostPath on a single node, which cannot survive losing it" \
  "Reversible: restore-only" "Oracle: test"
MINIO=$(git rev-parse HEAD)

w platform/observability/prometheus/values.yaml <<'EOF'
prometheus:
  prometheusSpec:
    retention: 15d
    retentionSize: 45GB
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: longhorn
          resources: { requests: { storage: 50Gi } }
grafana:
  persistence: { enabled: true, storageClassName: longhorn, size: 10Gi }
EOF
w platform/observability/loki/values.yaml <<'EOF'
loki:
  commonConfig: { replication_factor: 1 }
  storage:
    type: s3
    bucketNames: { chunks: loki-chunks, ruler: loki-ruler }
singleBinary: { replicas: 1 }
EOF
decide "2026-02-11T16:30:00+07:00" "platform(observability): 15 day retention, object-store backed" \
  "Decision: metrics keep 15 days on Longhorn and logs go straight to object storage, because log volume outgrows block storage within a week" \
  "Rejected: 90 day metric retention, which needs storage the lab does not have" \
  "Reversible: true" "Oracle: drift"
OBS=$(git rev-parse HEAD)

w platform/data/postgres/cluster.yaml <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: platform, namespace: data }
spec:
  instances: 3
  postgresql:
    parameters:
      jit: "off"
      max_connections: "400"
  storage: { size: 200Gi, storageClass: longhorn }
  backup:
    barmanObjectStore:
      destinationPath: s3://backups/postgres
      wal: { compression: gzip }
EOF
decide "2026-02-18T09:45:00+07:00" "platform(data): one CNPG cluster for every platform database" \
  "Decision: a single three-instance CNPG cluster hosts every platform database; jit is off because the metastores regress badly with it on" \
  "Rejected: one cluster per service, which multiplies operator load and backup surface by seventeen" \
  "Rejected: a managed database, which puts the metastore outside the lab network" \
  "Reversible: never" "Oracle: contract"
PG=$(git rev-parse HEAD)

# ═══════════════════════════════════════════ phase 3: apps at some breadth
# Six services, each kustomize base + two overlays. Generated in a loop so the
# repo has realistic width without six hundred lines of heredoc here.
for app in api web worker ingest scheduler notifier; do
  w "apps/$app/base/deployment.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: { name: $app, namespace: apps }
spec:
  replicas: 2
  selector: { matchLabels: { app: $app } }
  template:
    metadata: { labels: { app: $app } }
    spec:
      containers:
        - name: $app
          image: registry.ba-ailab.com/ai-lab/$app:v1.0.0
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: "1",  memory: 512Mi }
EOF
  w "apps/$app/base/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [deployment.yaml]
EOF
  for env in staging prod; do
    reps=2; [ "$env" = prod ] && reps=4
    w "apps/$app/overlays/$env/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: apps-$env
resources: [../../base]
replicas:
  - name: $app
    count: $reps
EOF
  done
  w "clusters/prod/applications/$app.yaml" <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: $app, namespace: argocd }
spec:
  project: default
  source:
    repoURL: https://gitlab.ba-ailab.com/ba-ai-lab/infra/ctx-demo.git
    path: apps/$app/overlays/prod
  destination: { server: https://kubernetes.default.svc, namespace: apps-prod }
  syncPolicy: { automated: { prune: true, selfHeal: true } }
EOF
done
decide "2026-02-25T13:00:00+07:00" "apps: kustomize base plus per-environment overlays" \
  "Decision: every service is a kustomize base with staging and prod overlays, and ArgoCD points at the overlay rather than the base" \
  "Rejected: Helm charts per service, which hides the rendered manifest from review" \
  "Rejected: one overlay for all environments with a patch file, which makes prod drift invisible" \
  "Reversible: true" "Oracle: test"
APPS=$(git rev-parse HEAD)

# realistic noise: routine changes nobody needs to justify
i=0
for app in api web worker ingest scheduler notifier; do
  i=$((i+1))
  sed -i "s|$app:v1.0.0|$app:v1.1.$i|" "apps/$app/base/deployment.yaml"
  plain "2026-03-0${i}T10:00:00+07:00" "chore($app): bump image to v1.1.$i"
done

# ═══════════════════════════════════════════════ phase 4: storage incidents
# Dramatizes three real ai-lab outages:
#   - MinIO-on-iSCSI: V1 stale-mount dup-UUID (fix: delete pod) superseded by
#     V2 dead-zombie-session fix (fix: patch node volumesInUse) because V1's
#     fix did not cover the zombie-transport failure mode.
#   - Longhorn wedged by heavy Isaac Sim write I/O (D-state cascade, node reboot).
#   - Shared platform Redis MISCONF from a silently-aborted ext4 journal.

# --- MinIO on iSCSI: V1, the stale-mount dup-UUID fix -----------------------
w platform/storage/minio-iscsi/pod-recovery.md <<'EOF'
# MinIO-on-Synology-iSCSI: stale mount recovery

When the iSCSI path flaps, the LUN can re-enumerate (`/dev/sda` -> `/dev/sdj`)
while the running MinIO pod keeps its mount on the now-dead device. The kernel
still sees that XFS UUID as mounted, so the kubelet's remount of the new device
node fails with a duplicate-UUID error and MinIO writes 503 with
`InsufficientWriteQuorum`.

Runbook: `kubectl delete pod -n platform <minio-pod>`. Releasing the stale
mount frees the UUID; the new pod mounts the live device cleanly. ~30s
downtime. The filesystem is intact — this is not corruption, do not run
xfs_repair.
EOF
decide "2026-03-10T09:00:00+07:00" "platform(storage): recover MinIO-on-iSCSI by deleting the stale pod" \
  "Decision: on a MinIO iSCSI stale-mount dup-UUID (XFS 'Filesystem has duplicate UUID', drive offline, InsufficientWriteQuorum), delete the pod rather than touch the node" \
  "Rejected: xfs_repair or fsck, since the filesystem is intact and not full — the pod is holding a stale mount on a dead device path, not corrupted data" \
  "Reversible: true" "Oracle: test"
P4_MINIO_V1=$(git rev-parse HEAD)
ran "$P4_MINIO_V1" "2026-03-10T09:05:00Z" fail INC-2026-031
incident "$P4_MINIO_V1" "2026-03-10T09:06:00Z" closed "MinIO 503 InsufficientWriteQuorum; mc admin info showed Drives: 0/1 OK; deleting the pod cleared the stale /dev/sda mount and the new pod mounted /dev/sdd cleanly"
ran "$P4_MINIO_V1" "2026-03-10T09:12:00Z" pass

# --- Longhorn wedged by heavy Isaac Sim I/O ---------------------------------
w platform/storage/longhorn/scratch-policy.md <<'EOF'
# Longhorn: no heavy training I/O

Longhorn replicates every write synchronously across nodes. A tight Isaac Sim
write loop (regression/training output) can saturate the storage engine until
I/O blocks indefinitely, cascading the whole node into D-state (jbd2, NFS
clients, the jobs themselves) and eventually taking containerd's PLEG down
with it -> node NotReady.

Policy: training/regression `--output-dir` MUST point at local scratch
(`/dev/shm`, emptyDir, local-path) — never at a Longhorn-backed `/workspace` or
`/home`. Longhorn PVCs are for durability, not for high-throughput scratch
writes.
EOF
decide "2026-03-13T10:30:00+07:00" "platform(storage): ban Longhorn as Isaac Sim scratch output" \
  "Decision: training and regression jobs must write output to local scratch, never to a Longhorn-backed volume, because two concurrent heavy write jobs wedged a GPU node into D-state and took it NotReady" \
  "Rejected: capping concurrent jobs per node instead, which reduces the odds but does not remove the failure mode" \
  "Reversible: never" "Oracle: drift"
P4_LONGHORN=$(git rev-parse HEAD)
ran "$P4_LONGHORN" "2026-03-13T10:35:00Z" fail INC-2026-034
incident "$P4_LONGHORN" "2026-03-13T10:40:00Z" open "z8-2-hp-z8-g5 went NotReady under two concurrent Isaac Sim jobs writing to Longhorn PVCs; only a full node reboot clears the D-state cascade, and the policy alone cannot be enforced by a reconciler yet"

# --- Shared platform Redis: ext4 journal aborted ----------------------------
w platform/cache/redis/misconf-recovery.md <<'EOF'
# Shared platform Redis: MISCONF from a silently aborted ext4 journal

GitLab (and at least nine other cluster-wide consumers) point at the shared
`redis.platform.svc.cluster.local:6379`. When that Redis hits MISCONF
("configured to save RDB snapshots, but it's currently unable to persist to
disk"), every one of those consumers 500s at once — this is never only
GitLab's problem.

The diagnostic that matters, all three at once: the mount is rw with plenty
free space, Longhorn reports the volume attached and healthy, and yet every
write returns EIO. That combination means the ext4 journal aborted on the
node — Longhorn is telling the truth, this is not a replica failure, and there
is nothing to salvage.

Fix: `kubectl delete pod` on the Redis pod. The Deployment recreates it, the
Longhorn volume detaches and reattaches, and the CSI driver fsck's on the way
back in. ~80s to Ready, no data loss.
EOF
decide "2026-03-20T18:00:00+07:00" "platform(cache): recover shared Redis by forcing a volume reattach" \
  "Decision: on shared platform Redis MISCONF with a healthy Longhorn volume but EIO on every write, delete the pod to force detach/reattach rather than investigate replicas" \
  "Rejected: chasing Longhorn replica health, since attached+healthy+rw+EIO means the node's ext4 journal aborted, not that a replica is bad" \
  "Reversible: true" "Oracle: test"
P4_REDIS=$(git rev-parse HEAD)
ran "$P4_REDIS" "2026-03-20T18:05:00Z" fail INC-2026-041
incident "$P4_REDIS" "2026-03-20T18:07:00Z" closed "gitlab.ba-ailab.com API and git smart-HTTP both 500 on Redis::CommandError MISCONF while the web UI still 302'd; pod delete forced a Longhorn detach/reattach and GitLab returned 200 with no restart needed"
ran "$P4_REDIS" "2026-03-20T18:20:00Z" pass

# --- MinIO on iSCSI: V2 supersedes V1 ---------------------------------------
# V1's "just delete the pod" fix does not cover this failure mode: here the
# iSCSI *transport* itself is dead (a zombie session on the chronically-wedged
# z8-2), so a pod delete just reschedules and jams on Multi-Attach because the
# old node still lists the volume in volumesInUse. The retirement of V1 as the
# universal fix has to be a reviewed commit, not a silent overwrite.
GIT_AUTHOR_DATE="2026-03-16T14:00:00+07:00" GIT_COMMITTER_DATE="2026-03-16T14:00:00+07:00" \
  "$CTX" supersede "$P4_MINIO_V1" -reason "V1 assumed the iSCSI transport was alive and only the mount was stale; this recurrence had a dead zombie session on z8-2, so a pod delete just rescheduled the pod into a Multi-Attach jam instead of recovering" >/dev/null

w platform/storage/minio-iscsi/pod-recovery.md <<'EOF'
# MinIO-on-Synology-iSCSI: zombie-session recovery (supersedes the stale-mount fix)

Symptom looks different from the stale-mount case: every HTTP request to
MinIO hangs forever, even loopback health checks from inside the pod, while
`ls` against already-cached metadata still works. MinIO's own log claims
"1 Online" — that is a lie.

Root cause: the MinIO pod landed on the chronically-wedged node, and that
node's iSCSI session went half-dead — the device node is present but the
transport is gone (`dd` against it returns "No such device or address"). The
node's block/VFS layer is impaired badly enough that even logging out of the
iSCSI session fails.

Deleting the pod is NOT enough here: it reschedules to a healthy node and
jams on a Multi-Attach error, because the wedged node still lists the volume
in its `status.volumesInUse` and won't relinquish it on its own.

Fix (zero disruption, no reboot required): patch the wedged node's status to
remove the volume from `volumesInUse`. The attach/detach controller completes
the attach on the healthy node within seconds. The wedged node harmlessly
re-adds the entry afterward. Still owed: reboot the wedged node to actually
clear its D-state processes, and pin this workload away from it going forward.
EOF
decide "2026-03-16T14:15:00+07:00" "platform(storage): recover MinIO-on-iSCSI from a dead zombie session by patching volumesInUse" \
  "Decision: when the MinIO node's iSCSI transport itself is dead (not just a stale mount), patch the wedged node's volumesInUse status directly instead of deleting the pod" \
  "Rejected: deleting the pod alone, which reschedules the pod but leaves the wedged node still claiming the volume, jamming the new pod on Multi-Attach" \
  "Rejected: rebooting the wedged node immediately, which would work but costs far more downtime than the volumesInUse patch and is not needed to unblock MinIO" \
  "Reversible: never" "Oracle: contract"
P4_MINIO_V2=$(git rev-parse HEAD)
ran "$P4_MINIO_V2" "2026-03-16T14:20:00Z" fail INC-2026-037
incident "$P4_MINIO_V2" "2026-03-16T14:35:00Z" open "Trino Iceberg reads failed with ICEBERG_INVALID_METADATA while MinIO's own health endpoint hung forever; node reboot to clear the underlying D-state wedge is still owed"
ran "$P4_MINIO_V2" "2026-03-16T14:40:00Z" pass


# ═══════════════════════════════════════════════ phase 5: GPU / driver decisions
#
# Grounded in three real ai-lab incidents:
#   - NVML "Driver/library version mismatch" after apt bumps the driver without
#     a reboot (old kernel module + new userspace libs); only NEW GPU pods fail,
#     so it hides until something restarts. Fixed on ba-ai-lab-small-gpu-server-11
#     2026-06-03 by a rolling cordon/drain/reboot/uncordon.
#   - nvidia-device-plugin crashlooping with "Incompatible strategy detected
#     auto" on a node that joined CPU/RAM-only: the plugin pod runs under plain
#     runc with no NVML. Fixed with runtimeClassName: nvidia on the DaemonSet,
#     NOT by editing the node's containerd default (that touches every pod on
#     the node — ~28 of them on z8-3).
#   - vLLM guided_json OOMKilled the rewrite pod at 16Gi (schema-FSM build is
#     host-RAM-hungry under concurrency, and still ~9% invalid JSON). Fixed
#     with response_format=json_object + 24Gi + lower concurrency — and later,
#     json_object ITSELF turned out to gut throughput (outlines computes the
#     token mask in Python per decode step: 0% GPU util, ~1 tok/s/stream) until
#     JSON enforcement was disabled server-side by default.
#
# P5_DEVICE_PLUGIN_V1 and P5_DEVICE_PLUGIN_V2 are the ORPHAN PAIR: V2 rewrites
# platform/gpu/device-plugin/values.yaml completely (a different fix strategy
# entirely — the GPU Operator instead of hand-pinned runtimeClassName) and
# nobody calls `ctx supersede` on V1. V1's decision therefore owns zero
# surviving lines and never had its retirement reviewed — it should surface
# under `orphaned`, not `superseded`, when the file is queried. V1 is tagged
# `Reversible: restore-only` (not `true`) so it clears ctx's default
# orphan-hiding threshold.

w infra/terraform/live/gpu/node-config.tf <<'EOF'
# Prevent the NVML "Driver/library version mismatch" class of outage: an
# unattended apt upgrade bumps the userspace driver libs and the on-disk
# kernel module, but the OLD module stays loaded until a reboot. Existing GPU
# pods keep running against the old libs and look healthy; only a NEW pod
# fails at container-create, so the drift is invisible until something
# restarts.
resource "null_resource" "gpu_driver_apt_hold" {
  triggers = {
    packages = join(",", ["nvidia-driver-535", "nvidia-utils-535", "libnvidia-compute-535"])
    command  = "apt-mark hold $${packages}"
  }
}
EOF
decide "2026-03-21T09:00:00+07:00" "infra(gpu): hold the driver package version on GPU nodes" \
  "Decision: apt-mark hold the NVIDIA driver packages on every GPU node, so an unattended-upgrades run cannot bump the userspace libs ahead of the loaded kernel module" \
  "Rejected: an allowlist in unattended-upgrades config instead of a hold, which still lets a manual apt upgrade drift the two apart" \
  "Reversible: true" "Oracle: drift"
P5_DRIVER_HOLD=$(git rev-parse HEAD)
incident "$P5_DRIVER_HOLD" "2026-03-18T08:40:00+07:00" "closed" "ba-ai-lab-small-gpu-server-11: NVML Driver/library version mismatch after an apt driver bump with no reboot; new GPU pods failed at container-create (StartError, exitCode 128) while already-running pods looked fine. Fixed 2026-06-03 with a cordon/drain/reboot/uncordon."

w platform/gpu/device-plugin/values.yaml <<'EOF'
runtimeClassName: nvidia
nodeSelector:
  gpu: "true"
  gpu-driver-tested: "535.309.01"
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
EOF
decide "2026-03-23T10:30:00+07:00" "platform(gpu): pin the device plugin to the nvidia RuntimeClass" \
  "Decision: set runtimeClassName: nvidia on the device-plugin DaemonSet and gate scheduling on a driver-version-tested node label, because a node that joins CPU/RAM-only has no containerd default_runtime_name and the plugin pod lands on plain runc with no NVML" \
  "Rejected: editing default_runtime_name in the node's containerd config.toml.tmpl, which changes the runtime for every pod already on that node — about 28 of them on z8-3, including MinIO and a 10h-running crawl job" \
  "Rejected: trusting a running dcgm-exporter or nvidia-smi from an already-open pod as proof the node is healthy — it keeps the old driver libs loaded and looks fine even when the on-disk module has drifted" \
  "Reversible: restore-only" "Oracle: contract"
P5_DEVICE_PLUGIN_V1=$(git rev-parse HEAD)
incident "$P5_DEVICE_PLUGIN_V1" "2026-03-22T15:05:00+07:00" "closed" "nvidia-device-plugin crashlooping on a newly-joined node: \"Incompatible strategy detected auto\" / \"If this is a GPU node, did you configure the NVIDIA Container Toolkit?\" — toolkit was fine, the plugin pod itself had no NVML."
ran "$P5_DEVICE_PLUGIN_V1" "2026-03-22T15:10:00+07:00" "fail" "INC-GPU-014"
ran "$P5_DEVICE_PLUGIN_V1" "2026-03-23T10:35:00+07:00" "pass"

w platform/gpu/device-plugin/values.yaml <<'EOF'
# Managed by the NVIDIA GPU Operator: driver, container toolkit and device
# plugin lifecycle are now one reconciled CRD instead of three hand-pinned
# files (apt hold, containerd runtime class, node labels) that can drift out
# of sync with each other — which is exactly what produced the NVML mismatch.
apiVersion: nvidia.com/v1
kind: ClusterPolicy
metadata:
  name: cluster-policy
spec:
  driver:
    enabled: true
    version: "535.309.01"
  devicePlugin:
    enabled: true
  toolkit:
    enabled: true
EOF
decide "2026-03-27T14:00:00+07:00" "platform(gpu): adopt the NVIDIA GPU Operator" \
  "Decision: the GPU Operator's ClusterPolicy owns driver, toolkit and device-plugin lifecycle together, instead of three hand-pinned files that can silently drift apart the way the runtimeClassName pin and the apt hold already had once" \
  "Rejected: keep pinning apt-mark hold and adding more node labels by hand, which only slows the drift and does nothing for nodes that joined before the hold existed" \
  "Reversible: restore-only" "Oracle: drift"
P5_DEVICE_PLUGIN_V2=$(git rev-parse HEAD)

w apps/vllm-inference/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: vllm-rewrite, namespace: apps }
spec:
  replicas: 1
  selector: { matchLabels: { app: vllm-rewrite } }
  template:
    metadata: { labels: { app: vllm-rewrite } }
    spec:
      runtimeClassName: nvidia
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4.post1
          args: ["--model", "Qwen2.5-14B-AWQ"]
          env:
            - { name: RESPONSE_FORMAT, value: "json_object" }
            - { name: REWRITE_CONCURRENCY, value: "4" }
          resources:
            requests: { cpu: "2", memory: 24Gi }
            limits:   { cpu: "4", memory: 24Gi, "nvidia.com/gpu": "1" }
EOF
decide "2026-03-29T11:15:00+07:00" "apps(vllm-rewrite): json_object instead of guided_json, 24Gi, concurrency 4" \
  "Decision: response_format=json_object instead of guided_json, container memory 16Gi to 24Gi, and REWRITE_CONCURRENCY 8 to 4 — guided_json's schema FSM build is host-RAM-hungry with free-form string fields, and under 8-way concurrency it OOMKilled the pod while still returning ~9% invalid JSON" \
  "Rejected: keep guided_json and only raise the memory limit, which does not fix the ~9% invalid-JSON rate and still burns RAM per concurrent request" \
  "Reversible: true" "Oracle: drift"
P5_VLLM_JSON=$(git rev-parse HEAD)
incident "$P5_VLLM_JSON" "2026-03-28T22:10:00+07:00" "closed" "vllm-rewrite OOMKilled (exit 137) at the 16Gi limit under 8-way concurrency, cascading the whole rewrite_content batch into Connection refused."
ran "$P5_VLLM_JSON" "2026-03-28T22:15:00+07:00" "fail" "INC-GPU-021"
ran "$P5_VLLM_JSON" "2026-03-29T11:20:00+07:00" "pass"

sed -i 's/value: "json_object"/value: "false"/; s/RESPONSE_FORMAT/LLM_JSON_ENFORCE/' apps/vllm-inference/deployment.yaml
decide "2026-03-31T16:45:00+07:00" "apps(vllm-rewrite): stop enforcing JSON server-side by default" \
  "Decision: default LLM_JSON_ENFORCE to false and rely on the prompt plus a defensive parser, because json_object still routes through this image's outlines guided-decoding backend, which computes the token mask in Python per decode step and dropped throughput to roughly 1 tok/s per stream at 0 percent GPU utilization" \
  "Rejected: switch to the xgrammar backend immediately, which is not available in the pinned vllm-openai:v0.6.4.post1 image and needs an upgrade first" \
  "Reversible: true" "Oracle: test"
P5_VLLM_THROUGHPUT=$(git rev-parse HEAD)
incident "$P5_VLLM_THROUGHPUT" "2026-03-30T09:00:00+07:00" "closed" "Backfill throughput collapsed to ~25-30 tok/s aggregate with 0% GPU util and ~1 CPU core pegged — the outlines any-JSON FSM mask computation, not the card or Slurm time-slicing. Disabling server-side enforcement recovered roughly 30x, to ~900 tok/s."


# ═══════════════════════════════════════════ phase 6: networking/access
#
# Three real incidents:
#   - reference_headscale_cloudflare_upgrade: Cloudflare's proxy strips the
#     non-websocket Upgrade header TS2021 needs, so headscale must not sit
#     behind the Cloudflare tunnel; the fix also needed the upstream proxy
#     hop forced to HTTP/1.1, since HTTP/2 has no Upgrade mechanism and
#     silently drops the request (register returns 500 with no clear signal).
#   - feedback_coder_502_ghost_routers: headscale-router pods didn't persist
#     tailscale identity, so every restart registered a new node and orphaned
#     the old one as a dead "ghost" that could still win Primary for the
#     10.43.0.0/16 route, blackholing traffic and 502ing Coder's asset bursts.
#   - feedback_vps_hairpin_stalls_cluster: an in-cluster pod resolving a
#     public *.ba-ailab.com name hairpins out through the VPS and back,
#     stalling ~20s intermittently — fixed with a CoreDNS rewrite straight to
#     the Traefik Service.
#
# THE TOMBSTONE: P6_RETIRE_VPS_EDGE does `git rm` (never a rename) on the
# Terraform-managed VPS vhost this phase stands up, once the CoreDNS rewrite
# makes it redundant for in-cluster traffic — a pure deletion, so `ctx for`
# on infra/edge/vps-edge.tf must return `removed:` with no `renamed_to`.

w infra/edge/vps-edge.tf <<'EOF'
# Grey-cloud VPS vhost for headscale — bypasses the Cloudflare tunnel entirely
resource "local_file" "vps_caddy_vhost" {
  filename = "/opt/infra/config/caddy/headscale.ba-ailab.com.Caddyfile"
  content  = <<-CADDY
    headscale.ba-ailab.com {
      reverse_proxy https://traefik.internal.svc:443
    }
  CADDY
}
EOF
decide "2026-04-01T09:00:00+07:00" "infra(headscale): grey-cloud the VPS edge, bypass the Cloudflare tunnel" \
  "Decision: headscale.ba-ailab.com is grey-cloud DNS straight to the VPS, which reverse-proxies into the cluster, because headscale's TS2021 control protocol upgrades HTTP with a non-websocket Upgrade header that Cloudflare's proxy strips, turning /machine/register into a silent 500" \
  "Rejected: keep headscale behind the same Cloudflare tunnel as everything else (GET /key works, so the failure looks like a headscale bug rather than an edge problem)" \
  "Reversible: restore-only" "Oracle: test"
P6_VPS_EDGE=$(git rev-parse HEAD)

w infra/edge/vps-edge.tf <<'EOF'
# Grey-cloud VPS vhost for headscale — bypasses the Cloudflare tunnel entirely
resource "local_file" "vps_caddy_vhost" {
  filename = "/opt/infra/config/caddy/headscale.ba-ailab.com.Caddyfile"
  content  = <<-CADDY
    headscale.ba-ailab.com {
      reverse_proxy https://traefik.internal.svc:443 {
        transport http {
          versions tls1.1 1.1
        }
      }
    }
  CADDY
}
EOF
decide "2026-04-02T10:00:00+07:00" "infra(headscale): force HTTP/1.1 to the cluster upstream" \
  "Decision: the proxy hop from the VPS to Traefik is forced to HTTP/1.1, because HTTP/2 has no Upgrade mechanism and an h2 upstream silently drops the TS2021 upgrade request instead of erroring — GET /key still returns 200, so the symptom looks unrelated to the actual cause" \
  "Reversible: true" "Oracle: test"
P6_HTTP1_FIX=$(git rev-parse HEAD)
ran "$P6_HTTP1_FIX" "2026-04-02T09:50:00+07:00" fail INC-2026-039
ran "$P6_HTTP1_FIX" "2026-04-02T10:05:00+07:00" pass
incident "$P6_HTTP1_FIX" "2026-04-02T09:45:00+07:00" closed "headscale clients stuck un-registered; GET /key returned 200 but POST /machine/register returned 500 with no error text, because the h2 upstream hop silently dropped the protocol Upgrade"

w platform/coder/router-deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: headscale-router, namespace: headscale }
spec:
  replicas: 1
  selector: { matchLabels: { app: headscale-router } }
  template:
    metadata: { labels: { app: headscale-router } }
    spec:
      containers:
        - name: router
          image: tailscale/tailscale:v1.66
          env:
            - { name: TS_ROUTES, value: "10.43.0.0/16" }
            - { name: TS_STATE_DIR, value: "/var/lib/tailscale" }
          volumeMounts:
            - { name: state, mountPath: /var/lib/tailscale }
      volumes:
        - { name: state, emptyDir: {} }
EOF
decide "2026-04-03T09:00:00+07:00" "platform(coder): headscale-router advertises the cluster subnet" \
  "Decision: a headscale subnet router advertises 10.43.0.0/16 into the tailnet, so the VPS edge can reach Coder and other in-cluster services over the single existing VPS hop rather than a second public IP" \
  "Reversible: true" "Oracle: test"
P6_ROUTER_DEPLOY=$(git rev-parse HEAD)
incident "$P6_ROUTER_DEPLOY" "2026-04-03T21:00:00+07:00" open "coder.ba-ailab.com shows blank pages; browser console bursts of 502 Bad Gateway on /assets/*.js|css. Root cause: the router pod's emptyDir tailscale state does not survive a restart, so every restart registers a NEW headscale node and orphans the old one, which still advertises 10.43.0.0/16 and can be pinned Primary as a dead ghost, blackholing the route"
ran "$P6_ROUTER_DEPLOY" "2026-04-03T21:05:00+07:00" fail INC-2026-041

w platform/coder/router-deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: headscale-router, namespace: headscale }
spec:
  serviceName: headscale-router
  replicas: 1
  selector: { matchLabels: { app: headscale-router } }
  template:
    metadata: { labels: { app: headscale-router } }
    spec:
      containers:
        - name: router
          image: tailscale/tailscale:v1.66
          env:
            - { name: TS_ROUTES, value: "10.43.0.0/16" }
            - { name: TS_STATE_DIR, value: "/var/lib/tailscale" }
          volumeMounts:
            - { name: state, mountPath: /var/lib/tailscale }
  volumeClaimTemplates:
    - metadata: { name: state }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 1Gi } }
EOF
decide "2026-04-04T09:00:00+07:00" "platform(coder): persist the router's tailscale identity" \
  "Decision: headscale-router runs as a StatefulSet with a PVC for its tailscale state, so a pod restart reuses one node identity instead of registering a fresh ghost every time" \
  "Rejected: an ephemeral auth key that lets headscale auto-reap disconnected nodes (does not stop a stale route briefly winning Primary before it is reaped, and the blackhole window is exactly what breaks a 50-request asset burst)" \
  "Reversible: restore-only" "Oracle: drift"
P6_CODER_GHOST=$(git rev-parse HEAD)
ran "$P6_CODER_GHOST" "2026-04-04T09:10:00+07:00" pass
incident "$P6_ROUTER_DEPLOY" "2026-04-04T09:15:00+07:00" closed "fixed by giving headscale-router persistent PVC-backed tailscale state after deleting the accumulated ghost nodes; verified 6/6 200s on repeated asset requests"

w infra/terraform/live/headscale/dns.tf <<'EOF'
resource "kubernetes_config_map" "coredns_headscale_rewrite" {
  metadata { name = "coredns-custom"; namespace = "kube-system" }
  data = {
    "headscale.server" = <<-COREDNS
      headscale.ba-ailab.com:53 {
        rewrite name exact headscale.ba-ailab.com traefik.traefik.svc.cluster.local
        forward . 10.43.0.10
      }
    COREDNS
  }
}
EOF
decide "2026-04-08T09:00:00+07:00" "infra(headscale): CoreDNS rewrite for in-cluster clients" \
  "Decision: in-cluster clients resolve headscale.ba-ailab.com via a CoreDNS rewrite straight to the Traefik Service, because the public name otherwise hairpins a pod out through the VPS and back — measured at a 20s stall on the return leg, intermittent enough that it looked like unrelated flakiness rather than a DNS problem" \
  "Rejected: leaving in-cluster clients on public DNS and treating the occasional 20s stall as acceptable jitter (it silently broke every consumer of this hostname, not just headscale)" \
  "Reversible: true" "Oracle: test"
P6_COREDNS_REWRITE=$(git rev-parse HEAD)

git rm -q infra/edge/vps-edge.tf
decide "2026-04-10T18:00:00+07:00" "infra(headscale): retire the Terraform-managed VPS vhost" \
  "Decision: the Terraform-managed grey-cloud vhost is deleted now that the CoreDNS rewrite serves every in-cluster client directly and the router no longer depends on this path — keeping an unused duplicate of the docker-managed VPS Caddy config doubles the failure surface for no traffic it still carries" \
  "Reversible: never" "Oracle: drift"
P6_RETIRE_VPS_EDGE=$(git rev-parse HEAD)

# ═══════════════════════════════════════════ phase 7: the data platform
# Real incidents: Kafka Connect tasks that never self-heal (2026-06-12,
# feedback_kafka_connect_failed_tasks), the Airflow triggerer's 13-day,
# 3311-restart crash loop (feedback_airflow_triggerer_liveness_cpu_starve),
# dbt-on-Kyuubi's driver-memory default (feedback_dbt_kyuubi_driver_oom_stability),
# and Trino's SDK v2 vs old-MinIO Content-MD5 mismatch on bulk delete
# (feedback_trino_minio_deleteobjects_md5). One real supersede chain: Kafka
# Connect's manual-restart runbook is superseded by autoRestart once the
# operational cost of the manual path became clear.

w platform/data/kafka-connect/iceberg-sink.yaml <<'EOF'
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata: { name: iceberg-sink-batdongsan-v2, namespace: streaming }
spec:
  class: io.tabular.iceberg.connect.IcebergSinkConnector
  tasksMax: 1
  config:
    iceberg.catalog.type: hive
    topics: batdongsan.listings.v2
EOF
decide "2026-04-11T09:00:00+07:00" "platform(kafka-connect): recover FAILED Iceberg sink tasks by hand" \
  "Decision: a FAILED Connect task is restarted manually via the REST API (POST /connectors/<n>/tasks/0/restart), because Strimzi never retries a task that threw an unrecoverable exception on its own" \
  "Rejected: waiting for the operator to notice, since a FAILED task sits there indefinitely with no automatic path back to RUNNING" \
  "Reversible: true" "Oracle: test"
P7_CONNECT_MANUAL=$(git rev-parse HEAD)
ran "$P7_CONNECT_MANUAL" "2026-06-12T08:00:00Z" fail INC-2026-KC12
incident "$P7_CONNECT_MANUAL" "2026-06-12T08:10:00Z" closed "4 Iceberg sink connectors (batdongsan, homedy, v1+v2) had task 0 FAILED since the MinIO migration with Connection refused minio.platform.svc:9000; the KafkaConnector CRs carried NO status at all, so even a task restart could not touch them. Fixed by deleting the wedged CRs and letting ArgoCD selfHeal recreate them — offsets live in Kafka, no data loss."

sed -i '/tasksMax: 1/a\  autoRestart: { enabled: true, maxRestarts: 10 }' platform/data/kafka-connect/iceberg-sink.yaml
GIT_AUTHOR_DATE="2026-04-12T10:00:00+07:00" GIT_COMMITTER_DATE="2026-04-12T10:00:00+07:00" \
  "$CTX" supersede "$P7_CONNECT_MANUAL" -reason "the 2026-06-12 outage showed the manual runbook has no answer for a CR that wedges with no status at all, and a human has to be paged every time a task throws; autoRestart makes Strimzi self-heal the ordinary case" >/dev/null
decide "2026-04-12T10:05:00+07:00" "platform(kafka-connect): make FAILED tasks self-heal with autoRestart" \
  "Decision: every Iceberg sink connector sets spec.autoRestart.enabled: true, so an unrecoverable task exception heals itself instead of paging a human" \
  "Rejected: keep the manual restart runbook, which does not scale past a handful of connectors and has no answer for a fully wedged CR" \
  "Reversible: true" "Oracle: drift"
P7_CONNECT_AUTORESTART=$(git rev-parse HEAD)
ran "$P7_CONNECT_AUTORESTART" "2026-06-13T09:00:00Z" pass

w platform/data/airflow/values.yaml <<'EOF'
triggerer:
  resources:
    requests: { cpu: 500m, memory: 1Gi }
    limits:   { cpu: "1", memory: 2Gi }
scheduler:
  resources:
    requests: { cpu: 500m, memory: 1Gi }
    limits:   { cpu: "1", memory: 2Gi }
EOF
decide "2026-04-14T09:00:00+07:00" "platform(airflow): match the triggerer's CPU limit to the scheduler's" \
  "Decision: triggerer.resources goes from 250m/500m to 500m/1000m CPU, matching the scheduler, which runs the identical liveness probe shape and has been stable at that limit for 43 days" \
  "Rejected: tuning the liveness probe's timeoutSeconds instead, which would not fix the actual cause: the probe cold-starts the full Airflow CLI and shares the throttled cgroup with the process it is checking, so a looser timeout just delays the same starvation" \
  "Reversible: true" "Oracle: test"
P7_TRIGGERER_CPU=$(git rev-parse HEAD)
ran "$P7_TRIGGERER_CPU" "2026-04-13T09:06:06Z" fail INC-2026-AF13
incident "$P7_TRIGGERER_CPU" "2026-04-13T09:11:05Z" closed "airflow-triggerer-0 in CrashLoopBackOff for 13 days, 3311 restarts, killed on an almost exact 5-minute cycle with exitCode 0 (kubelet killing it on purpose, not a crash). The exec liveness probe timed out at 61.8s against a 20s budget under the 500m limit; raising the limit to match the scheduler brought the same probe down to 9.3s. Pod stayed up past the old 5-minute kill point with 0 restarts."
ran "$P7_TRIGGERER_CPU" "2026-04-14T09:10:00Z" pass

w platform/data/dbt/profiles.yml <<'EOF'
data_platform:
  target: prod
  outputs:
    prod:
      type: spark
      method: hive
      server_side_parameters:
        spark.driver.memory: "{{ env_var('DBT_SPARK_DRIVER_MEM', '1g') }}"
        spark.driver.memoryOverhead: "1g"
        spark.sql.adaptive.enabled: "true"
        spark.sql.adaptive.coalescePartitions.enabled: "true"
        spark.sql.adaptive.skewJoin.enabled: "true"
EOF
decide "2026-04-16T11:00:00+07:00" "platform(dbt): set spark.driver.memory explicitly instead of Kyuubi's ~1g default" \
  "Decision: server_side_parameters now sets spark.driver.memory (default 1g, DBT_SPARK_DRIVER_MEM overrides per model) plus adaptive query execution, because the profile only ever exposed executor memory and the driver silently ran at Kyuubi's tiny default" \
  "Rejected: bumping executor memory further, which does nothing when the driver is the one collecting the wide join and dying" \
  "Reversible: true" "Oracle: test"
P7_DBT_DRIVER_MEM=$(git rev-parse HEAD)
ran "$P7_DBT_DRIVER_MEM" "2026-04-15T02:00:00Z" fail INC-2026-DBT15
incident "$P7_DBT_DRIVER_MEM" "2026-04-15T02:05:00Z" closed "silver_realestate randomly red-failed with driver OOM on a wide select l.* fold-key join over ~300k rows; the driver ran at Kyuubi's ~1g default the whole time because only executor memory was ever tunable. driver_mem=4g plus AQE fixed the heavy build; everything else stayed at the 1g default."
ran "$P7_DBT_DRIVER_MEM" "2026-04-16T03:00:00Z" pass

w platform/data/trino/values.yaml <<'EOF'
coordinator:
  env:
    - { name: AWS_REQUEST_CHECKSUM_CALCULATION, value: when_required }
    - { name: AWS_RESPONSE_CHECKSUM_VALIDATION, value: when_required }
worker:
  env:
    - { name: AWS_REQUEST_CHECKSUM_CALCULATION, value: when_required }
    - { name: AWS_RESPONSE_CHECKSUM_VALIDATION, value: when_required }
EOF
decide "2026-04-19T13:30:00+07:00" "platform(trino): stop sending checksums the lab MinIO cannot read" \
  "Decision: AWS_REQUEST_CHECKSUM_CALCULATION=when_required on every Trino node, so the SDK falls back to Content-MD5 on bulk delete instead of the CRC32 header a year-old MinIO release does not accept" \
  "Rejected: chasing this as an IAM problem, which it was not — mc rm works fine with the same credentials because mc sends Content-MD5 itself" \
  "Reversible: true" "Oracle: contract"
P7_TRINO_CHECKSUM=$(git rev-parse HEAD)
incident "$P7_TRINO_CHECKSUM" "2026-04-18T10:00:00Z" closed "Iceberg DROP TABLE and expire_snapshots failed ICEBERG_FILESYSTEM_ERROR / Failed to delete directory; the coordinator log's real cause was S3Exception Missing required header Content-Md5 (400) from AWS SDK v2's DeleteObjects call against MinIO RELEASE.2024-04-18, which still requires the legacy header for bulk delete."
ran "$P7_TRINO_CHECKSUM" "2026-04-19T14:00:00Z" pass

# ═══════════════════════════════════════════ phase 8: GitOps and CI
# Real incidents: kaniko cannot run `npm ci` at any usable speed
# (feedback_kaniko_npm_build_timeout — ReadyX's first React build), a runner
# config that lied about the cluster's capacity through ten different-looking
# failures (feedback-gitlab-runner-resource-lies), ArgoCD's annotation-based
# tracking silently adopting and pruning orphaned resources on a reused app
# name (feedback_argocd_annotation_tracking_prune), and Atlantis needing its
# config file at the repo root (feedback_atlantis_opentofu_bringup). The
# kaniko fix is a genuine rename-with-edit: the file moves AND is restructured
# in the same commit, which drops well below git's default rename-similarity
# threshold — the exact case ctx's tombstone recovery had to be fixed for.

w platform/ci/build.yaml <<'EOF'
build-app:
  stage: build
  image: gcr.io/kaniko-project/executor:latest
  script:
    - /kaniko/executor --dockerfile Dockerfile --destination $CI_REGISTRY_IMAGE
  # Dockerfile RUNs `npm ci` inside the kaniko build itself.
EOF
decide "2026-04-21T09:00:00+07:00" "platform(ci): build the frontend inside kaniko" \
  "Decision: the Dockerfile runs npm ci directly inside the kaniko build stage, which looked like the simplest single-file pipeline for a React/Vite app" \
  "Reversible: true" "Oracle: test"
P8_CI_NAIVE=$(git rev-parse HEAD)
ran "$P8_CI_NAIVE" "2026-04-21T09:30:00Z" fail INC-2026-CI21
incident "$P8_CI_NAIVE" "2026-04-21T09:35:00Z" closed "the first React build hit the 20-minute job timeout still mid npm-ci in the build stage, never reaching vite build. npm ci took 31s on a normal filesystem and was still running past 18 minutes inside kaniko: kaniko snapshots the whole filesystem after every layer, and tens of thousands of small node_modules files makes that pathologically slow. Multi-stage does not help, because the FIRST npm ci is the one that kills it regardless of which stage it sits in."

git mv platform/ci/build.yaml platform/ci/pipeline.yaml
w platform/ci/pipeline.yaml <<'EOF'
build-spa:
  stage: build
  image: node:22-alpine
  script:
    - npm ci
    - npm run build
    - npm prune --omit=dev
  artifacts:
    paths: [dist/, node_modules/]

build-app:
  stage: package
  needs: [build-spa]
  image: gcr.io/kaniko-project/executor:latest
  script:
    - >
      /kaniko/executor --dockerfile Dockerfile --destination $CI_REGISTRY_IMAGE
      --snapshot-mode=redo
  # Dockerfile is now pure file assembly: COPY node_modules dist server data js.
  # No npm inside kaniko at all.

deploy:
  stage: deploy
  needs: [build-app]
  script: [echo deploying]
EOF
decide "2026-04-22T10:00:00+07:00" "platform(ci): split the frontend build out of kaniko entirely" \
  "Decision: a real Node job builds and prunes the SPA first; kaniko's only job is COPYing the finished dist/ and pruned node_modules/ into an image, with no npm invocation of its own" \
  "Rejected: a multi-stage Dockerfile still run through kaniko, which does not help because the killer is the first npm ci regardless of which Docker stage it lives in" \
  "Reversible: true" "Oracle: test"
P8_CI_SPLIT=$(git rev-parse HEAD)
ran "$P8_CI_SPLIT" "2026-04-22T10:20:00Z" pass

w platform/ci/gitlab-runner.yaml <<'EOF'
runners:
  config: |
    [[runners]]
      [runners.kubernetes]
        memory_request = "1Gi"
        memory_limit = "8Gi"
        memory_request_overwrite_max_allowed = "16Gi"
        memory_limit_overwrite_max_allowed = "24Gi"
        ephemeral_storage_request = "4Gi"
        ephemeral_storage_limit = "20Gi"
        ephemeral_storage_request_overwrite_max_allowed = "40Gi"
        node_tolerations_overwrite_allowed = ".*"
EOF
decide "2026-04-25T09:00:00+07:00" "platform(ci): stop lying to the kubelet about what a build needs" \
  "Decision: the runner requests real resources (memory 1Gi, ephemeral storage declared and bounded, overwrite ceilings raised to 24Gi) instead of a 256Mi profile that matched nothing any real build does" \
  "Rejected: tuning each failing job after the fact, which chased ten different-looking symptoms (OOM-evicted, disk-evicted, unschedulable, apk error, rejected at prepare) that were all the same runner-config lie" \
  "Reversible: restore-only" "Oracle: drift"
P8_RUNNER_RESOURCES=$(git rev-parse HEAD)
incident "$P8_RUNNER_RESOURCES" "2026-04-24T14:00:00Z" closed "one image build failed ten times in a row with a different-looking cause each time; nine of the ten were the same root problem. A build using 6.9GB against a 256Mi request got evicted by usage-over-request ranking AND took the node NotReady with it, crash-looping an unrelated tenant's database. ephemeral_storage was not declared at all, so concurrent kaniko unpacks pushed nodes past their eviction threshold independently of memory."
ran "$P8_RUNNER_RESOURCES" "2026-04-25T09:30:00Z" pass

w infra/platform/apps/cert-manager-config.yaml <<'EOF'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: cert-manager-config, namespace: argocd }
spec:
  project: default
  source: { path: platform/secrets/cert-manager }
  destination: { server: https://kubernetes.default.svc, namespace: cert-manager }
  syncPolicy: { automated: { prune: true, selfHeal: true } }
EOF
decide "2026-04-27T11:00:00+07:00" "infra(argocd): check tracking-id before reusing an Application name" \
  "Decision: before applying any Application, grep the cluster for its tracking-id first, because ArgoCD here tracks resources by the argocd.argoproj.io/tracking-id annotation rather than the instance label, and a new Application with an old name silently adopts and prunes whatever orphaned resources still carry that id" \
  "Rejected: trusting the sync diff to show what would be deleted, since an adopted orphan is absent from the new desired state and therefore invisible in the plan" \
  "Reversible: never" "Oracle: drift"
P8_ARGOCD_TRACKING=$(git rev-parse HEAD)
incident "$P8_ARGOCD_TRACKING" "2026-04-27T11:05:00Z" closed "adding this Application would have adopted three resources left behind by a previous incarnation of the same name: two ClusterIssuers and a wildcard Certificate. Deleting the issuers was intended (the CDN in front of them was retired), but seven other Certificates still referenced letsencrypt-cloudflare for renewal — an unreviewed prune of it would have quietly broken their renewal path. Caught by checking tracking-id before merge; nothing was deleted."

w atlantis.yaml <<'EOF'
version: 3
projects:
  - name: vault
    dir: infra/terraform/live/vault
    workflow: opentofu
    when_modified: ["*.tf", "../../modules/**/*.tf"]
workflows:
  opentofu: { plan: { steps: [init, plan] }, apply: { steps: [apply] } }
EOF
decide "2026-04-29T09:00:00+07:00" "infra(atlantis): keep atlantis.yaml at the repo root" \
  "Decision: atlantis.yaml lives at the repo root, not nested under infra/, because Atlantis falls back to its default workflow with no Vault login and no custom backend when it cannot find the file there — logged as one quiet line, not an error" \
  "Rejected: infra/atlantis.yaml, which is where the rest of the Terraform layout would suggest it belongs" \
  "Reversible: true" "Oracle: test"
P8_ATLANTIS_ROOT=$(git rev-parse HEAD)
ran "$P8_ATLANTIS_ROOT" "2026-04-29T09:30:00Z" pass

# ------------------------------------------------------------ walkthrough
cat > DEMO.md <<'DEMOEOF'
# ctx-demo — a GitOps monorepo, and its own SDLC

Not a toy. 87 commits, 6 services with kustomize base+overlays, terraform live
stacks, platform components, ArgoCD Applications — and every real incident
dramatized here actually happened at ai-lab. Rebuild it any time with
`../ctx/build-ctx-demo.sh`; nothing here is hand-edited, so nothing can drift
from what `ctx` reports.

Read this as a lifecycle, not a feature list: **design → build → operate**,
with `ctx` as the thing that keeps operate's lessons attached to the code
design produced.

## Design: decisions before code

The first commits are architecture, not implementation — a k3s API bound to a
LAN VIP, a single Traefik pinned to one node, Vault Secrets Operator over the
sidecar injector, one CNPG cluster for every platform database:

```sh
ctx for infra/terraform/live/k3s/main.tf
```

`reversible: never`, `oracle: drift` — this is a one-way door, and a
reconciler is what will notice if it slips. This is what "AI-ready" costs at
setup:

```sh
ctx init -hooks
git config --add ctx.gate.path platform    # and infra/terraform, clusters
```

## Build: apps, at real width

Six services (`api web worker ingest scheduler notifier`), each a kustomize
base with staging/prod overlays and an ArgoCD Application:

```sh
ctx for apps/api/base/deployment.yaml
```

Interleaved with routine noise — six `chore: bump image` commits nobody needs
to justify. Not every commit is a decision; the gate only requires one on
`platform/`, `infra/terraform/`, and `clusters/`.

## Operate: four real incidents, four different shapes

This is the part a demo repo usually fakes. These didn't:

### A decision superseded — MinIO on iSCSI, twice

```sh
ctx for platform/storage/minio-iscsi/pod-recovery.md
```

The first fix (delete the pod) assumed a stale mount. It recurred with a dead
transport instead, and a pod delete just jammed the reschedule on
Multi-Attach. `ctx supersede` retired the first fix on the record, with the
distinction between the two failure modes as the reason — not silently
overwritten.

### A decision orphaned — the GPU device plugin, rewritten without review

```sh
ctx for platform/gpu/device-plugin/values.yaml -all
```

A runtimeClassName pin, adopted after a real crashloop, was later replaced
wholesale by the GPU Operator's ClusterPolicy. Nobody ran `ctx supersede` —
the file was just rewritten. The old decision owns no surviving line and
shows up as `orphaned`, not `superseded`: nobody decided it was wrong, its
code just stopped existing.

### A decision removed — the VPS edge, retired for good

```sh
ctx for infra/edge/vps-edge.tf
```

No error on a deleted path. `removed:` names the commit, the date, and why:
the CoreDNS rewrite made the VPS hop unnecessary. `orphaned` underneath it
carries the file's whole prior life — the grey-cloud DNS decision, the forced
HTTP/1.1 workaround — the full story of a system before it was retired.

### A decision renamed — the CI pipeline that had to change shape

```sh
ctx for platform/ci/build.yaml
```

kaniko cannot run `npm ci` at a usable speed. The fix isn't a small patch —
it's a rename plus a real content rewrite in the same commit, splitting the
build into a real Node stage and a kaniko assembly stage. `removed.renamed_to`
points at `platform/ci/pipeline.yaml`; querying that path shows the decision
active there, not orphaned.

## What an agent gets without asking

Try to re-create `infra/edge/vps-edge.tf`. With the Claude Code hook
installed, the `removed:` block above arrives before the write lands — nobody
had to remember to run `ctx for` first.

```sh
git checkout -q -- . 2>/dev/null   # undo any scratch edits from trying this
```

## The gate, live

```sh
echo "resource {}" >> infra/terraform/live/k3s/main.tf && git add -A
echo "infra: tweak" > /tmp/msg && ctx gate -m /tmp/msg
git reset -q --hard HEAD           # undo the scratch edit
```

Blocked: gated path, no `Decision:`. This is what stands between an agent and
committing exactly the kind of undecided change every incident above started
as.

DEMOEOF
git add DEMO.md
GIT_AUTHOR_DATE="2026-04-30T18:30:00+07:00" GIT_COMMITTER_DATE="2026-04-30T18:30:00+07:00" \
  git commit -q -m "docs: add the walkthrough" \
  --trailer "Decision:the walkthrough is generated by this script, not hand-maintained, so it can never describe a scope this repo does not actually have"

say "ctx reindex (rebuild refs/notes/decisions from the trailers)"
"$CTX" reindex

say "history"
git log --oneline --all | tail -30
echo "  ... $(git rev-list --count --all) commits total"

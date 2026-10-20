# Jira ↔ GitHub Actions — luồng vận hành

Jira = việc. GitHub **Pull Request** = **log phiên bản** (Files changed, git log, CI `note-pr`).  
`docs/` chỉ map ổn định. **Không** tạo markdown theo ticket.

**Onboard / versioning / Actions (đọc trước khi code):** [GIT-AND-CI.md](./GIT-AND-CI.md)  
**Cây dự án + layer + role:** [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Canonical CI/CD:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) trên  
https://github.com/Royal2005-coder/Velura-Angular  

GitLab (`.gitlab-ci.yml`) là **legacy** — không dùng cho team; hết phút shared runner.

```
Jira KAN-n
  → git checkout develop && git pull
  → feature/KAN-n-short
  → commit "KAN-n why"
  → PR vào develop (title bắt đầu KAN-n)
  → CI: validate + test-api + test-angular + build + note-pr
  → Merge develop khi required CI xanh; CODEOWNERS/tag để thông báo
  → Push develop: cùng cổng test/build — không deploy
  → PR develop → main (source/target đủ; title promote nên `KAN-n: …`)
  → publish scanned/signed image digests → reviewed production-pins PR
  → promote develop → main → Flux root/production → runtime verification
  → Jira Close + comment URL PR
```

Cấm: feature → `main`. Cấm `[skip ci]`. Cấm ADR.md cho bug thường. Cấm GitHub/GitLab Issues làm backlog (chỉ Jira **KAN**).

## Trace

```bash
git fetch origin refs/notes/commits:refs/notes/commits
git log --oneline --show-notes --grep=KAN-n
git show --stat <sha>
git diff develop...HEAD --stat
```

GitHub: PR (`## Why`) + Files changed + job `note-pr` (comment + artifact `pr-trace.md`).

## Jobs (GitHub Actions)

`validate-pr-contract` **chỉ** chạy trên Pull Request. Feature → `develop`: title `KAN-n` + `## Why`. Promote `develop` → `main`: chỉ cần đúng hai nhánh (why đã nằm trong git log feature). Feature → `main` cấm. Sửa title/body trên GitHub; không tạo `docs/KAN-n.md`; lỗi validate **không** phải SSH key.

| Khi | Jobs | Deploy |
|---|---|---|
| PR → `develop` | validate, tests, build, **note-pr** | Không |
| Push `develop` | validate, tests, build | Integration only; không có môi trường staging |
| PR `develop` → `main` | cùng cổng PR; production pins require signed-main evidence | Không |
| Push `main` | tests + build + manifests; publish when app changes | Flux production follows reviewed production pins; no CI cluster mutation |

`note-pr` bắt buộc xanh. Trace = job log + artifact `pr-trace.md` + comment trên PR.

MVP chỉ có production cho storefront/admin/API. Staging không nằm trong release
path; overlay cũ được giữ làm tài liệu thử nghiệm, không có Flux owner hoạt động.
Phê duyệt release bằng PR, không bằng restart/resume mỗi lần. CI không giữ kubeconfig.

## Admin TMĐT — cơ sở đúng

Chuẩn phân hệ lấy từ Vendure (catalog, orders, customers, marketing, settings) nhưng **runtime là Angular + Node**. Mỗi màn `admin-ng` phải thỏa 8 điểm trong [COMPLIANCE.md](./COMPLIANCE.md) (list server-paged, detail, mutation có version, audit, RBAC từ `/api/auth/me`, MVVM, lazy route, test empty/error).

Luồng shop ↔ admin: sửa catalog/giá/KM trên admin → storefront đọc cùng API. Không page-builder. CMS nội dung (`/api/content`) hoãn đến khi catalog/orders đúng hợp đồng.

<a id="k3s-staging-first-runbook"></a>

## K3s production MVP runbook

The inspected host is one Ubuntu 20.04 / K3s 1.30 node with 15 GiB RAM and an
RTX 4060 (8188 MiB VRAM). This is not HA. Supported OS/K3s maintenance, secret
encryption, audit retention, private management access, alert delivery and
offsite restore evidence remain production requirements, not properties proved
by YAML. Do not upgrade/reboot or migrate a production database in this procedure.

### Artifacts and deployment ownership

- CI `deploy-production` publishes API, storefront, admin and worker images,
  scans exact digests, emits SPDX SBOM/provenance and signs/attests releases.
  The production-pins PR targets `develop`, records the successful main publisher
  run/attempt and requires exact Cosign identities. Owner promotion of `develop`
  to `main` releases those pins without rebuilding them. SHA tags alone are
  not deployment evidence.
- The worker Dockerfile requires an immutable Python 3.11 base supplied by CI
  from the real registry. `requirements-production.txt` pins CUDA 12.1 Torch and
  CPU-only ONNX dependencies; the image retains installed dependency versions
  and the blob-verified FASHN source LICENSE/NOTICE.
- Flux `velura-root` owns `deploy/k8s/clusters/production` from `main`: the Git
  source and Flux owner specifications. It does not wait on dependent children.
  Flux `velura-infra` owns `deploy/k8s/overlays/infrastructure` from `main`:
  namespaces, isolation, database, auth, storage, networking and observability.
  Flux `velura-production` owns only the three production apps and their
  ConfigMap/PVC/Services and namespace-local encrypted credentials. App releases
  cannot implicitly upgrade platform services. All three inventories are separate.
- The infrastructure overlay preserves `database/postgres-pvc`. CNPG
  `database/cutover` stays opt-in: require a maintenance-approved export,
  restore drill, Keycloak integrity check and service switch. Never reuse
  a PostgreSQL data directory for a different major version.
- Platform/root reconciliation is enabled. Production retains its one-time
  bootstrap gate until signed-main pins are provisioned; the pins PR sets
  `suspend: false` and root Flux applies it. Both backup CronJobs remain suspended
  until restore drills.
  Resume each Flux owner only after reviewing its live drift and prerequisites;
  keep normal reconciliation enabled afterward. Do not resume backup schedules
  until external credentials and restore evidence are ready.
- App ConfigMaps are generated with content hashes; references in Deployments
  change with configuration, so Flux does not need a manual restart.
- Terraform owns external Cloudflare DNS, not Kubernetes or tunnel credentials.
  Atlantis plans existing-record imports against locked remote state; apply
  requires approval, mergeability and an undiverged PR. See
  [external ownership](./CLOUDFLARE-SUPABASE.md).

### Local checks for the integration owner

Prerequisites: Node 22, Python 3.11, Kustomize 5.6, Mike Farah yq v4,
yamllint, kubeconform and reviewed schemas for non-core resources. CI installs
its parser/render dependencies explicitly and rejects duplicate mapping keys,
including embedded YAML ConfigMaps. These commands have no cluster mutation:

```bash
node --test tools/ops/velura-ops.test.mjs
python -m pip install -r apps/ai-worker/requirements-test.txt
python -m unittest discover -s apps/ai-worker -p 'test_*.py'
node tools/ops/velura-ops.mjs render --path deploy/k8s/clusters/production
node tools/ops/velura-ops.mjs render --path deploy/k8s/overlays/production
node tools/ops/velura-ops.mjs render --path deploy/k8s/overlays/infrastructure
node tools/ops/velura-ops.mjs validate --path deploy/k8s/overlays/production
node tools/ops/velura-ops.mjs validate --path deploy/k8s/overlays/infrastructure
```

Strict policy validation intentionally rejects mutable upstream/app images.
Resolve each upstream image to a real reviewed registry digest and merge the
CI-generated app digest PR before declaring this check passed. No digest is
invented in the repository.

### One-time production bootstrap

Use a TLS-verified explicit context for the known cluster; never the workstation
default context. Obtain its `kube-system` UID from the approved inventory and
set `CLUSTER_UID`, `APPROVED_CONTEXT` and the full 40-hex `APPROVED_SHA`.
Provision secrets through SOPS age-encrypted Git resources or protected
out-of-repository files; retain the age recovery key outside this VM.
Root bootstrap is performed once after the reviewed configuration reaches main:

```bash
kubectl --context "$APPROVED_CONTEXT" apply -k deploy/k8s/clusters/production
```

The app uses the real production Supabase gateway, not local Keycloak PostgreSQL.
Platform and production namespace Secrets must have real credentials and a
matching verification token before the first pins release. No staging database
or staging credentials are prerequisites. Check the existing production schema
without writes:

```bash
node scripts/run-migrations.mjs --check --require-chatbot-schema
```

Production migrations remain an explicit owner-approved operation; skipping
staging does not authorize implicit schema writes. Read-only checks require trusted
`SUPABASE_DB_URL` / `SUPABASE_DB_CA_CERT`; missing CA is not permission to
disable TLS. Provision real per-application gateway keys and worker auth
separately. The VTO catalog must also have reviewed `verified:true`,
`photo_type:'flat-lay'`, supported category and exact `variant_images` mapping;
`AI_CATALOG_IMAGE_HOSTS` must name the exact approved HTTPS source hosts.
No primary-image/variant fallback or auto-generated studio selection supplies
missing catalog approval. `AI_ENABLE=false` disables uploads and inference.

Bootstrap the root overlay only after reviewed manifests exist on main.
Public Git read needs no token; private sources
need a real `secretRef`. Configure SOPS decryption only when encrypted Secret
resources and the independently held recovery key are actually provisioned.

#### Encrypted Secret ownership

`.sops.yaml` defines separate cluster and recovery age recipients. Platform
Secret ciphertext lives in `deploy/k8s/base/secrets`; the infrastructure overlay
is its only reconciliation owner. All Secret payload values must be SOPS
ciphertext, not base64-only data. CI checks ciphertext structure and recipient
policy without receiving any decryption identity. It does not certify the MAC;
verify round-trips with both identities before the initial ownership transfer.

Bootstrap the cluster identity as `flux-system/sops-age` with key `age.agekey`;
each Flux Kustomization references this Secret through `spec.decryption`.
Private age identities and workstation recovery exports never belong in Git.
Retain the recovery identity independently from the VM. A Windows DPAPI export
requires that Windows user's profile to recover; move the encrypted export from
temporary storage into the owner's durable backup custody before relying on it
for disaster recovery. The cluster key alone is not an independent backup.

`deploy/k8s/secrets/production` contains an encrypted production Secret snapshot
but is deliberately not referenced by the production overlay during its legacy
bootstrap. The reviewed signed-main pins release activates that resource.
Referenced Secrets
are annotated `prune: disabled`; retiring credentials requires explicit owner
rotation/deletion rather than incidental pruning. Changing environment-backed
credentials also requires a reviewed pod-template rollout, not merely a Secret
update. Keep plaintext out of command output and GitHub Actions logs.

Root reconciliation owns the source and owner specifications, including itself.
Infrastructure reconciliation defaults to enabled; production `suspend: true`
is only a bootstrap gate. Publisher evidence authorizes the pins PR to set it
false, then root Flux applies the change automatically. Keep it enabled afterward.
Before transferring ownership, inspect the existing Flux inventory: orphan
resources moving between owners before removing them from the old owner's
inventory; never let `prune` delete a transferred app/PVC. Dry-run the platform
changes and provision its referenced Secrets first. A Keycloak major upgrade
or hostPath-to-PVC data move needs separate maintenance/restore approval.

The manifest CI gate checks conflicting env/probe fields and namespace budgets
against concurrent Deployment rollout surge, including LimitRange defaults.
Resource quotas must admit replacements while old serving pods remain. A
single-node stateful `Recreate` workload reserves only its serving replicas;
its restore evidence and brief maintenance downtime remain separate concerns.
When adopting client-side-applied bootstrap resources, a successful client-side
dry-run does not prove Flux SSA can remove fields owned by another manager.
Inspect live managed fields and complete the reviewed ownership transfer before
enabling continuous reconciliation. Do not repeat this transfer for releases.

`velura-repo` tracks main. Do not pin the continuously reconciled source to a
fixed commit or feature branch. Following the first signed-pins promotion:

```bash
node tools/ops/velura-ops.mjs status --context "$APPROVED_CONTEXT" --expected-cluster "$CLUSTER_UID"
node tools/ops/velura-ops.mjs health --context "$APPROVED_CONTEXT" --expected-cluster "$CLUSTER_UID" --namespace velura
```

`reconcile` without `--execute` is read-only. It requires the environment branch
to have fetched exactly `APPROVED_SHA`; execution additionally requires an
unexpired matching `--approval`. It annotates only the selected app
Kustomization and cannot unsuspend anything. Normal release convergence needs
no annotation: Flux polls its approved branch.

The protected `/api/ops/revision` checks database/gateway/schema readiness and
requires configured revision to match the image-baked `buildRevision`.
Frontend `/release.json` comes from the image and is served without caching.
These HTTP checks do not prove Flux convergence or pod image digests; use the
owner CLI for that evidence.

`cloudflared-ingress-contract` is a route contract, not the running config.
The active tunnel reads the protected `networking/cloudflare-tunnel-config`
Secret. Cloudflared does not substitute the contract's parameter notation.
Public MVP storefront stays public; admin is authenticated by the application's
Supabase/RBAC layer and ops verification additionally requires its Bearer token.
When the owner enables edge Access, provision real application audiences and
service tokens, render their values and set `VELURA_CF_ACCESS_ENABLED=true`.
Placeholders cannot satisfy that enabled gate. Production verification is enabled
with `VELURA_VERIFY_PRODUCTION=true`; root Flux controls reconciliation state.

### Licensed worker provisioning and isolated smoke

The real worker is excluded from both default overlays. Its optional
`deploy/k8s/optional/ai-worker` overlay uses namespace `ai-staging`, ClusterIP,
API-only ingress, no egress, non-root/read-only containers, two private PVCs,
one NVIDIA GPU request and `Recreate`. A separate release PR replaces image
references with the signed digest without changing the replica count or
including the worker in app reconciliation. Registry pulls use `IfNotPresent`,
not the legacy local-image-only `Never`. Do not apply unresolved image inputs.
Provision `ai-staging/ai-worker-auth` with the same independent
staging `AI_WORKER_KEY`, verify the NVIDIA device plugin and `nvidia`
RuntimeClass. The optional weights Job mounts only the staging weights PVC and
downloads the accepted manifest through its own DNS/HTTPS policy; it is not in
the overlay's default resource list. Never mount or change production PVCs.
Provision `ai-staging/velura-registry` from a protected Docker config file
(`kubernetes.io/dockerconfigjson` Secret); both worker/provisioner reference it.

```bash
python apps/ai-worker/bootstrap_weights.py --weights-dir "$APPROVED_WEIGHTS_DIR" --accept-license-manifest velura-worker-v1
docker build --build-arg PYTHON_IMAGE="$PINNED_PYTHON_IMAGE" --build-arg RELEASE_REVISION="$APPROVED_SHA" -f deploy/docker/ai-worker/Dockerfile -t "$LOCAL_WORKER_IMAGE" .
node tools/ops/velura-ops.mjs validate --path deploy/k8s/optional/ai-worker
```

Before provisioning weights, approve a Git change setting worker replicas to
zero and confirm the old worker has stopped. The checked-in replica count is
not a safety lock. Protected auth/registry files must be mode 600:

```bash
kubectl --context "$APPROVED_CONTEXT" apply -k deploy/k8s/optional/ai-worker
kubectl --context "$APPROVED_CONTEXT" -n ai-staging create secret generic ai-worker-auth --from-env-file="$WORKER_AUTH_FILE"
kubectl --context "$APPROVED_CONTEXT" -n ai-staging create secret generic velura-registry --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$REGISTRY_CONFIG_FILE"
kubectl --context "$APPROVED_CONTEXT" apply -f deploy/k8s/optional/ai-worker/provision-weights.yaml
kubectl --context "$APPROVED_CONTEXT" -n ai-staging wait --for=condition=complete job/ai-worker-provision-weights-v1 --timeout=7200s
```

Do not overlap provisioning with a running worker or count a completed Job as
inference proof. A failed download/size/checksum is terminal and needs operator
investigation; the worker never downloads missing files at startup.

After the owner-approved one-replica Git change, run authenticated probes through
an owner-authorized loopback port forward in a separate terminal:

```bash
kubectl --context "$APPROVED_CONTEXT" -n ai-staging port-forward service/ai-worker 18000:8000
curl --silent --fail-with-body --config "$WORKER_CURL_CONFIG" http://127.0.0.1:18000/health
curl --silent --fail-with-body --config "$WORKER_CURL_CONFIG" --form "binding=<$VTO_BINDING_JSON" --form "person=@$CONSENTED_PERSON" --form "garment=@$APPROVED_FLATLAY" --form "category=$APPROVED_CATEGORY" --form garment_photo_type=flat-lay --dump-header "$PRIVATE_VTO_HEADERS" --output "$PRIVATE_VTO_OUTPUT" http://127.0.0.1:18000/ai/try-on
curl --silent --fail-with-body --config "$WORKER_CURL_CONFIG" --form "binding=<$EMBED_BINDING_JSON" --form "file=@$APPROVED_FLATLAY" http://127.0.0.1:18000/embed/image
curl --silent --fail-with-body --config "$WORKER_CURL_CONFIG" --form "binding=<$ENHANCE_BINDING_JSON" --form "file=@$APPROVED_FLATLAY" --form background=white --dump-header "$PRIVATE_ENHANCE_HEADERS" --output "$PRIVATE_ENHANCE_OUTPUT" http://127.0.0.1:18000/ai/enhance
```

`WORKER_CURL_CONFIG` contains the protected Bearer header; never put the key in
command arguments or logs. Binding files use the actual product/variant/image
and request identifiers with each endpoint's task and `velura-worker-v1`.
Inspect HTTP status/type, `X-AI-Binding`, `X-AI-Result`, finite normalized
512-dimensional embedding and images, then perform the same jobs through the
application's real authorization/queue. Direct worker smoke alone does not
prove business ownership. Delete private probe artifacts according to consent/TTL.

The bootstrap receipt records manifest SHA256 and every downloaded checksum;
startup re-verifies them offline. FASHN source/weights and DWPose/YOLOX are
Apache-2.0; U2Net is Apache-2.0; CLIP is MIT. Source revisions and artifact
license/checksum URLs are in `weights-manifest.json` and `vendor_sources.py`.
Do not install upstream `fashn-vton`: its initializer/pipeline eagerly imports
the human parser. This image assembles only the allowlisted FASHN subset and
implements segmentation-free **flat-lay only**, CPU DWPose, GPU bf16, and CPU
`ViT-B-32/laion2b_s34b_b79k` with the existing normalized 512-vector namespace.
No CatVTON or NVIDIA human parser is included.

Model licensing is distinct from runtime licensing: PyTorch/torchvision,
OpenCLIP, ONNX Runtime, OpenCV and the Python packages retain their wheel
license notices in the image. Match CI's digest-specific SPDX SBOM to
`/opt/installed-requirements.txt`, `/opt/vendor/LICENSE`, `/opt/vendor/NOTICE`
and the pinned Python base's notices. NVIDIA CUDA/cuDNN wheel binaries are
not Apache/MIT model weights; their vendor licenses/redistribution conditions
must be reviewed and accepted before publishing the worker image. The
[NVIDIA SDK/CUDA license](https://docs.nvidia.com/cuda/eula/index.html)
permits specified use/distribution subject to its requirements; preserve
packaged notices and review the exact pinned versions' terms. This use of CUDA
does not authorize the excluded noncommercial human-parser dependency.

[FASHN's pinned model card](https://huggingface.co/fashn-ai/fashn-vton-1.5/raw/7720683168567eb5a2a4c67f15116c6e29c83ded/README.md)
states approximately 8 GB VRAM. Latest live inventory reports only 6947 MiB
free, with 983 MiB occupied outside K3s: concurrent VTO fit is not proved.
Do not stop existing production AI to make room. Kubernetes `/ready` can return
200 only after a >=32-character worker key and real CPU-quality dependency
execution; partial readiness explicitly reports `models_ready:false` and only
`image_quality:true`, keeping CPU quality reachable through the Service.
GPU readiness is separate: authenticated `/health` remains 503 until verified
weights, real CLIP/ONNX execution and one full-resolution GPU CFG forward
complete. It does not claim a consented-image smoke test. Person/pose checks
fail closed without DWPose; a routable CPU-only Pod never implies VTO readiness.
The [pinned CLIP card](https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/raw/1a25a446712ba5ee05982a381eed697ef9b435cf/README.md)
describes unvalidated deployment as out-of-scope. License permission is not
task-specific validation; record safety/garment calibration evidence first.

Only after provisioning, owner review may change optional replicas to one and
include this overlay in staging GitOps. Keep `AI_ENABLE=false` until actual
authenticated `/health` plus consented person/flat-lay `/ai/try-on`,
embedding and enhancement probes succeed and negative/cancellation cases
produce finite failures. These probes must use real job/variant binding and
private image inputs, not shipped studio fixtures as acceptance substitutes.
Record measured peak VRAM, latency and output review. GPU metrics exporter and
alert delivery need independent configuration/evidence; this worker does not
advertise a nonexistent Prometheus scrape endpoint.

### Visual image index readiness and recovery

The API owns one catalog synchronizer and the existing `AiService` queue. After
queue recovery it pages at most 16 published (`on_sale`, `out_of_stock`) products
per batch, using the actual authenticated-ready CLIP worker and catalog photos.
It polls the sole job before starting another batch; a complete scan waits 60
seconds before checking image-set/`updated_at` revisions again. No customer
search starts a backfill, no user query vector enters the index, and shutdown
stops discovery/cancels its job before closing the queue.

`GET /api/ai/capabilities` with the existing product-read authorization reports
`visual_index.ready`, persisted `indexed` row count, synchronization errors and
the last completed scan's `coverage` (`published`, current-revision `indexed`,
`skipped`, `completed_at`). Coverage is a scan snapshot, not a live total;
`published - indexed - skipped` are pending infrastructure failures. Broken
catalog images are skipped for that revision for the process lifetime, not
retried by searches. Correcting catalog images changes their revision and
re-enables indexing; an authorized normal runtime catalog-index job can also
retry a repaired image. Partial coverage does not claim every SKU is searchable.

Missing storage bootstraps through normal catalog-only queue jobs into
`AI_PRIVATE_ROOT/catalog-image-vectors.json` on the persistent `ai-private-data`
PVC. Confirm the API mount, authenticated worker health, enabled/verified
`image_embedding`, then inspect capabilities until real indexed rows appear.
Do not run the local/Colab `index-catalog.ts` against production or start
another `AiService` over the mounted ledger. Do not run migration `052` (text
1536 dimensions), invent vectors, lower thresholds, or edit the JSON by hand.

Missing, empty, unreadable, corrupt or incompatible storage returns Vietnamese
`503 VISUAL_INDEX_UNAVAILABLE`, not featured products disguised as a no-match.
A valid nonempty index with no candidates after filters remains a normal
no-match. Corrupt existing storage is never silently overwritten: preserve it
for incident evidence, diagnose PVC/read permissions and restore a verified
compatible backup through an owner-reviewed recovery procedure before runtime
synchronization resumes. There is no online corrupt-index rebuild endpoint;
without a valid backup, escalate for a reviewed recovery change rather than
claiming ordinary catalog-index upserts will repair corruption.

### Monitoring operations

Grafana provisions four read-only dashboards under the **Velura** folder:
[overview](https://grafana.royalai.dev/d/velura-overview),
[workloads](https://grafana.royalai.dev/d/velura-workloads),
[HTTP/LLM](https://grafana.royalai.dev/d/velura-http-llm) and
[logs](https://grafana.royalai.dev/d/velura-logs). Datasource UIDs are
`velura-metrics` and `velura-logs`. Keep Grafana authenticated; do not expose
Loki directly or enable anonymous access for verification.

Alloy replaces Promtail after recent labeled streams are verified in Loki.
Select logs with `job="kubernetes-pods"` and `namespace`, `pod`, `container`;
never turn request bodies, identities or arbitrary parsed fields into labels.
Use aggregate LogQL for shared evidence:

```logql
sum by(namespace,pod,container) (count_over_time({job="kubernetes-pods",namespace="velura"}[5m]))
```

VictoriaMetrics needs `velura-metrics-collector-credentials/metrics-token`
matching the API's `METRICS_SCRAPE_BEARER_TOKEN`, and
`litellm-credentials/master-key`. Protect `/metrics`; never remove bearer
authentication to make a scrape green. NetworkPolicies must permit the
collector to API port 3000, Alloy port 12345 and the actual Kubernetes Service
and API endpoint addresses. Revalidate the pinned API addresses after recovery.
The desired Keycloak management endpoint is port 9000; an older installed
Keycloak or LiteLLM without metrics enabled remains a real coverage failure,
not a reason to suppress `ScrapeTargetDown`.

Alertmanager requires `alertmanager-config` with `alertmanager.yaml` and
`smtp-auth-password`. Use `smtp_auth_password_file:
/etc/alertmanager/smtp-auth-password`, mandatory STARTTLS on the configured
SMTP endpoint and an established operations recipient. The reviewed egress
policy permits public SMTP port 587; other transports need a separate review.
Never commit the populated Secret. A short-lived
`VeluraMonitoringDeliveryDrill` notification may verify the real path without
stopping a workload. Check the email notification/failure counters and obtain
recipient acknowledgement; SMTP acceptance alone does not prove inbox receipt.

Check `up` by job, recent labeled logs and
`vmalert_alerting_rules_errors_total` after a change. Missing backup evidence
must keep `BackupTooOld` actionable. No GPU exporter or Kubernetes object-state
exporter is installed by these dashboards: cAdvisor charts are measurements,
not deployment readiness, restart counts or peak-inference acceptance.
Keep metric and log retention at 14 days unless a measured storage budget and
data-retention policy approve a change.

Selective live observability changes must preserve installed images, auth
configuration and PVCs until staged upgrades are approved. Keep production
Flux suspended and promote the matching manifest changes through the normal
PR flow before resuming reconciliation. A staging frontend uses `Recreate`
within its quota, accepting temporary staging downtime rather than requiring
surge memory that the quota cannot supply. A manual staging fix can be reverted
by reconciliation until the matching Git change is promoted.

Flux controllers use default-deny with explicit API/DNS exceptions.
Only source-controller may fetch public HTTPS Git repositories; kustomize-controller
may read source-controller artifacts on port 9090, not arbitrary public HTTPS.
Retire the bootstrap blanket `allow-egress` policy only after the replacement
rules exist. Verify a fresh source fetch, artifact access from the controller's
network namespace, and a denied unrelated egress path; Pod readiness alone does
not test these boundaries. Neither source fetching nor this network check
requires resuming suspended application Kustomizations.


### Offsite backup bootstrap and restore drill

Agree RPO/RTO and retention with the owner before unsuspending schedules.
Provision `database/postgres-external-backup` with an external HTTPS S3 Restic
repository, encryption password, provider access keys, `CLUSTER_UID` and
`BACKUP_ENVIRONMENT=production`. Set `RESTIC_CACHE_DIR=/tmp/restic`.
Initialize the repository from a protected operator environment before jobs
run. `storage/storage-external-backup` must contain `rclone.conf` with `seaweed`
and a genuinely off-VM `external` remote; protect backup bucket versions from
writer deletion with provider retention/least-privilege credentials.

```bash
restic init
restic cat config
restic snapshots --json
restic restore "$APPROVED_SNAPSHOT_ID" --target "$RESTORE_DIR"
docker network create --internal velura-restore-drill
docker run --detach --name "$DRILL_CONTAINER" --network velura-restore-drill --env-file "$DRILL_POSTGRES_ENV" "$VERIFIED_POSTGRES_IMAGE"
docker exec "$DRILL_CONTAINER" sh -ec 'pg_isready -U "$POSTGRES_USER" -d postgres'
docker exec -i "$DRILL_CONTAINER" sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres' < "$RESTORE_DIR/backup/cluster.sql"
rclone --config "$RECOVERY_RCLONE_CONFIG" copy "external:velura-backups/objects/$BACKUP_TIMESTAMP" recovery: --checksum
rclone --config "$RECOVERY_RCLONE_CONFIG" check "external:velura-backups/objects/$BACKUP_TIMESTAMP" recovery: --one-way --download
```

Run these on an isolated recovery host. Use a fresh database and a distinct
drill superuser absent from the dump; `recovery` must point to a new bucket,
never production. Verify restored Keycloak realms/users/client roles and
object counts/checksums with secrets redacted, measure restore duration, and
record the exact snapshot/repository SHA256 and timestamps. Supabase commerce
data requires its own provider backup and full business-data restore drill;
local `pg_dumpall` does not cover the Supabase project. TTL-limited AI originals
and generated previews must not be reintroduced from backup after expiry.

K3s datastore type, supported-version upgrade plan, consistent datastore
backup and node recovery are separate prerequisites. Determine whether the
host uses SQLite or embedded etcd before selecting a backup/restore method;
never run etcd restore commands against an unverified SQLite installation.
Keep offsite copies of Git revision, age recovery key and relevant cluster
configuration, and prove recovery on a separate host before any production
stateful cutover. Repository snapshots alone do not prove cluster recovery.

For the verified default-layout SQLite service, the canonical CLI can inspect
recovery inputs without writing, then create a local snapshot with approval:

```bash
node tools/ops/velura-ops.mjs k3s-backup --ssh ai1-k3s --expected-cluster "$CLUSTER_UID" --environment production --revision "$APPROVED_SHA" --timeout 60000
node tools/ops/velura-ops.mjs k3s-backup --ssh ai1-k3s --expected-cluster "$CLUSTER_UID" --environment production --revision "$APPROVED_SHA" --timeout 60000 --execute --approval "$OWNER_APPROVAL_JSON"
```

The approval contract is returned by `schema`; it must match command
`k3s-backup`, environment, cluster UID, revision and expiry. This helper uses
Python's online SQLite backup API, verifies integrity, and atomically publishes
`/var/backups/velura-k3s/<timestamp-id>` with directory mode 700 and file mode
600. The manifest covers the database, server token, effective service unit
and supported config/environment/encryption inputs. Preserve all materials;
the server token is required for recovery and must never appear in logs.
The helper supports the host's Python 3.8 standard library.

A successful local snapshot still exits 1 while offsite and cluster-restore
proof remain unknown; inspect `executed`, `data.backup.created` and
`integrityCheck` instead of treating it as a failed SQLite copy or a passed DR
gate. Copying that snapshot into a temporary local database and checking it
does not prove an independent K3s boot, PostgreSQL/Supabase/object recovery or
agreed RPO/RTO. Do not unsuspend backup schedules without real external
credentials and a verified destination.

Before changing management access, prove a second independent administration
path and keep the existing key-authenticated session open. Root-only kubeconfig
permissions must also be preserved by the reviewed K3s startup configuration;
a one-time chmod does not prove permissions after restart. Secrets encryption,
key rotation and OS/K3s upgrades require approved maintenance, independent
restore evidence and rollback material. Upgrade Kubernetes one supported minor
at a time; never combine an untested datastore/OS migration with that change.
A single-node local-path cluster cannot meet HA requirements by adding replicas;
the owner must agree RPO/RTO and additional failure domains separately.


```bash
node tools/ops/velura-ops.mjs backup-check --backup-provider restic --environment production --expected-cluster "$CLUSTER_UID" --evidence "$RESTORE_EVIDENCE_JSON"
node tools/ops/velura-ops.mjs acceptance --context "$APPROVED_CONTEXT" --expected-cluster "$CLUSTER_UID" --evidence "$ACCEPTANCE_EVIDENCE_JSON"
```

`backup-check` independently checks provider snapshot identity/freshness, but
offsite location and restored data remain unknown unless separately verified.
External manual/signed attestations never become automatic CLI passes.
`node tools/ops/velura-ops.mjs schema` defines the JSON records, allowlisted
commands, approval expiry and stable exit codes. Production remains blocked
until every applicable requirement has exercised evidence.

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
  → CODEOWNERS reviewer merge develop
  → Push develop: cùng cổng test/build — không deploy
  → PR develop → main (source/target đủ; title promote nên `KAN-n: …`)
  → publish scanned/signed image digests → reviewed image promotion PR → staging GitOps
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
| Push `develop` | validate, tests, build | Không |
| PR `develop` → `main` | cùng cổng PR | Không |
| Push `main` | tests + build + manifests + image publication | Reviewed digest PR; no CI cluster mutation |

`note-pr` bắt buộc xanh. Trace = job log + artifact `pr-trace.md` + comment trên PR.

Staging GitOps dùng namespace `velura-staging`, credentials độc lập và `AI_ENABLE=false`. Cả staging lẫn production Flux khởi tạo suspended; chỉ owner mở staging sau khi image digest và secrets thật đã sẵn sàng. CI không giữ kubeconfig.

## Admin TMĐT — cơ sở đúng

Chuẩn phân hệ lấy từ Vendure (catalog, orders, customers, marketing, settings) nhưng **runtime là Angular + Node**. Mỗi màn `admin-ng` phải thỏa 8 điểm trong [COMPLIANCE.md](./COMPLIANCE.md) (list server-paged, detail, mutation có version, audit, RBAC từ `/api/auth/me`, MVVM, lazy route, test empty/error).

Luồng shop ↔ admin: sửa catalog/giá/KM trên admin → storefront đọc cùng API. Không page-builder. CMS nội dung (`/api/content`) hoãn đến khi catalog/orders đúng hợp đồng.

## K3s staging-first runbook

The inspected host is one Ubuntu 20.04 / K3s 1.30 node with 15 GiB RAM and an
RTX 4060 (8188 MiB VRAM). This is not HA. Supported OS/K3s maintenance, secret
encryption, audit retention, private management access, alert delivery and
offsite restore evidence remain production requirements, not properties proved
by YAML. Do not upgrade/reboot or migrate a production database in this procedure.

### Artifacts and deployment ownership

- CI `deploy-production` publishes API, storefront, admin and worker images; it
  scans the actual digest, emits SPDX SBOM/provenance, signs/attests it and opens
  an image-update PR into `develop`. SHA tags are publishing labels, not proof
  that an image exists. Deploy only the reviewed `@sha256` promotion.
- The worker Dockerfile requires an immutable Python 3.11 base supplied by CI
  from the real registry. `requirements-production.txt` pins CUDA 12.1 Torch and
  CPU-only ONNX dependencies; the image retains installed dependency versions
  and the blob-verified FASHN source LICENSE/NOTICE.
- `deploy/k8s/overlays/production` preserves `database/postgres-pvc`.
  CNPG operator/plugin/cluster/restore manifests under `database/cutover` are
  opt-in only. A maintenance-approved logical export, restore drill, Keycloak
  integrity check and service switch are required before any CNPG cutover.
  Never reuse the old data directory for a different PostgreSQL major.
- Both Flux Kustomizations and both backup CronJobs start suspended.
  Production remains suspended while staging is exercised. A Kubernetes
  resource render does not prove credentials, image availability or readiness.

### Local checks for the integration owner

Prerequisites: Node 22, Python 3.11, Kustomize 5.6, Mike Farah yq v4,
yamllint, kubeconform and reviewed schemas for non-core resources. CI installs
its parser/render dependencies explicitly and rejects duplicate mapping keys,
including embedded YAML ConfigMaps. These commands have no cluster mutation:

```bash
node --test tools/ops/velura-ops.test.mjs
python -m pip install -r apps/ai-worker/requirements-test.txt
python -m unittest discover -s apps/ai-worker -p 'test_*.py'
node tools/ops/velura-ops.mjs render --path deploy/k8s/overlays/staging
node tools/ops/velura-ops.mjs render --path deploy/k8s/overlays/production
node tools/ops/velura-ops.mjs validate --path deploy/k8s/overlays/staging
node tools/ops/velura-ops.mjs validate --path deploy/k8s/overlays/production
```

Strict policy validation intentionally rejects mutable upstream/app images.
Resolve each upstream image to a real reviewed registry digest and merge the
CI-generated app digest PR before declaring this check passed. No digest is
invented in the repository.

### Owner-only staging bootstrap

Use a TLS-verified explicit context for the known cluster; never the workstation
default context. Obtain its `kube-system` UID from the approved inventory and
set `CLUSTER_UID`, `APPROVED_CONTEXT` and the full 40-hex `APPROVED_SHA`.
Provision secrets through SOPS age-encrypted Git resources or protected
out-of-repository files; retain the age recovery key outside this VM.
The two commands below provision only staging isolation/application secrets:

```bash
kubectl --context "$APPROVED_CONTEXT" apply -f deploy/k8s/overlays/staging/namespace.yaml
kubectl --context "$APPROVED_CONTEXT" -n velura-staging create secret generic velura-api-secrets --from-env-file="$STAGING_SECRET_FILE"
```

`STAGING_SECRET_FILE` must be mode 600 and contain independent staging Supabase
project credentials, storage credentials/buckets, payment sandbox credentials,
OIDC settings, `PRODUCTION_VERIFY_TOKEN`, `LITELLM_API_KEY`, and `AI_WORKER_KEY`.
The app uses the real Supabase gateway, not the local Keycloak PostgreSQL.
Never copy production `.env`, service-role credentials or provider keys into
staging. Create shared platform PriorityClasses, DNS, LiteLLM/storage Services,
provider credentials, namespace isolation and management authentication only
through their separately approved platform bootstrap. Staging rendering does
not create these shared services.

As of the 2026-10-08 inventory, the live cluster has no `velura-staging`
namespace or Secrets. Local key-name inventory has no `STAGING_*`,
`LITELLM_*` or `AI_WORKER_KEY`; it has `SUPABASE_DB_URL` but no database CA
configuration. These are real missing prerequisites, not values to copy from
production. Provision a distinct Supabase staging project and trusted
`STAGING_SUPABASE_DB_URL` / `STAGING_SUPABASE_DB_CA_CERT` outside Git before
running migrations 049–055. Production writes are frozen:

```bash
node scripts/run-migrations.mjs --check --environment=staging
node scripts/run-migrations.mjs --environment=staging 049 050 051 052 053 054 055
```

The runner verifies TLS and rejects production database identity, including a
shared-pooler project suffix. It has no production fallback for staging writes.
Read-only production `--check` still requires trusted
`SUPABASE_DB_URL` / `SUPABASE_DB_CA_CERT`; missing CA is not permission to
disable TLS. Provision real per-application gateway keys and worker auth
separately. The VTO catalog must also have reviewed `verified:true`,
`photo_type:'flat-lay'`, supported category and exact `variant_images` mapping;
`AI_CATALOG_IMAGE_HOSTS` must name the exact approved HTTPS source hosts.
No primary-image/variant fallback or auto-generated studio selection supplies
missing catalog approval. `AI_ENABLE=false` disables uploads and inference.

Bootstrap the existing Flux source with real Git read credentials
`flux-system/velura-git-credentials` and an age key Secret `flux-system/sops-age`.
Apply `deploy/k8s/base/flux/git-sync.yaml` only after those prerequisites exist.
Pin its source to the approved commit before asking the operational CLI to
reconcile; opening staging must not open production:

```bash
kubectl --context "$APPROVED_CONTEXT" -n flux-system patch gitrepository velura-repo --type merge -p "{\"spec\":{\"ref\":{\"branch\":null,\"commit\":\"$APPROVED_SHA\"}}}"
flux resume kustomization velura-staging --namespace flux-system --context "$APPROVED_CONTEXT"
node tools/ops/velura-ops.mjs reconcile --context "$APPROVED_CONTEXT" --expected-cluster "$CLUSTER_UID" --environment staging --revision "$APPROVED_SHA"
node tools/ops/velura-ops.mjs health --context "$APPROVED_CONTEXT" --expected-cluster "$CLUSTER_UID" --namespace velura-staging
```

`reconcile` without `--execute` is read-only. Execution additionally requires
`--approval` matching environment, command, cluster UID, revision and expiry;
it only annotates the selected Flux Kustomization and cannot unsuspend it.
`health` leaves application smoke unknown even when Pods/Flux are Ready.
`/api/ops/revision` checks actual database/gateway readiness and the configured
revision, not Flux convergence. Use the CLI for Flux evidence.

`cloudflared-ingress-contract` is a route contract, not the running config.
The active tunnel reads the protected `networking/cloudflare-tunnel-config`
Secret. Its owner must install matching staging DNS/Access routes and render
real team/audience values into that Secret; cloudflared does not substitute
the contract's parameter notation. Use a staging-specific Access audience and
service token. The GitHub `staging` Environment must have independent
verification/Access secrets. Production verification is disabled unless the
owner sets `VELURA_VERIFY_PRODUCTION=true`; this does not resume Flux.

### Licensed worker provisioning and isolated smoke

The real worker is excluded from both default overlays. Its optional
`deploy/k8s/optional/ai-worker` overlay uses namespace `ai-staging`, ClusterIP,
API-only ingress, no egress, non-root/read-only containers, two private PVCs,
one NVIDIA GPU request and `Recreate`. CI replaces the required image input
with the real signed digest; replicas remain zero. Do not apply an unresolved
image input. Provision `ai-staging/ai-worker-auth` with the same independent
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

After the real digest promotion, owner-only provisioning may run with replicas
still zero. Protected auth/registry files must be mode 600:

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

#!/usr/bin/env bash
# Rebuilds the ai-lab/sample demo repository from scratch, deterministically.
# Infra as code (terraform + manifests) with the decision record carried in the
# commit trailers, and refs/notes/* standing in for what CI would have written.
set -euo pipefail

CTX="$(cd "$(dirname "$0")" && pwd)/bin/ctx"
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)/sample}"

rm -rf "$REPO"; mkdir -p "$REPO"; cd "$REPO"
git init -q -b main .
git config user.name  "ai-lab platform"
git config user.email "platform@ba-ailab.com"

say() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
commit() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -F -; }

say "ctx init"
"$CTX" init

# ---------------------------------------------------------------- C1: k3s API
mkdir -p infra/k3s
cat > infra/k3s/cluster.tf <<'EOF'
# k3s control plane — ai-lab
locals {
  api_vip      = "10.10.0.10"
  api_port     = 6443
  cluster_cidr = "10.42.0.0/16"
}

resource "null_resource" "k3s_server" {
  triggers = {
    args = join(" ", [
      "--tls-san=${local.api_vip}",
      "--advertise-address=${local.api_vip}",
      "--node-ip=${local.api_vip}",
      "--disable=traefik",
    ])
  }
}
EOF
git add -A
commit "2026-04-02T09:14:00+07:00" <<'EOF'
infra(k3s): pin the API server to the LAN VIP

Decision: the k3s API advertises the LAN VIP 10.10.0.10, never a tailnet address
Rejected: advertise the tailscale IP (workers go NotReady whenever the tailnet flaps)
Rejected: a managed load balancer in front of the API (paid SPOF outside the lab)
Reversible: never
Oracle: drift
EOF
C1=$(git rev-parse HEAD)

# ------------------------------------------------------------- C2: DERP edge
mkdir -p infra/headscale
cat > infra/headscale/derp.tf <<'EOF'
# headscale DERP — terminated on the VPS edge
locals {
  derp_region_id   = 900
  derp_hostname    = "derp.ba-ailab.com"
  derp_stun_port   = 3478
  behind_cdn_proxy = false
}
EOF
git add -A
commit "2026-04-20T16:41:00+07:00" <<'EOF'
infra(headscale): terminate DERP on the VPS edge

Decision: DERP terminates directly on the VPS; the record stays grey-cloud in DNS
Rejected: proxy DERP through the CDN (it strips the Upgrade header, relays 426 and registration 500s)
Reversible: true
Oracle: test
EOF
C2=$(git rev-parse HEAD)

# --------------------------------------------------- C3: Isaac scratch volume
mkdir -p infra/storage
cat > infra/storage/isaac-scratch.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: isaac-scratch
  namespace: robotics
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: longhorn
  resources:
    requests:
      storage: 500Gi
EOF
git add -A
commit "2026-05-11T11:02:00+07:00" <<'EOF'
infra(storage): Isaac Sim scratch on a Longhorn volume

Decision: Isaac Sim recording output lands on a 500Gi Longhorn RWO PVC
Rejected: hostPath on the node NVMe (pins the pod to a single node, no rescheduling)
Rejected: the z8-2 NFS export (that box already loopback-mounts its own export)
Reversible: true
Oracle: test
EOF
C3=$(git rev-parse HEAD)

# ------------------------------------------------------- C4: vllm (ungated)
mkdir -p apps/vllm
cat > apps/vllm/values.yaml <<'EOF'
model: Qwen3.5-35B-A3B-FP8
node: z8-3
gpuCount: 1
maxModelLen: 32768
guidedDecoding: json_object
EOF
git add -A
commit "2026-06-01T10:20:00+07:00" <<'EOF'
apps(vllm): serve Qwen3.5-35B on z8-3

Decision: json_object guided decoding only; no per-request JSON schema
Rejected: schema-constrained decoding (the FSM blows the 16Gi budget under load)
Reversible: true
Oracle: drift
EOF

# ------------------------------------------ C5: mechanical reformat (ignored)
sed -i 's/^  api_vip      =/  api_vip = /; s/^  api_port     =/  api_port = /; s/^  cluster_cidr =/  cluster_cidr = /' infra/k3s/cluster.tf
git add -A
commit "2026-06-14T08:00:00+07:00" <<'EOF'
style: terraform fmt sweep

No behaviour change; realignment only.
EOF
git rev-parse HEAD >> .git-blame-ignore-revs
git add .git-blame-ignore-revs
commit "2026-06-14T08:01:00+07:00" <<'EOF'
chore: ignore the fmt sweep in blame
EOF

# ------------------------------ CI-written derived state (refs/notes/{runs,incidents})
say "CI appends run + incident notes (plain git, no ctx)"
git notes --ref=runs append -m "at: 2026-04-03T02:00:00Z | status: pass | incident: none" "$C1"
git notes --ref=runs append -m "at: 2026-04-21T02:00:00Z | status: pass | incident: none" "$C2"
git notes --ref=runs append -m "at: 2026-05-12T02:00:00Z | status: pass | incident: none" "$C3"
git notes --ref=runs append -m "at: 2026-06-28T21:14:00Z | status: fail | incident: INC-2026-014" "$C3"
git notes --ref=incidents append -m "at: 2026-06-28T21:40:00Z | status: open | summary: z8-2 wedged in D-state during a 40GB Isaac recording; Longhorn replica sync starved kubelet I/O" "$C3"
git notes --ref=incidents append -m "at: 2026-04-22T09:00:00Z | status: closed | summary: DERP 426 after a CDN proxy toggle; reverted within the hour" "$C2"

# ------------------------------------------------- C6/C7: the supersede cycle
say "ctx supersede (the reviewable empty commit)"
GIT_AUTHOR_DATE="2026-07-02T14:30:00+07:00" GIT_COMMITTER_DATE="2026-07-02T14:30:00+07:00" \
  "$CTX" supersede "$C3" -reason "Longhorn replica traffic wedges the node under Isaac write load (INC-2026-014)"

cat > infra/storage/isaac-scratch.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: isaac-scratch
  namespace: robotics
  annotations:
    ai-lab.io/pinned-node: z8-2
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 500Gi
EOF
git add -A
commit "2026-07-02T14:45:00+07:00" <<'EOF'
infra(storage): move Isaac scratch to node-local NVMe

Decision: local-path PVC on the z8-2 NVMe, the pod pinned there by annotation
Rejected: Longhorn RWO (replica sync starves kubelet I/O and wedges the node)
Rejected: raising the Longhorn replica count (more sync traffic, same failure mode)
Reversible: restore-only
Oracle: contract
EOF
C7=$(git rev-parse HEAD)
git notes --ref=runs append -m "at: 2026-07-03T02:00:00Z | status: pass | incident: none" "$C7"
git notes --ref=runs append -m "at: 2026-08-30T02:00:00Z | status: pass | incident: none" "$C7"

# ------------------------------------------- C8/C9: an orphaned decision
# A decision that later gets silently overwritten — no supersede, no review of
# the retirement — is exactly the case blame alone cannot surface.
mkdir -p infra/gpu
cat > infra/gpu/scheduling.tf <<'EOF'
# GPU allocation on the two RTX 5880 Ada cards
locals {
  strategy   = "time-slicing"
  slices     = 4
  hami_used  = false
}
EOF
git add -A
commit "2026-05-20T09:00:00+07:00" <<'EOF'
infra(gpu): time-slice the RTX 5880 Ada pair

Decision: time-slicing instead of HAMi, because Isaac Sim needs exclusive GPU access and HAMi's virtual devices break its renderer
Rejected: HAMi virtual GPU pooling (breaks Isaac Sim's renderer)
Rejected: static single-tenant GPU assignment (wastes capacity outside training hours)
Reversible: true
Oracle: drift
EOF
C8=$(git rev-parse HEAD)
git notes --ref=runs append -m "at: 2026-05-21T02:00:00Z | status: pass | incident: none" "$C8"

# The whole file is rewritten for a different scheme. Nobody ran `ctx supersede`
# — this commit's Decision: is a NEW one, and the old file's Decision: about
# HAMi is now orphaned: it lost every line without anyone retiring it.
cat > infra/gpu/scheduling.tf <<'EOF'
# GPU allocation on the two RTX 5880 Ada cards
locals {
  strategy = "mps-partitioning"
  slices   = 4
}
EOF
git add -A
commit "2026-08-11T15:30:00+07:00" <<'EOF'
infra(gpu): switch to MPS partitioning

Decision: MPS gives finer-grained partitioning than time-slicing for the mixed training/inference load
Reversible: true
Oracle: test
EOF

# --------------------------------------------------- C10: registry rename
# Harbor is retired in favour of the GitLab container registry on Garage —
# a real rename in ai-lab's own history, staged here as `git mv`.
mkdir -p infra/registry
cat > infra/registry/harbor.tf <<'EOF'
# Harbor registry — image storage for CI builds
locals {
  registry_host = "harbor.internal.nocoai.vn"
  storage_gb    = 157
}
EOF
git add -A
commit "2026-03-10T10:00:00+07:00" <<'EOF'
infra(registry): stand up Harbor for CI image storage

Decision: Harbor as the container registry, backed by local disk
Reversible: restore-only
Oracle: test
EOF

git mv infra/registry/harbor.tf infra/registry/gitlab.tf
sed -i 's/# Harbor registry.*/# GitLab container registry, backed by Garage/; s/registry_host = .*/registry_host = "registry.ba-ailab.com"/; s/storage_gb    = 157/storage_gb    = 0  # Garage-backed, no fixed allocation/' infra/registry/gitlab.tf
git add -A
commit "2026-08-25T13:00:00+07:00" <<'EOF'
infra(registry): move off Harbor onto the GitLab registry

Decision: the GitLab-integrated registry on Garage replaces Harbor; one fewer system to operate, and image auth follows repo permissions instead of a separate robot-account scheme
Rejected: keep Harbor and add SSO in front of it (still two systems to patch and back up)
Reversible: restore-only
Oracle: contract
EOF

# ------------------------------------------------- C11: VPS edge retirement
# The VPS reverse-proxy is retired outright when hyperion goes live — a
# deletion with no successor file, so this is a pure tombstone.
mkdir -p infra/edge
cat > infra/edge/vps-forwarder.tf <<'EOF'
# Two-component edge: VPS terminates TLS and forwards into the tailnet
locals {
  vps_host      = "14.225.211.2"
  forward_proto = "socat"
  forward_port  = 2222
}
EOF
git add -A
commit "2026-03-01T08:00:00+07:00" <<'EOF'
infra(edge): stand up the VPS as the public entry point

Decision: a small VPS terminates TLS and forwards into the tailnet, since the lab has no static public IP of its own
Rejected: a cloud load balancer in front of the cluster (recurring cost for capacity the lab does not need)
Reversible: restore-only
Oracle: test
EOF

git rm -q infra/edge/vps-forwarder.tf
commit "2026-09-02T11:00:00+07:00" <<'EOF'
infra(edge): retire the VPS edge after the hyperion merge

Decision: hyperion (in-cluster Traefik) is now the sole ingress; the VPS forwarder is fully decommissioned, not just idle
Reversible: never
Oracle: drift
EOF

# ------------------------------------------------------------ walkthrough
cat > DEMO.md <<'DEMOEOF'
# ai-lab/sample — a walkthrough

A small infra-as-code repository where the reasoning behind every change lives
in the commit that made it. Regenerate it any time with `../ctx/build-sample.sh`
— nothing here is hand-edited, so nothing here can drift from what `ctx` sees.

Run each block and read the output before moving to the next; the point is the
shape of the answer, not the specific SHAs.

## 0. Making a repository AI-ready

Thirty seconds, once, per repository:

```sh
ctx init -hooks                                    # config, blame-ignore file, commit-msg gate
git config --add ctx.gate.path infra               # what is expensive to get wrong
```

That is the whole setup. `init` configures the notes refspecs on `origin`, sets
`blame.ignoreRevsFile`, and installs the hook that enforces the trailer
contract. The agent side — the `ctx` skill and the pre-edit hook — is installed
once per machine, not per repo (see `docs/claude-code.md` in the ctx repo).

Nothing else in this walkthrough required a database, an index to maintain, or
a service to run. Every answer below is computed from the commit graph at query
time.

## 1. A decision still in force

```sh
ctx for infra/k3s/cluster.tf
```

One commit, one constraint: the k3s API binds to a LAN VIP, never a tailnet
address, because workers went `NotReady` every time the tailnet flapped.
`reversible: never` — this is a one-way door — with `oracle: drift`, meaning a
reconciler is what will notice if it slips.

## 2. Formatting doesn't erase the reasoning

```sh
ctx for infra/k3s/cluster.tf:3-5
```

Same three lines, run through a `terraform fmt` sweep since. The decision
survives because that sweep's SHA is in `.git-blame-ignore-revs` — remove that
line and re-run to watch the answer degrade to `decision: "style: terraform
fmt sweep"`, which is the failure mode this file exists to prevent.

## 3. A decision that was deliberately retired

```sh
ctx for infra/storage/isaac-scratch.yaml
```

`active` holds the current choice (node-local NVMe, pinned by annotation).
`superseded` holds the one it replaced (a Longhorn volume), with the reviewed
reason it was retired and a `runs:` entry showing the failure that triggered
it. `open_incidents` still lists that failure — nobody closed it.

## 4. A decision nobody retired — it just lost its code

```sh
ctx for infra/gpu/scheduling.tf
```

The live file shows two `active` decisions (time-slicing, then MPS). Neither
mentions the other because nobody ran `ctx supersede` — the second commit just
overwrote the file. Add `-all` and the first decision reappears under
`orphaned`, because by declaring `Reversible: true` it said its own code was
cheap to lose. Change that decision's tier and rerun without `-all` — an
orphan that cost something to undo does not hide.

## 5. A file that no longer exists

```sh
ctx for infra/edge/vps-forwarder.tf
```

No error. `removed:` names the commit that took it out, when, and why:
hyperion replaced it as the sole ingress, `reversible: never`. This is the
answer an agent needs the moment it considers re-creating this file.

## 6. The same case, but it was a rename

```sh
ctx for infra/registry/harbor.tf
```

`removed.renamed_to` points at `infra/registry/gitlab.tf`. Querying that path
directly shows the decision as `active`, not orphaned — the rename carried the
constraint forward; only Harbor's original one is orphaned underneath it.

## 7. The gate, from the other side

```sh
echo "resource {}" >> infra/k3s/cluster.tf && git add -A
echo "infra: tweak the API config" > /tmp/msg && ctx gate -m /tmp/msg
```

Fails: gated path, no `Decision:`. Add one without an `Oracle:` while keeping
`Reversible: never` and it still fails. This is what stands between an agent
and committing exactly the kind of silent, undecided change the whole tool
exists to make visible.

```sh
git checkout -- infra/k3s/cluster.tf   # undo the scratch edit
```

## What an agent gets automatically

None of the above requires remembering to run `ctx`. With the Claude Code hook
installed (`docs/claude-code.md` in the `ctx` repo), every `Edit`/`Write`
against a file in this repo runs step 1–6 silently and hands the result to the
model before the edit lands — including a `Write` to `vps-forwarder.tf`, which
is precisely how an agent finds out it's about to undo a decision that was
never asked about.
DEMOEOF
git add DEMO.md
commit "2026-09-04T09:00:00+07:00" <<'EOF'
docs: add the walkthrough

Decision: the walkthrough is generated by this script, not hand-maintained, so it can never describe a scope this repo does not actually have
Reversible: true
Oracle: test
EOF

say "ctx reindex (rebuild refs/notes/decisions from the trailers)"
"$CTX" reindex

say "history"
git log --oneline --all

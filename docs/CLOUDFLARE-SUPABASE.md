# Cloudflare and Supabase external ownership

Terraform owns the existing public DNS pointers in
[`infra/terraform/cloudflare`](../infra/terraform/cloudflare). Flux owns the
Kubernetes workloads and cloudflared route configuration. GitHub Actions validates
Terraform without credentials; Atlantis plans and applies external changes only
through a reviewed PR. Neither Terraform nor Actions manages Kubernetes.

## Current Cloudflare tunnel

Zone: **royalai.dev**. Existing locally managed tunnel:
**`96cb38bf-7ca6-417a-aebb-075f365c5773`**.

| Existing hostname | Intended DNS target | Proxy |
|---|---|---|
| `admin.royalai.dev` | `96cb38bf-7ca6-417a-aebb-075f365c5773.cfargotunnel.com` | Proxied |
| `admin-erp.royalai.dev` (preview) | Same tunnel CNAME | Proxied |
| `api.royalai.dev` | Same tunnel CNAME | Proxied |
| `velura.royalai.dev` | Same tunnel CNAME | Proxied |
| `shop.royalai.dev` | Same tunnel CNAME | Proxied |
| `auth.royalai.dev` | Same tunnel CNAME | Proxied |
| `grafana.royalai.dev` | Same tunnel CNAME | Proxied |
| `ai.royalai.dev` | Same tunnel CNAME | Proxied |
| `s3.royalai.dev` | Same tunnel CNAME | Proxied |

Confirm these values against the Cloudflare account before adopting state. DNS
does not configure cloudflared ingress, backend services or authentication. The
admin hostname is `admin.royalai.dev`, not `admin.velura.royalai.dev`.
Staging DNS/Access ownership is not included in this eight-record adoption;
staging must remain gated until its own prerequisites in
[HOW-IT-WORKS.md](./HOW-IT-WORKS.md) are satisfied.

The historical Azure VM at `135.235.219.13` is **not** a verified active origin.
Do not restore its A records or provision another VM from the old deployment
instructions. Do not run `cloudflared tunnel route dns` after Terraform adoption:
that would create a second DNS owner.

The root deliberately does not declare a tunnel resource, remote tunnel
configuration or tunnel token data source. Do not import the locally managed
tunnel itself, rotate its secret, or change its management mode. Its existing
credential must stay in the deployment secret store, never Git or Terraform input.
TLS, Access policies, Supabase and Google OAuth are not silently adopted by this
DNS change.

## Terraform adoption: import before apply

Toolchain: Terraform **1.13.4** for CI/Atlantis; the root supports Terraform
`>= 1.10, < 2`. Cloudflare provider is exactly **5.28.0**. Commit the
Terraform-generated `.terraform.lock.hcl` with verified `linux_amd64` and
`windows_amd64` checksums before enabling readonly-lockfile CI. Provider contracts:
[DNS resource/import](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.28.0/docs/resources/dns_record.md),
[zone lookup](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.28.0/docs/data-sources/zone.md).

Supply these values through the Atlantis runtime secret/config store, not a
committed tfvars file:

| Environment variable | Required value/source |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Existing zone-scoped token with Zone Read and DNS Edit permissions for `royalai.dev`; never an account-wide API key |
| `TF_VAR_cloudflare_account_id` | Actual 32-character account ID from Cloudflare |
| `TF_VAR_cloudflare_zone_id` | Actual 32-character `royalai.dev` zone ID |
| `TF_VAR_cloudflare_tunnel_id` | Confirmed existing UUID above |
| `TF_VAR_dns_record_ids` | JSON object with exactly `admin`, `api`, `velura`, `shop`, `auth`, `grafana`, `ai`, `s3` mapped to their distinct existing Cloudflare DNS record IDs |
| `TF_CLI_ARGS_init` | `-backend-config=/run/velura-iac/backend.hcl -input=false -lockfile=readonly`; mount that protected file at this runtime path |
| AWS SDK authentication | Prefer workload role credentials; otherwise `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN` |

Use Cloudflare's read API to inventory records:
`GET /client/v4/zones/{zone_id}/dns_records?type=CNAME` (follow pagination).
For each hostname confirm the record ID, type, proxied flag and tunnel target.
The account/zone lookup fails if the configured account does not own
`royalai.dev`. The tunnel UUID is an operator-confirmed input, not proof that a
connector is healthy.

All eight IDs are mandatory. Configuration-driven import blocks use
`<zone_id>/<record_id>` and remain in the root after adoption. A missing ID is not
permission to create a replacement. If the live record is an A/AAAA record,
points elsewhere, or cannot be found, stop and resolve the ownership discrepancy
in a reviewed migration; do not delete a working DNS record to make import pass.

### Required remote backend

An existing **encrypted, versioned, private S3 backend with native conditional
lock-file support** is a prerequisite, not a resource provisioned by this root.
The protected backend file must contain the real `bucket`, unique `key`, and
`region`. Encryption and `use_lockfile = true` are declared in code; do not
override or disable them. Keep AWS credentials out of this file.
Do not assume the application SeaweedFS service is an appropriate backend.
If no approved backend exists, stop before any shared init/import/apply rather
than falling back to local state or creating an unapproved cloud service.

Use one `default` workspace and one state key for this zone across all branches
and Atlantis replicas. Require TLS, bucket public-access blocking, versioning and
server-side encryption. The role needs `s3:ListBucket` scoped to the state prefix,
`s3:GetObject`/`s3:PutObject` on the state object, and
`s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on its `.tflock` object; add KMS
permissions if that bucket uses a customer-managed key. Do not grant state-object
deletion merely to release locks. See the
[S3 backend contract](https://developer.hashicorp.com/terraform/language/backend/s3).

### Adoption sequence

1. Approve the backend, inventory and credentials above. Review the provider
   lockfile. The credential-free check is `terraform init -backend=false`,
   followed by `terraform validate`; it is **not** a real plan or adoption.
2. With the real remote backend configured, have Atlantis run
   `atlantis plan -p cloudflare-dns` on the `develop` → `main` PR. Native import
   blocks must show eight imports, **zero creates and zero destroys**. Review
   every in-place change; initial adoption should not alter traffic.
3. Only after approval, mergeability and an undiverged branch are confirmed, an
   authorized owner explicitly runs `atlantis apply -p cloudflare-dns` to apply
   that saved plan. Importing writes state and is therefore not a read-only step.
   There is no automatic production apply.
4. Replan after adoption and expect no changes before handing off DNS ownership.
   Keep future DNS changes on feature → `develop` → `main` PRs and use Atlantis;
   no dashboard edits or Actions deployment credentials.

`prevent_destroy` rejects planned record deletion/replacement while these
resources remain configured; it does not prevent an in-place DNS target change
or protect a resource after someone removes its configuration. Review is still
required. Comments, tags and existing DNS settings are outside this root's
ownership. Never use `-target`, `-lock=false`, state removal, forced unlock or
record recreation as an adoption shortcut.

## Atlantis runtime and trusted policy

[`atlantis.yaml`](../atlantis.yaml) defines a single production DNS project,
autoplanning on PRs targeting `main`. Feature PRs to `develop` receive
credential-free Terraform validation; they do not mutate production DNS.
[`infra/terraform/atlantis/repos.yaml`](../infra/terraform/atlantis/repos.yaml)
is the required **server-side** policy: approval, mergeability and undiverged
requirements apply to apply/import on the canonical repository; PRs cannot
override requirements or define/select custom workflows. Autodiscovery is
disabled. No shell workflow or autoapply is configured.

Install reviewed copies of `repos.yaml` and
[`server.yaml`](../infra/terraform/atlantis/server.yaml) under `/etc/atlantis/`
outside PR checkouts and start the approved Atlantis runtime with:

```sh
atlantis server --config=/etc/atlantis/server.yaml
```

The server configuration uses `checkout-strategy: merge`, which is required for
the `undiverged` requirement to enforce saved-plan freshness. Fork and draft PRs
are disabled. Do not override these settings at launch.

The deployment must also supply `ATLANTIS_GH_USER`, a least-privilege
`ATLANTIS_GH_TOKEN` for the bot, `ATLANTIS_GH_WEBHOOK_SECRET`, and
`ATLANTIS_ATLANTIS_URL` set to its approved real HTTPS endpoint. Configure the
GitHub webhook to that endpoint's `/events` with the matching secret and the
required pull-request, review, comment and push events. Provide durable Atlantis
data/plan storage, restrict access to plans and runtime secrets, and install the
pinned Terraform binary. Enforce protected `develop`/`main` branches, required
checks and infrastructure CODEOWNER review in GitHub; Atlantis's basic approval
check alone is not a substitute for restricted reviewer approval. See
[Atlantis server policy](https://www.runatlantis.io/docs/server-side-repo-config)
and [repository projects](https://www.runatlantis.io/docs/repo-level-atlantis-yaml).

Do not load policy from the unreviewed PR checkout. Changing the repository copy
does not update an existing server; promote reviewed policy through its runtime
configuration. `allow_custom_workflows: false` prevents repository-defined shell
workflows, but Terraform planning still executes provider code: only the
allowlisted trusted repository may reach runtime credentials.

**Provisioning boundary:** this repository does not demonstrate a running
Atlantis service, approved state bucket, Cloudflare token, account/zone IDs or
the eight record IDs. The working environment exposed none of those credentials
or Terraform inputs. Until supplied and validated, no live plan/import/apply is
claimed, and the checked-in project is not evidence of running automation.

## Existing Supabase and OAuth settings

Existing Supabase project: `https://gtyuajboeffmfskofoyh.supabase.co`.
This DNS root does not provision a replacement project or claim management of
Supabase Auth settings. Preserve the existing Auth allowlist until ownership and
an API-supported Terraform/provider contract are reviewed separately; do not
silently switch settings through dashboard instructions.

The expected storefront Site URL remains `https://velura.royalai.dev`.
Known application callback URLs include `https://admin.royalai.dev/auth/callback`,
`https://admin-erp.royalai.dev/auth/callback`, `http://localhost:4001/auth/callback`,
`http://localhost:4003/auth/callback`, and
`https://gtyuajboeffmfskofoyh.supabase.co/auth/v1/callback` for Google OAuth.
Retain only routes actually required by the active authentication integration;
the historical VM and `admin.velura.royalai.dev` are not new infrastructure
requirements. Public API/browser CORS is owned by application configuration,
not a retired `/opt/velura/.env` on an assumed Azure VM.

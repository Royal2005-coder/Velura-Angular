variable "cloudflare_account_id" {
  description = "Existing Cloudflare account that owns the royalai.dev zone; not a tunnel credential."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be the existing 32-character account ID."
  }
}

variable "cloudflare_zone_id" {
  description = "Existing royalai.dev zone ID. Terraform does not create or transfer the zone."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be the existing 32-character zone ID."
  }
}

variable "cloudflare_tunnel_id" {
  description = "UUID of the existing locally managed tunnel; confirm 96cb38bf-7ca6-417a-aebb-075f365c5773 before adoption. No tunnel resource or secret is managed here."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.cloudflare_tunnel_id))
    error_message = "cloudflare_tunnel_id must be the confirmed existing tunnel UUID."
  }
}

variable "dns_record_ids" {
  description = "Existing CNAME record IDs keyed by admin, api, velura, shop, auth, grafana, ai and s3. Mandatory import IDs prevent an initial create-only adoption plan."
  type        = map(string)
  nullable    = false

  validation {
    condition = toset(keys(var.dns_record_ids)) == toset([
      "admin", "api", "velura", "shop", "auth", "grafana", "ai", "s3"
    ])
    error_message = "Supply exactly the eight existing record IDs: admin, api, velura, shop, auth, grafana, ai and s3."
  }

  validation {
    condition = alltrue([
      for id in values(var.dns_record_ids) : can(regex("^[0-9a-f]{32}$", id))
    ]) && length(toset(values(var.dns_record_ids))) == 8
    error_message = "Each DNS record ID must be a distinct existing 32-character Cloudflare ID."
  }
}

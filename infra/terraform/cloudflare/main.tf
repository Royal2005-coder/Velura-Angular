data "cloudflare_zone" "royalai" {
  zone_id = var.cloudflare_zone_id

  lifecycle {
    postcondition {
      condition     = self.name == "royalai.dev" && self.account.id == var.cloudflare_account_id
      error_message = "The supplied zone must be royalai.dev in the confirmed Cloudflare account."
    }
  }
}

# Adopt only public DNS pointers. Flux owns Kubernetes cloudflared routing;
# the existing locally managed tunnel and its credentials stay untouched.
resource "cloudflare_dns_record" "tunnel" {
  for_each = var.dns_record_ids

  zone_id = data.cloudflare_zone.royalai.id
  name    = "${each.key}.royalai.dev"
  type    = "CNAME"
  content = "${var.cloudflare_tunnel_id}.cfargotunnel.com"
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
    # Adoption does not take ownership of unrelated DNS metadata/settings.
    ignore_changes = [comment, tags, settings]
  }
}

# Retain these blocks after adoption: a missing/wrong ID fails instead of
# silently creating a second record during initial ownership transfer.
import {
  for_each = var.dns_record_ids
  to       = cloudflare_dns_record.tunnel[each.key]
  id       = "${var.cloudflare_zone_id}/${each.value}"
}

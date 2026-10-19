terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.0"
    }
  }

  # Bucket, key and region must come from a protected backend config at init.
  # This root must never use local state for shared/Atlantis operations.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

# Authentication uses CLOUDFLARE_API_TOKEN from the runtime secret store.
provider "cloudflare" {}

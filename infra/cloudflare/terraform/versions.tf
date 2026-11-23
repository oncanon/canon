# Publisher V2 Cloudflare test deployment (provider-validation slice 06).
# PREPARED, NOT APPLIED: running `init`, `plan` or `apply` downloads the provider and
# reaches the Cloudflare API, and each needs the maintainer's separate confirmation.
# The provider reads its API token only from the CLOUDFLARE_API_TOKEN environment
# variable; no credential is written in any file here.
#
# That deploy token carries exactly these scopes (infra/cloudflare/deploy-token-scopes.json;
# test/unit/pv-deploy-token-scopes.test.mjs checks every copy):
# deploy-token-scopes:begin
#   granted: Workers Scripts Edit | Workers R2 Storage Edit | D1 Edit | Account Settings Read (unverified) | Access: Apps and Policies Edit
# deploy-token-scopes:end
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

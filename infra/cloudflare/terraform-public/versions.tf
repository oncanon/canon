# Publisher V2.1 PUBLIC target (slice 04, mode (c)): a structurally separate deployment.
# PREPARED, NOT APPLIED: running `init`, `plan` or `apply` downloads the provider and
# reaches the Cloudflare API, and each needs the maintainer's separate confirmation.
# This directory is its own root module with its own state; it shares no resource,
# variable, state or credential with the private module in ../terraform (checked by
# test/unit/v21-public-iac.test.mjs). The provider reads its API token only from the
# CLOUDFLARE_API_TOKEN environment variable: the public deploy token, never the private one.
#
# That public deploy token carries exactly these scopes (infra/cloudflare/deploy-token-scopes-public.json;
# test/unit/pv-deploy-token-scopes.test.mjs checks every copy):
# deploy-token-scopes-public:begin
#   granted: Workers Scripts Edit | Workers R2 Storage Edit | D1 Edit | Account Settings Read (unverified)
# deploy-token-scopes-public:end
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

# Cloudflare Access for the test Worker, as code (V2.1 slice 03). Access carries no secret:
# the application and its policies live here; the Access service token is created in the
# dashboard (runbook step 4) so its client secret never enters state or disk, and only its
# ID and Client ID (identifiers) come in as variables.
#
# The reviewer mode is chosen by var.access_mode:
#   "exact-person" (default): the listed email addresses only (per-person audit; revoke by
#                             removing an address);
#   "idp-domain":             anyone the named identity provider authenticates with an
#                             address in var.reviewer_email_domain (adds the IdP's trust;
#                             docs/v2/threat-model.md T4).

resource "cloudflare_zero_trust_access_application" "reviewers" {
  account_id                = var.account_id
  name                      = "rp-publisher-test"
  type                      = "self_hosted"
  domain                    = "${var.worker_name}.${var.workers_subdomain}.workers.dev"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = var.access_mode == "idp-domain" ? [var.identity_provider_id] : []
  auto_redirect_to_identity = var.access_mode == "idp-domain"

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.reviewers.id
      precedence = 1
    },
    {
      id         = cloudflare_zero_trust_access_policy.publisher.id
      precedence = 2
    },
  ]
}

resource "cloudflare_zero_trust_access_policy" "reviewers" {
  account_id = var.account_id
  name       = "rp-publisher-test reviewers"
  decision   = "allow"
  include    = var.access_mode == "exact-person" ? [for e in var.reviewer_emails : { email = { email = e } }] : [{ email_domain = { domain = var.reviewer_email_domain } }]
}

resource "cloudflare_zero_trust_access_policy" "publisher" {
  account_id = var.account_id
  name       = "rp-publisher-test publisher (service auth)"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = var.service_token_id } }]
}

variable "account_id" {
  description = "Cloudflare account ID (the maintainer's personal account). An identifier, not a secret."
  type        = string
}

variable "worker_name" {
  description = "Worker script name; its URL is https://<worker_name>.<account subdomain>.workers.dev."
  type        = string
  default     = "rp-publisher-test"
}

variable "run_id" {
  description = "Test run suffix <yyyymmdd>-<runid>, so test resources are disposable and distinct."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{8}-[a-z0-9]{1,12}$", var.run_id))
    error_message = "run_id must look like 20260927-a1."
  }
}

variable "worker_module_path" {
  description = "Path to the Worker entry module (provider-validation slice 05)."
  type        = string
  default     = "../../../src/publication/worker/index.mjs"
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date."
  type        = string
  default     = "2026-09-26"
}

# The Access team domain, filled in at runbook step 6. While it is empty the Worker
# refuses every request (it fails closed).
variable "team_domain" {
  description = "Access team domain, https://<team>.cloudflareaccess.com (shown when Access is enabled)."
  type        = string
  default     = ""

  validation {
    condition     = var.team_domain == "" || can(regex("^https://[a-z0-9-]+\\.cloudflareaccess\\.com$", var.team_domain))
    error_message = "team_domain must be https://<team>.cloudflareaccess.com."
  }
}

variable "workers_subdomain" {
  description = "The account's workers.dev subdomain (runbook step 2), without .workers.dev. An identifier."
  type        = string
}

variable "access_mode" {
  description = "Reviewer access mode: exact-person (listed emails) or idp-domain (an IdP-authenticated email domain)."
  type        = string
  default     = "exact-person"

  validation {
    condition     = contains(["exact-person", "idp-domain"], var.access_mode)
    error_message = "access_mode must be exact-person or idp-domain."
  }
}

variable "reviewer_emails" {
  description = "exact-person mode: the reviewers' email addresses."
  type        = list(string)
  default     = []
}

variable "reviewer_email_domain" {
  description = "idp-domain mode: the email domain the identity provider must assert."
  type        = string
  default     = ""
}

variable "identity_provider_id" {
  description = "idp-domain mode: the Access identity provider's ID (configured in the dashboard, runbook step 5). An identifier."
  type        = string
  default     = ""

  validation {
    condition     = var.access_mode != "idp-domain" || (var.identity_provider_id != "" && var.reviewer_email_domain != "")
    error_message = "idp-domain mode needs identity_provider_id and reviewer_email_domain."
  }
}

variable "service_token_id" {
  description = "The Access service token's ID (runbook step 4). An identifier; the client secret never comes here."
  type        = string
}

variable "service_token_client_ids" {
  description = "Access service-token Client IDs allowed to use the ingest API. Client IDs only; never the secret."
  type        = list(string)
  default     = []
}

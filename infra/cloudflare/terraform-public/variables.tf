variable "account_id" {
  description = "Cloudflare account ID (the maintainer's personal account). An identifier, not a secret."
  type        = string
}

variable "worker_name" {
  description = "Public Worker script name; its URL is https://<worker_name>.<account subdomain>.workers.dev."
  type        = string
  default     = "rp-public-test"
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
  description = "Path to the Worker entry module (the same Worker source, run with MODE = public)."
  type        = string
  default     = "../../../src/publication/worker/index.mjs"
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date."
  type        = string
  default     = "2026-09-26"
}

# The PUBLIC half of the publisher signing key (scripts/public-target-keygen.mjs prints it).
# It is not a secret; the private half never comes here.
variable "publisher_public_key" {
  description = "The publisher signing key's public half, canon-ed25519-pk:<base64url>. Not a secret."
  type        = string

  validation {
    condition     = can(regex("^canon-ed25519-pk:[A-Za-z0-9_-]{43}$", var.publisher_public_key))
    error_message = "publisher_public_key must be canon-ed25519-pk:<43 base64url characters>."
  }
}

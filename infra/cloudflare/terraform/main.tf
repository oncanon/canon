# What this configuration manages, and what it deliberately does not
# (docs/v2/cloudflare/coverage.md):
#   managed:   the R2 bucket, the D1 database, the Worker script with its bindings, and
#              the Worker's workers.dev route (preview URLs off)
#   manual:    the account and its workers.dev subdomain, the deploy API token, the D1
#              schema (Terraform does not apply schemas), Cloudflare Access on
#              workers.dev and its policies, and the Access service token (its secret
#              would otherwise be stored in Terraform state)
#   never:     custom domains, DNS, routes, public R2 access, bucket locks, deletion

locals {
  bucket_name   = "rp-packets-test-${var.run_id}"
  database_name = "rp-aliases-test-${var.run_id}"
}

resource "cloudflare_r2_bucket" "packets" {
  account_id    = var.account_id
  name          = local.bucket_name
  storage_class = "Standard"
}

resource "cloudflare_d1_database" "aliases" {
  account_id = var.account_id
  name       = local.database_name

  # Reads go to the primary, so the alias compare-and-swap reads its own writes.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_script" "publisher" {
  account_id         = var.account_id
  script_name        = var.worker_name
  content_file       = var.worker_module_path
  content_sha256     = filesha256(var.worker_module_path)
  main_module        = "index.mjs"
  compatibility_date = var.compatibility_date

  bindings = [
    {
      name        = "PACKETS"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.packets.name
    },
    {
      name = "ALIASES"
      type = "d1"
      id   = cloudflare_d1_database.aliases.id
    },
    {
      name = "TEAM_DOMAIN"
      type = "plain_text"
      text = var.team_domain
    },
    {
      name = "POLICY_AUD"
      type = "plain_text"
      text = cloudflare_zero_trust_access_application.reviewers.aud
    },
    {
      name = "SERVICE_TOKEN_CLIENT_IDS"
      type = "plain_text"
      text = join(",", var.service_token_client_ids)
    },
  ]
}

# workers.dev only: the Worker gets no custom domain or route. Preview URLs stay off.
resource "cloudflare_workers_script_subdomain" "publisher" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.publisher.script_name
  enabled          = true
  previews_enabled = false
}

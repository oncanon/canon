# What this configuration manages, and what it deliberately does not
# (docs/v2/cloudflare/coverage.md, public target rows):
#   managed:   the public R2 bucket, the public D1 database, the public Worker script
#              with its bindings (MODE = "public"), and its workers.dev route (previews off)
#   manual:    the public deploy API token, the D1 schema (scripts/d1-schema.mjs), and the
#              publisher signing key (scripts/public-target-keygen.mjs; only its PUBLIC
#              half comes here)
#   never:     Cloudflare Access of any kind, custom domains, DNS, routes, public R2
#              access (the Worker serves), bucket locks, deletion

locals {
  bucket_name   = "rp-public-test-${var.run_id}"
  database_name = "rp-public-aliases-test-${var.run_id}"
  target_id     = "${var.worker_name}-${var.run_id}"
}

resource "cloudflare_r2_bucket" "public_packets" {
  account_id    = var.account_id
  name          = local.bucket_name
  storage_class = "Standard"
}

resource "cloudflare_d1_database" "public_aliases" {
  account_id = var.account_id
  name       = local.database_name

  # Reads go to the primary, so the alias compare-and-swap reads its own writes.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_script" "public_publisher" {
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
      bucket_name = cloudflare_r2_bucket.public_packets.name
    },
    {
      name = "ALIASES"
      type = "d1"
      id   = cloudflare_d1_database.public_aliases.id
    },
    {
      name = "MODE"
      type = "plain_text"
      text = "public"
    },
    {
      name = "TARGET_ID"
      type = "plain_text"
      text = local.target_id
    },
    {
      name = "PUBLISHER_PUBLIC_KEY"
      type = "plain_text"
      text = var.publisher_public_key
    },
  ]
}

# workers.dev only: the Worker gets no custom domain or route. Preview URLs stay off.
resource "cloudflare_workers_script_subdomain" "public_publisher" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.public_publisher.script_name
  enabled          = true
  previews_enabled = false
}

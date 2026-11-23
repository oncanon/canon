output "bucket_name" {
  value = cloudflare_r2_bucket.packets.name
}

output "d1_database_id" {
  description = "Needed by wrangler for `d1 migrations apply` (infra/cloudflare/wrangler)."
  value       = cloudflare_d1_database.aliases.id
}

output "worker_name" {
  value = cloudflare_workers_script.publisher.script_name
}

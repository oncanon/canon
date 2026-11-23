output "public_bucket_name" {
  value = cloudflare_r2_bucket.public_packets.name
}

output "public_d1_database_id" {
  description = "Needed by scripts/d1-schema.mjs to apply the schema to the public database."
  value       = cloudflare_d1_database.public_aliases.id
}

output "public_worker_name" {
  value = cloudflare_workers_script.public_publisher.script_name
}

output "public_target_id" {
  description = "The Worker's TARGET_ID: the public target's targetId in the publication targets file."
  value       = local.target_id
}

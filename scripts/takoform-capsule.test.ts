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
  test("owns the default portable Worker, bucket, and metadata graph", () => {
    expect(main).toContain('resource "takoform_edge_worker" "worker"');
    expect(main).toContain('resource "takoform_object_bucket" "objects"');
    expect(main).toContain('resource "takoform_sql_database" "metadata"');
    expect(main).toContain('name        = "BUCKET"');
    expect(main).toContain('name        = "DB"');
  });

  test("does not partially claim the currently disabled Actions graph", () => {
    expect(main).not.toContain("takoform_queue");
    expect(main).not.toContain("takoform_container_service");
    expect(main).not.toContain("takoform_stateful_actor_namespace");
    expect(readme).toContain("Self-hosted Actions remains disabled");
  });

  test("both install paths schedule the durable webhook outbox", () => {
    expect(main).toContain('resource "takoform_schedule" "webhook_outbox"');
    expect(main).toContain('projection  = "schedule_trigger"');
    expect(outputs).toContain("webhook_outbox = takoform_schedule.webhook_outbox.id");
    expect(directMain).toContain(
      'resource "cloudflare_workers_cron_trigger" "webhook_outbox"',
    );
    expect(directMain).toContain(
      "local.cloudflare_worker_enabled && local.metadata_enabled",
    );
  });

  test("uses Takoform directly and ordinary outputs only", () => {
    expect(main).toContain(
      'source  = "registry.opentofu.org/tako0614/takoform"',
    );
    expect(main).not.toContain("cloudflare/cloudflare");
    expect(main).not.toContain("/compat/cloudflare/");
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

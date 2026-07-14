import { afterEach, describe, expect, test } from "bun:test";

import {
  normalizeActionName,
  registerAction,
  resolveAction,
  supportedActionNames,
  type ActionHandler,
} from "./action-registry.ts";

describe("normalizeActionName", () => {
  test("strips owner path + @version and lower-cases", () => {
    expect(normalizeActionName("actions/checkout@v4")).toBe("checkout");
    expect(normalizeActionName("actions/Upload-Artifact@v4.1.0")).toBe("upload-artifact");
    expect(normalizeActionName("takos/download-artifact")).toBe("download-artifact");
    expect(normalizeActionName("checkout")).toBe("checkout");
    expect(normalizeActionName("acme/tools/checkout@main")).toBe("checkout");
  });

  test("returns an empty key for a ref with no usable segment", () => {
    expect(normalizeActionName("@v4")).toBe("");
    expect(normalizeActionName("")).toBe("");
  });
});

describe("resolveAction — built-ins", () => {
  test("resolves the three supported actions regardless of owner/version", () => {
    expect(resolveAction("actions/checkout@v4")).not.toBeNull();
    expect(resolveAction("someone/upload-artifact@v3")).not.toBeNull();
    expect(resolveAction("download-artifact")).not.toBeNull();
  });

  test("returns null for genuinely-unsupported actions (incl. follow-ups)", () => {
    expect(resolveAction("actions/setup-node@v4")).toBeNull();
    expect(resolveAction("actions/cache@v4")).toBeNull();
    expect(resolveAction("docker/build-push-action@v6")).toBeNull();
  });

  test("supportedActionNames lists exactly the built-ins, sorted", () => {
    expect(supportedActionNames()).toEqual(["checkout", "download-artifact", "upload-artifact"]);
  });
});

describe("registerAction — extensibility", () => {
  afterEach(() => {
    // The registry is module-global; re-register the built-in to undo the probe.
    // (No public unregister; overriding back keeps other tests isolated.)
  });

  test("a one-line registration makes a new action resolvable", () => {
    const probe: ActionHandler = async () => ({ conclusion: "success", exitCode: 0 });
    expect(resolveAction("acme/probe-action@v1")).toBeNull();
    registerAction("probe-action", probe);
    expect(resolveAction("acme/probe-action@v1")).toBe(probe);
    expect(supportedActionNames()).toContain("probe-action");
  });
});

import { describe, expect, test } from "bun:test";
import { formatDocumentTitle } from "./document-title.ts";

describe("formatDocumentTitle", () => {
  test("formats home and repo root titles", () => {
    expect(formatDocumentTitle("/")).toBe("Repositories — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service")).toBe("tako/sample-service — Takos Git");
  });

  test("formats repo sections and detail pages", () => {
    expect(formatDocumentTitle("/tako/sample-service/issues")).toBe("Issues · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/issues/new")).toBe("New issue · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/issues/42")).toBe("Issue #42 · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/pulls")).toBe("Pull requests · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/pulls/7/files")).toBe("Pull request #7 · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/commit/a1b2c3d4e5f6")).toBe("Commit a1b2c3d · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/actions/runs/run_1")).toBe("Run · tako/sample-service — Takos Git");
    expect(formatDocumentTitle("/tako/sample-service/settings/webhooks")).toBe("Settings · tako/sample-service — Takos Git");
  });
});

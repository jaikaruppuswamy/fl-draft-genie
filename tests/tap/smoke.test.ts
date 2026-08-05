import { describe, expect, it } from "vitest";
import { TAP_VERSION, META_BLOCK, DRAFT_HOST } from "../../tap/meta";

describe("tap project wiring", () => {
  it("runs in a node environment, not the workers pool", () => {
    expect(typeof process.versions.node).toBe("string");
  });

  it("keeps the metadata banner's @version in step with TAP_VERSION (FR-022)", () => {
    expect(META_BLOCK).toContain(`// @version      ${TAP_VERSION}`);
  });

  it("scopes @match and @connect narrowly", () => {
    expect(META_BLOCK).toContain("@match        https://fantasy.espn.com/football/draft*");
    expect(META_BLOCK).toContain("@connect      draft.neelamjai.com");
    expect(META_BLOCK).not.toContain("@connect      *");
    expect(DRAFT_HOST).toBe("fantasydraft.espn.com");
  });

  it("omits @require, which delays injection past document-start", () => {
    expect(META_BLOCK).not.toContain("@require");
  });
});

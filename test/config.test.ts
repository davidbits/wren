import { describe, expect, it } from "bun:test";
import { enabledScopeFor, normalizePath, type ProjectRegistry } from "../src/config.ts";

const reg: ProjectRegistry = {
  projects: {
    "/home/x/proj": { enabled: true, added: "2026-01-01T00:00:00Z" },
    "/home/x/proj/nested": { enabled: true, added: "2026-01-01T00:00:00Z" },
    "/home/x/off": { enabled: false, added: "2026-01-01T00:00:00Z" },
  },
};

describe("enabledScopeFor", () => {
  it("matches exact path", () => {
    expect(enabledScopeFor("/home/x/proj", reg)).toBe("/home/x/proj");
  });

  it("matches a subdirectory to its project root", () => {
    expect(enabledScopeFor("/home/x/proj/src/deep", reg)).toBe("/home/x/proj");
  });

  it("prefers the most specific enabled root", () => {
    expect(enabledScopeFor("/home/x/proj/nested/a", reg)).toBe("/home/x/proj/nested");
  });

  it("returns null for disabled project", () => {
    expect(enabledScopeFor("/home/x/off", reg)).toBeNull();
  });

  it("returns null for unknown path", () => {
    expect(enabledScopeFor("/somewhere/else", reg)).toBeNull();
  });

  it("normalizes trailing slashes", () => {
    expect(normalizePath("/home/x/proj/")).toBe("/home/x/proj");
  });
});

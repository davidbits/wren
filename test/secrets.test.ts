import { describe, expect, it } from "bun:test";
import { containsSecret, scrub } from "../src/util/secrets.ts";

describe("secret scrub", () => {
  it("redacts OpenAI-style keys", () => {
    const out = scrub("key is sk-abcdefghij1234567890ABCD here");
    expect(out).not.toContain("sk-abcdefghij1234567890ABCD");
    expect(out).toContain("«redacted»");
  });

  it("redacts Anthropic keys", () => {
    expect(scrub("sk-ant-api03-aaaaaaaaaaaaaaaaaaaa")).toContain("«redacted»");
  });

  it("redacts GitHub tokens", () => {
    expect(scrub("ghp_0123456789abcdefghij0123456789abcd")).toContain("«redacted»");
  });

  it("redacts key=value assignments but keeps the key name", () => {
    const out = scrub('password="hunter2supersecret"');
    expect(out).toContain("password");
    expect(out).not.toContain("hunter2supersecret");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(scrub(pem)).toBe("«redacted»");
  });

  it("redacts credentials in URLs", () => {
    const out = scrub("https://user:p4ssw0rdValue@example.com/repo");
    expect(out).not.toContain("p4ssw0rdValue");
  });

  it("leaves clean text untouched", () => {
    const clean = "This is a normal sentence about TypeScript and bun.";
    expect(scrub(clean)).toBe(clean);
    expect(containsSecret(clean)).toBe(false);
  });

  it("containsSecret detects a secret", () => {
    expect(containsSecret("token: abcdef123456ZZZ")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { assertPublicUrl, UnsafeTargetError } from "../src/lib/ssrf.ts";

describe("assertPublicUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://localhost:4021/",
    "http://169.254.169.254/latest/meta-data",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://0.0.0.0/",
  ])("blocks %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(UnsafeTargetError);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/"])("rejects protocol %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(UnsafeTargetError);
  });

  it("allows public addresses", async () => {
    await expect(assertPublicUrl("http://1.1.1.1/")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://[2606:4700:4700::1111]/")).resolves.toBeInstanceOf(URL);
  });
});

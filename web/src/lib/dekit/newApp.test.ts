import { describe, expect, it } from "vitest";
import { suggestAppName, suggestPath, validUrlName } from "./newApp";

describe("Add an app defaults", () => {
  it("names the task after the folder", () => {
    expect(suggestPath("/home/dev/code/shop/apps/api", "/home/dev/code", new Set())).toBe("api");
    expect(suggestPath("/home/dev/code/shop/apps/api", "/home/dev/code", new Set(["api", "api-2"]))).toBe("api-3");
    expect(suggestPath("/home/dev/code", "/home/dev/code", new Set())).toBe("code");
    expect(suggestPath("/home/dev/code/My Site", "/home/dev/code", new Set())).toBe("my-site");
  });
  it("names the URL under the top folder", () => {
    expect(suggestAppName("/home/dev/code/shop/apps/api", "/home/dev/code")).toBe("api.shop");
    expect(suggestAppName("/home/dev/code/blog", "/home/dev/code")).toBe("blog");
    expect(suggestAppName("/home/dev/code", "/home/dev/code")).toBe("code");
  });
  it("checks portless names", () => {
    expect(validUrlName("api.shop")).toBeNull();
    expect(validUrlName("api.shop.localhost")).toBeNull();
    expect(validUrlName("")).toMatch(/Enter/);
    expect(validUrlName("Api")).toMatch(/lowercase/);
    expect(validUrlName("-api")).toMatch(/lowercase/);
  });
});

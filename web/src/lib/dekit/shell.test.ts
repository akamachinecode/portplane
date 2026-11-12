import { describe, expect, it } from "vitest";
import { joinCommand, quoteWord, shellMetachar, splitCommandLine } from "./shell";

describe("splitCommandLine", () => {
  it("splits like sh", () => {
    expect(splitCommandLine(`pnpm run dev --host 127.0.0.1`).words).toEqual(["pnpm", "run", "dev", "--host", "127.0.0.1"]);
    expect(splitCommandLine(`sh -c 'exec x "$PORT"'`).words).toEqual(["sh", "-c", 'exec x "$PORT"']);
    expect(splitCommandLine(`echo "a \\"b\\" c" d\\ e ''`).words).toEqual(["echo", 'a "b" c', "d e", ""]);
    expect(splitCommandLine("  a\t b  ").words).toEqual(["a", "b"]);
  });
  it("reports an open quote", () => {
    expect(splitCommandLine(`echo 'oops`).error).toMatch(/single quote/);
    expect(splitCommandLine(`echo "oops`).error).toMatch(/double quote/);
  });
});

describe("shellMetachar", () => {
  it("finds the shell syntax dekit refuses, outside quotes", () => {
    expect(shellMetachar("npm run dev")).toBe("");
    expect(shellMetachar("npm i && npm run dev")).toBe("&");
    expect(shellMetachar("a | b")).toBe("|");
    expect(shellMetachar(`echo "$HOME"`)).toBe("$");
    expect(shellMetachar("echo 'a | b'")).toBe("");
    expect(shellMetachar("node x#y")).toBe("");
    expect(shellMetachar("run # comment")).toBe("#");
  });
});

describe("quoteWord", () => {
  it("quotes only when needed", () => {
    expect(quoteWord("dev")).toBe("dev");
    expect(quoteWord("a b")).toBe("'a b'");
    expect(quoteWord("it's")).toBe(`'it'\\''s'`);
    expect(quoteWord("")).toBe("''");
    expect(joinCommand(["sh", "-c", "exec x $PORT"])).toBe("sh -c 'exec x $PORT'");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { MachineCandidate } from "../api/types";
import { cleanFolders, defaultMachineName, groupCandidates, hostProblem, osLabel, remoteFolderProblem } from "./machines";
import { openResolved, type PopupWindow } from "./popup";

describe("groupCandidates", () => {
  const c = (host: string, source: MachineCandidate["source"], extra: Partial<MachineCandidate> = {}): MachineCandidate => ({
    host,
    name: host,
    source,
    ...extra,
  });

  it("groups by source, ~/.ssh/config first, online peers first", () => {
    const groups = groupCandidates(
      [
        c("pi", "tailscale", { online: false }),
        c("box", "ssh-config"),
        c("mini", "tailscale"),
        c("box.tail.ts.net", "tailscale", { online: true }),
        c("build", "ssh-config"),
      ],
      [],
    );
    expect(groups.map((g) => g.source)).toEqual(["ssh-config", "tailscale"]);
    expect(groups[0].title).toBe("From ~/.ssh/config");
    expect(groups[0].items.map((i) => i.candidate.host)).toEqual(["box", "build"]);
    expect(groups[1].items.map((i) => i.candidate.host)).toEqual(["box.tail.ts.net", "mini", "pi"]);
  });

  it("marks hosts that are already added, and drops repeats and empty groups", () => {
    const groups = groupCandidates([c("box", "ssh-config"), c("box", "ssh-config"), c("build", "ssh-config")], [
      { id: "box", name: "Box", host: "box", folders: [] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].items[0].added?.name).toBe("Box");
    expect(groups[0].items[1].added).toBeUndefined();
    expect(groupCandidates([], [])).toEqual([]);
  });
});

describe("defaultMachineName", () => {
  it("picks the name the server would", () => {
    expect(defaultMachineName("box")).toBe("box");
    expect(defaultMachineName("dev@box.example.com")).toBe("box");
    expect(defaultMachineName(" box.tail.ts.net ")).toBe("box");
    expect(defaultMachineName("10.0.0.5")).toBe("10");
  });
});

describe("validation", () => {
  it("rejects hosts ssh would misread", () => {
    expect(hostProblem("")).toMatch(/Enter an SSH host/);
    expect(hostProblem("-oProxyCommand=x")).toMatch(/isn't an SSH host/);
    expect(hostProblem("box; rm")).toMatch(/isn't an SSH host/);
    expect(hostProblem("dev@box")).toBeNull();
  });

  it("wants absolute folders on the other machine", () => {
    expect(remoteFolderProblem("")).toBeNull();
    expect(remoteFolderProblem("/home/dev/code")).toBeNull();
    expect(remoteFolderProblem("~/code")).toMatch(/~ isn't expanded/);
    expect(remoteFolderProblem("code")).toMatch(/absolute path/);
  });

  it("cleans folder lists", () => {
    expect(cleanFolders([" /a ", "", "/b", "/a", "  "])).toEqual(["/a", "/b"]);
  });

  it("names operating systems", () => {
    expect(osLabel("darwin")).toBe("macOS");
    expect(osLabel("linux")).toBe("Linux");
    expect(osLabel("freebsd")).toBe("freebsd");
    expect(osLabel(undefined)).toBeUndefined();
  });
});

describe("openResolved", () => {
  function fakeWindow(): PopupWindow & { closed: boolean } {
    return {
      opener: "portplane",
      location: { href: "about:blank" },
      document: { title: "", body: { textContent: "" } },
      closed: false,
      close() {
        this.closed = true;
      },
    };
  }

  it("opens a blank window first, then sends it to the URL without an opener", async () => {
    const win = fakeWindow();
    const order: string[] = [];
    const url = await openResolved(
      async () => {
        order.push("resolve");
        expect(win.document!.title).toBe("Opening port 5432…");
        return "http://127.0.0.1:41234";
      },
      {
        open: () => {
          order.push("open");
          return win;
        },
        openElsewhere: vi.fn(),
      },
      "Opening port 5432…",
    );
    expect(order).toEqual(["open", "resolve"]);
    expect(url).toBe("http://127.0.0.1:41234");
    expect(win.location.href).toBe("http://127.0.0.1:41234");
    expect(win.opener).toBeNull();
  });

  it("closes the blank window when the request fails", async () => {
    const win = fakeWindow();
    await expect(openResolved(() => Promise.reject(new Error("offline")), { open: () => win, openElsewhere: vi.fn() })).rejects.toThrow("offline");
    expect(win.closed).toBe(true);
  });

  it("asks Portplane to open the URL when the popup was blocked", async () => {
    const elsewhere = vi.fn(async () => {});
    await openResolved(async () => "http://127.0.0.1:1", { open: () => null, openElsewhere: elsewhere });
    expect(elsewhere).toHaveBeenCalledWith("http://127.0.0.1:1");
  });
});

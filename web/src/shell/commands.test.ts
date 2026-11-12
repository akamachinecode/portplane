import { afterEach, describe, expect, it } from "vitest";
import { collectCommands, filterCommands, rankCommand, registerCommandSource, type Command, type CommandContext } from "./commands";

const cmd = (p: Partial<Command> & Pick<Command, "id" | "title" | "group">): Command => ({ run: () => {}, ...p });

const COMMANDS: Command[] = [
  cmd({ id: "go.apps", title: "Apps", group: "Go to" }),
  cmd({ id: "go.health", title: "Health", group: "Go to" }),
  cmd({ id: "go.settings", title: "Settings", group: "Go to", keywords: ["preferences"] }),
  cmd({ id: "machines.add", title: "Add a machine", group: "Machines" }),
  cmd({ id: "dev.job", title: "Run a demo job", group: "Developer" }),
  cmd({ id: "app.web", title: "web", group: "Apps", hint: "my-monorepo · This computer" }),
  cmd({ id: "app.api", title: "api", group: "Apps", hint: "shop · box" }),
  cmd({ id: "app.api.restart", title: "Restart api", group: "Apps", hint: "my-monorepo · This computer", searchOnly: true }),
  cmd({ id: "app.web.restart", title: "Restart web", group: "Apps", hint: "my-monorepo · This computer", searchOnly: true }),
  cmd({ id: "app.api.copy", title: "Copy URL of api", group: "Apps", hint: "shop · box", searchOnly: true }),
];

const ids = (groups: ReturnType<typeof filterCommands>) => groups.flatMap((g) => g.items.map((i) => i.command.id));

describe("filterCommands", () => {
  it("lists everything but search-only commands when nothing is typed, groups in a fixed order", () => {
    const groups = filterCommands(COMMANDS, "");
    expect(groups.map((g) => g.name)).toEqual(["Go to", "Apps", "Machines", "Developer"]);
    expect(ids(groups)).not.toContain("app.api.restart");
  });

  it("finds search-only commands once the user types, best first", () => {
    const groups = filterCommands(COMMANDS, "rst api");
    expect(ids(groups)[0]).toBe("app.api.restart");
  });

  it("drops letters scattered through a hint when better matches exist", () => {
    // "Restart web" only matches "rst api" through "monorepo · This"
    expect(ids(filterCommands(COMMANDS, "rst api"))).not.toContain("app.web.restart");
  });

  it("matches the hint and keywords, and highlights the hint", () => {
    const shop = filterCommands(COMMANDS, "api box");
    expect(ids(shop)[0]).toBe("app.api");
    expect(shop[0].items[0].hintIndices).toEqual([7, 8, 9]);
    expect(ids(filterCommands(COMMANDS, "prefs"))).toEqual(["go.settings"]);
  });

  it("puts a group where its best match ranks", () => {
    const groups = filterCommands(COMMANDS, "add");
    expect(groups[0].name).toBe("Machines");
  });

  it("caps the list", () => {
    const many = Array.from({ length: 300 }, (_, i) => cmd({ id: `x${i}`, title: `Item ${i}`, group: "Apps" }));
    expect(ids(filterCommands(many, "item", 50))).toHaveLength(50);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(COMMANDS, "zzzz")).toEqual([]);
  });
});

describe("rankCommand", () => {
  it("prefers a match in the title to one through the hint", () => {
    const inTitle = rankCommand(cmd({ id: "a", title: "box", group: "Machines" }), "box")!;
    const inHint = rankCommand(cmd({ id: "b", title: "api", group: "Apps", hint: "shop · box" }), "box")!;
    expect(inTitle.score).toBeGreaterThan(inHint.score);
    expect(inTitle.titleIndices).toEqual([0, 1, 2]);
    expect(inHint.titleIndices).toEqual([]);
  });
});

describe("command sources", () => {
  const unregister: Array<() => void> = [];
  afterEach(() => {
    for (const u of unregister.splice(0)) u();
  });
  const ctx = {} as CommandContext;

  it("collects every source, a later id replacing an earlier one", () => {
    unregister.push(registerCommandSource("test.a", () => [cmd({ id: "same", title: "First", group: "Actions" }), cmd({ id: "only-a", title: "A", group: "Actions" })]));
    unregister.push(registerCommandSource("test.b", () => [cmd({ id: "same", title: "Second", group: "Actions" })]));
    const list = collectCommands(ctx);
    expect(list.find((c) => c.id === "same")?.title).toBe("Second");
    expect(list.some((c) => c.id === "only-a")).toBe(true);
  });

  it("skips a source that throws and removes a source when asked", () => {
    unregister.push(
      registerCommandSource("test.broken", () => {
        throw new Error("boom");
      }),
    );
    const remove = registerCommandSource("test.gone", () => [cmd({ id: "gone", title: "Gone", group: "Actions" })]);
    const original = console.error;
    console.error = () => {};
    try {
      expect(collectCommands(ctx).some((c) => c.id === "gone")).toBe(true);
      remove();
      expect(collectCommands(ctx).some((c) => c.id === "gone")).toBe(false);
    } finally {
      console.error = original;
    }
  });
});

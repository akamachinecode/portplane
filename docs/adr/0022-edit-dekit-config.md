# ADR-0022: Edit dekit config from the UI, keeping the user's file as they wrote it

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amends:** [ADR-0009](0009-generated-config-location.md). Setup still writes only Portplane's fragment, and a generated task still never replaces a hand-written one. What is new: the user can edit any task from the app, hand-written ones in `dekit.yaml` included.

## What it has to do

M5 asks for everything a user does with dekit to be possible in the app, and most of that is editing config: every task key (`cmd`, `cwd`, `env`, `deps`, `ready`, `autorestart`, `stop`, `log`…) and the project's own settings (`defaults`, `vars`, hooks, `load`).

- Edit tasks in Portplane's fragment, `.portplane/tasks.yaml`.
- Edit tasks the user wrote by hand, in `dekit.yaml` or in their own fragments, without losing comments, order or formatting.
- Show every change as a diff before writing it, and dekit's own view of the change before applying it.
- Never write a file that changed since Portplane read it.
- Where an edit could change meaning, refuse and offer a way out.
- The file stays the truth: someone who goes back to the terminal finds plain dekit config.

Facts:

- `dekit.yaml` may use `!js` tags, `vars`, `load:` fragments with globs and `at:` mounts, and `cmd` as a string or a list (ADR-0006).
- `dekit reload` shows the plan of a config change and applies it with `--yes` (ADR-0009). Whether `dekit reload --json` has a format we can rely on needs checking before M5.3.
- `dekit help --json` lists every field with its key, type, default and description, for the installed dekit.
- dekit publishes a JSON schema for `dekit.yaml` at `https://dekit.run/schemas/dekit.json`.
- `gopkg.in/yaml.v3` reads YAML into a tree of nodes that keeps comments, key order, tags and scalar styles, and writes that tree back.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| The user's file survives an edit | High | Comments and order are the user's work; vision: no lock-in |
| No silent change | High | Every write is shown first (ADR-0009) |
| Same meaning as dekit reads it | High | A wrong edit breaks a project |
| Covers every task key | Medium | M5's coverage goal |
| Code to maintain | Medium | One maintainer |

## Options

| | Edit only in the fragment: move a hand-written task there first | Edit the nodes with yaml.v3, keep the rest | Regenerate the file from a model | A text editor only |
|---|---|---|---|---|
| Hand-written file | Untouched, but the task leaves it | Edited in place | Rewritten | Edited by the user |
| Comments and order | Kept | Kept on the nodes; spacing may change | Lost | Kept |
| Forms | Yes | Yes | Yes | No |
| Code | Small | Medium | Medium | Small |

## Verdict

**Forms for tasks and projects, written back node by node with yaml.v3, always behind a diff and dekit's reload review. Where a node-level edit could change meaning, the form is read-only and offers "Open in editor".**

- **Where it writes.** A task from Portplane's fragment is edited in the fragment, freely. A hand-written task is edited in the file that declares it.
- **How it writes.** Portplane parses the file into yaml.v3 nodes and changes only the nodes of the edited fields. It then writes back only the lines of the edited entry (one task, say), at the same indentation, and leaves every other byte of the file as it was (`internal/dekit/edit.go`). Inside the entry, yaml.v3 keeps comments, key order, tags, quoting and flow style; it may change spacing, such as two spaces before a comment or the indentation of a block list. The spike on this (S4) found that writing the whole tree back changed lines outside the task, which is why only the entry's lines are written.
- **Read-only, with "Open in editor"**, when the edited part:
  - uses `!js`;
  - is a key inside a flow mapping (`{…}`), which has no line of its own (a flow value as a whole, such as `cmd: [pnpm, run, dev]`, can be replaced and keeps its style);
  - uses YAML anchors or aliases;
  - comes through a `load` that Portplane cannot map back to one file and one place in it.

  The form still shows every value it can read.
- **Before writing:**
  1. the diff of the file;
  2. dekit's reload review: the runner's plan for the change;
  3. "Apply and restart affected tasks", which writes the file, runs `dekit reload --yes` and restarts what changed.

  The write happens only if the file still matches the digest Portplane read, as in setup (ADR-0014).
- **Help from dekit.** Field help comes from `dekit help --json`, so it matches the installed dekit.
- **Raw YAML.** A YAML tab uses CodeMirror with a copy of dekit's schema shipped in the binary. It validates as you type and shows the diff before saving.
- **Changes on disk.** When `dekit.yaml` changes outside the app, a banner offers "Review and reload", which opens the reload review.
- **Unchanged from ADR-0009.** Setup writes only Portplane's fragment and the one `load:` line. A generated task never replaces a hand-written one.
- **Local machine first.** Remote machines follow with remote parity (M5.6).

**Cost we accept:**

- Portplane's YAML reader and writer must agree with dekit's parser. Tests use real configs. This widens the gap ADR-0006 already accepts.
- Some valid files are read-only in the app: `!js` values, anchors and aliases, keys inside flow mappings.
- Writing a node back may change spacing inside the edited task. The diff shows it, and the user can cancel.
- CodeMirror, a new UI dependency, loaded only with the editor.

**What would make us revisit it:** dekit offering its own way to edit its config that keeps the file as written; the spike finding that yaml.v3 changes too much; reports of edits that changed what a task does.

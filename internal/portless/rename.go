package portless

import (
	"errors"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// Changing an app's name (plan §5.4). Where the name lives decides what
// Portplane edits:
//
//	fragment    `portless <name> …` in Portplane's .portplane/tasks.yaml
//	task        `portless <name> …` or `portless run --name <name>` in a
//	            dekit file the user wrote (edited node by node, ADR-0022)
//	config      `portless run` without a name: portless.json's "name", or
//	            package.json's "portless" key
//	alias-task  a `portless alias <name> <port>` job the app depends on
//	alias       a static route registered by hand: removed and added again
//	compose     a docker compose label (shown, edited in M5.6)
//	none        the app has no portless name

// Name sources.
const (
	SourceFragment  = "fragment"
	SourceTask      = "task"
	SourceConfig    = "config"
	SourceAliasTask = "alias-task"
	SourceAlias     = "alias"
	SourceCompose   = "compose"
	SourceNone      = "none"
)

// FragmentFile is where Portplane's setup writes its tasks, relative to the
// project's dekit.yaml.
const FragmentFile = ".portplane/tasks.yaml"

// IsFragment reports whether file is Portplane's own fragment.
func IsFragment(file string) bool {
	return strings.HasSuffix(strings.ReplaceAll(file, `\`, "/"), "/"+FragmentFile)
}

// NameArg finds the argument of argv that holds the portless name: the
// name after `portless`, the value of `--name` (or `--name=…`) in run mode,
// or the alias name of `portless alias <name> <port>`. prefix is "--name="
// when the name shares its argument with the flag. ok is false when argv
// does not name the app.
func NameArg(argv []string) (index int, prefix string, ok bool) {
	i := indexOfPortless(argv)
	if i < 0 || i+1 >= len(argv) {
		return 0, "", false
	}
	switch rest := argv[i+1]; {
	case rest == "alias":
		if i+2 < len(argv) && !strings.HasPrefix(argv[i+2], "-") {
			return i + 2, "", true
		}
		return 0, "", false
	case rest == "run":
		for j := i + 2; j < len(argv); j++ {
			a := argv[j]
			switch {
			case a == "--name" && j+1 < len(argv):
				return j + 1, "", true
			case strings.HasPrefix(a, "--name="):
				return j, "--name=", true
			case a == "--" || !strings.HasPrefix(a, "-"):
				return 0, "", false
			case a == "--app-port":
				j++
			}
		}
		return 0, "", false
	case strings.HasPrefix(rest, "-") || subcommands[rest]:
		return 0, "", false
	default:
		return i + 1, "", true
	}
}

// AliasArgs recognises `portless alias <name> <port>`: its name and port.
func AliasArgs(argv []string) (string, string, bool) {
	i := indexOfPortless(argv)
	if i < 0 || i+3 >= len(argv) || argv[i+1] != "alias" || strings.HasPrefix(argv[i+2], "-") {
		return "", "", false
	}
	return argv[i+2], argv[i+3], true
}

// RenameInCmd returns the dekit file src with the portless name in the cmd
// of the task at key (under tasks:) changed from old to name. The task's
// cmd must name the app (see NameArg); a cmd written as one string is
// edited when the name appears in it exactly once as a word. Anything
// Portplane can't change safely gives dekit.ErrNotEditable.
func RenameInCmd(src []byte, key string, argv []string, old, name string) ([]byte, error) {
	words, wrapped := unwrapCmd(argv)
	idx, prefix, ok := NameArg(words)
	if !ok || words[idx] != prefix+old {
		return nil, errors.New("this task's command doesn't hold the name " + old)
	}
	return dekit.EditBlock(src, []string{"tasks", key}, func(task *yaml.Node) error {
		if task.Kind != yaml.MappingNode {
			return dekit.ErrNotEditable
		}
		var cmd *yaml.Node
		for j := 0; j+1 < len(task.Content); j += 2 {
			if task.Content[j].Value == "cmd" {
				cmd = task.Content[j+1]
			}
		}
		if cmd == nil || cmd.Tag == "!js" {
			return dekit.ErrNotEditable
		}
		switch cmd.Kind {
		case yaml.SequenceNode:
			if !wrapped && idx < len(cmd.Content) && cmd.Content[idx].Kind == yaml.ScalarNode && cmd.Content[idx].Value == prefix+old {
				cmd.Content[idx].Value = prefix + name
				return nil
			}
			// `cmd /c "portless web pnpm run dev"` on Windows: the name
			// is a word inside one item.
			for _, item := range cmd.Content {
				if item.Kind == yaml.ScalarNode {
					if v, ok := replaceWord(item.Value, prefix+old, prefix+name); ok {
						item.Value = v
						return nil
					}
				}
			}
			return dekit.ErrNotEditable
		case yaml.ScalarNode:
			v, ok := replaceWord(cmd.Value, prefix+old, prefix+name)
			if !ok {
				return dekit.ErrNotEditable
			}
			cmd.Value = v
			return nil
		}
		return dekit.ErrNotEditable
	})
}

// unwrapCmd turns `cmd /c "<command>"` (how dekit runs .cmd shims on
// Windows, ADR-0010) into the command's words.
func unwrapCmd(argv []string) ([]string, bool) {
	if len(argv) == 3 && strings.EqualFold(strings.TrimSuffix(strings.ToLower(argv[0]), ".exe"), "cmd") && strings.EqualFold(argv[1], "/c") {
		return strings.Fields(argv[2]), true
	}
	return argv, false
}

// replaceWord replaces word in s when it appears exactly once as a whole
// word, not quoted.
func replaceWord(s, word, with string) (string, bool) {
	re := regexp.MustCompile(`(^|\s)` + regexp.QuoteMeta(word) + `(\s|$)`)
	locs := re.FindAllStringSubmatchIndex(s, -1)
	if len(locs) != 1 {
		return s, false
	}
	l := locs[0]
	// group 1 ends where the word starts; group 2 starts where it ends
	return s[:l[3]] + with + s[l[4]:], true
}

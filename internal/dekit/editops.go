package dekit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// EditOp is one change to a config file, as the editor sends it. Paths
// are mapping keys from the top of the file, such as ["tasks", "web"].
type EditOp struct {
	// Op is one of:
	//   set     Key of the mapping at Path becomes Value
	//   unset   Key of the mapping at Path goes away
	//   insert  Key: Value is added to the mapping at Path (After or Before a sibling)
	//   delete  the entry at Path goes away, with its comments
	//   rename  the entry at Path takes the key To
	//   move    the entry at Path moves Before or After a sibling
	//   text    the entry at Path is replaced by Text (the whole entry, key included)
	//   replace the whole file becomes Text
	//   load    File (At) is added to load:
	Op     string          `json:"op"`
	Path   []string        `json:"path,omitempty"`
	Key    string          `json:"key,omitempty"`
	Value  json.RawMessage `json:"value,omitempty"`
	To     string          `json:"to,omitempty"`
	Before string          `json:"before,omitempty"`
	After  string          `json:"after,omitempty"`
	Text   string          `json:"text,omitempty"`
	File   string          `json:"file,omitempty"`
	At     string          `json:"at,omitempty"`
}

// ApplyOps applies ops to a file's text in order.
func ApplyOps(src []byte, ops []EditOp) ([]byte, error) {
	out := src
	for i, op := range ops {
		next, err := applyOp(out, op)
		if err != nil {
			if len(ops) > 1 {
				return nil, fmt.Errorf("change %d (%s): %w", i+1, op.Op, err)
			}
			return nil, err
		}
		out = next
	}
	return out, nil
}

func applyOp(src []byte, op EditOp) ([]byte, error) {
	switch op.Op {
	case "set":
		n, err := JSONNode(op.Value)
		if err != nil {
			return nil, err
		}
		if n.Tag == "!!null" && len(op.Value) == 0 {
			return nil, errors.New("set needs a value")
		}
		return SetKey(src, op.Path, op.Key, n)
	case "unset":
		return SetKey(src, op.Path, op.Key, nil)
	case "insert":
		n, err := JSONNode(op.Value)
		if err != nil {
			return nil, err
		}
		out, err := InsertEntry(src, op.Path, op.Key, n)
		if err != nil {
			return nil, err
		}
		after := op.After
		if after == "" && op.Before == "" {
			// At the end, spaced like the other entries.
			after = lastKey(out, op.Path, op.Key)
			if after == "" {
				return out, nil
			}
		}
		return MoveEntry(out, append(append([]string{}, op.Path...), op.Key), op.Before, after)
	case "delete":
		return DeleteEntry(src, op.Path)
	case "rename":
		if strings.TrimSpace(op.To) == "" {
			return nil, errors.New("enter the new name")
		}
		return RenameKey(src, op.Path, op.To)
	case "move":
		return MoveEntry(src, op.Path, op.Before, op.After)
	case "text":
		return ReplaceEntryText(src, op.Path, op.Text)
	case "replace":
		return []byte(op.Text), nil
	case "load":
		return AppendLoad(src, op.File, op.At)
	}
	return nil, fmt.Errorf("unknown change %q", op.Op)
}

// MoveEntry moves the entry at path, with the comment lines above it,
// before or after a sibling in the same mapping. Blank lines between
// entries are kept the way the mapping uses them.
func MoveEntry(src []byte, path []string, before, after string) ([]byte, error) {
	if (before == "") == (after == "") {
		return nil, errors.New("move needs one of before or after")
	}
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	parent, i, err := find(doc, path)
	if err != nil {
		return nil, err
	}
	if parent.Style&yaml.FlowStyle != 0 {
		return nil, ErrNotEditable
	}
	sib := before + after
	j := -1
	for k := 0; k+1 < len(parent.Content); k += 2 {
		if parent.Content[k].Value == sib {
			j = k
		}
	}
	if j < 0 {
		return nil, fmt.Errorf("%q is not next to %q", sib, path[len(path)-1])
	}
	if j == i {
		return src, nil
	}
	lines := splitLines(src)
	// Do the entries have a blank line between them?
	spaced := false
	for k := 2; k+1 < len(parent.Content); k += 2 {
		if k == i || k == i+2 {
			continue // around the moving entry, which may be new
		}
		if s := entryStart(parent, k); s > 0 && blank(lines[s-1]) {
			spaced = true
		}
	}
	start := entryStart(parent, i)
	end := blockEnd(lines, parent, i)
	block := append([][]byte{}, lines[start:end]...)
	if n := len(block); n > 0 && !bytes.HasSuffix(block[n-1], []byte("\n")) {
		block[n-1] = append(append([]byte{}, block[n-1]...), '\n')
	}
	at := blockEnd(lines, parent, j)
	if before != "" {
		at = entryStart(parent, j)
	}
	// Cut the entry, and the blank line that separated it.
	cut, cutEnd := start, end
	switch {
	case cut > 0 && blank(lines[cut-1]) && (end == len(lines) || blank(lines[end])):
		cut--
	case i == 0 && end < len(lines) && blank(lines[end]):
		cutEnd++ // the first entry: the blank line after it goes
	}
	rest := append(append([][]byte{}, lines[:cut]...), lines[cutEnd:]...)
	if at >= cutEnd {
		at -= cutEnd - cut
	} else if at > cut {
		at = cut
	}
	if at > 0 && at <= len(rest) && !bytes.HasSuffix(rest[at-1], []byte("\n")) {
		rest[at-1] = append(append([]byte{}, rest[at-1]...), '\n')
	}
	if spaced {
		hasPrev, hasNext := after != "", before != ""
		for k := 0; k+1 < len(parent.Content); k += 2 {
			if k != i && before != "" && k < j {
				hasPrev = true
			}
			if k != i && after != "" && k > j {
				hasNext = true
			}
		}
		if hasPrev && at > 0 && !blank(rest[at-1]) {
			block = append([][]byte{[]byte("\n")}, block...)
		}
		if hasNext && at < len(rest) && !blank(rest[at]) {
			block = append(block, []byte("\n"))
		}
	}
	out := append(append([][]byte{}, rest[:at]...), block...)
	out = append(out, rest[at:]...)
	return bytes.Join(out, nil), nil
}

func blank(l []byte) bool { return len(bytes.TrimSpace(l)) == 0 }

// lastKey is the key before key at the end of the mapping at path.
func lastKey(src []byte, path []string, key string) string {
	doc, err := parseDoc(src)
	if err != nil || len(path) == 0 {
		return ""
	}
	parent, i, err := find(doc, append(append([]string{}, path...), key))
	if err != nil || i < 2 {
		return ""
	}
	return parent.Content[i-2].Value
}

func entryStart(parent *yaml.Node, i int) int {
	return parent.Content[i].Line - 1 - commentLines(parent.Content[i].HeadComment)
}

// ReplaceEntryText replaces the entry at path with text, written as-is
// (the key line included, at the entry's indentation). It is how vars,
// !js values and hooks are edited: as text, never re-encoded.
func ReplaceEntryText(src []byte, path []string, text string) ([]byte, error) {
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	parent, i, err := find(doc, path)
	if err != nil {
		return nil, err
	}
	key := path[len(path)-1]
	var check yaml.Node
	if err := yaml.Unmarshal([]byte(dedent(text)), &check); err != nil {
		return nil, fmt.Errorf("not valid YAML: %s", strings.TrimPrefix(err.Error(), "yaml: "))
	}
	if len(check.Content) != 1 || check.Content[0].Kind != yaml.MappingNode || len(check.Content[0].Content) != 2 || check.Content[0].Content[0].Value != key {
		return nil, fmt.Errorf("keep it one entry that starts with %q", key+":")
	}
	lines := splitLines(src)
	start := parent.Content[i].Line - 1
	end := blockEnd(lines, parent, i)
	body := []byte(dedent(text))
	if !bytes.HasSuffix(body, []byte("\n")) {
		body = append(body, '\n')
	}
	block := indent(body, parent.Content[i].Column-1)
	out := append(append([][]byte{}, lines[:start]...), block)
	out = append(out, lines[end:]...)
	return bytes.Join(out, nil), nil
}

// dedent removes the indentation the text's first line has from every line.
func dedent(text string) string {
	lines := strings.Split(text, "\n")
	n := -1
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		n = len(l) - len(strings.TrimLeft(l, " "))
		break
	}
	if n <= 0 {
		return text
	}
	for i, l := range lines {
		if len(l) >= n && strings.TrimSpace(l[:n]) == "" {
			lines[i] = l[n:]
		}
	}
	return strings.Join(lines, "\n")
}

// AppendLoad adds a fragment to load:, creating the list when there is
// none. A file already listed is left as it is.
func AppendLoad(src []byte, file, at string) ([]byte, error) {
	file = strings.TrimSpace(file)
	if file == "" {
		return nil, errors.New("enter the fragment's file")
	}
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	item := quoteYAML(file)
	if at != "" {
		item = "{file: " + quoteYAML(file) + ", at: " + quoteYAML(at) + "}"
	}
	load := mapGet(doc, "load")
	if load == nil {
		text := src
		if len(text) > 0 && !bytes.HasSuffix(text, []byte("\n")) {
			text = append(append([]byte{}, text...), '\n')
		}
		return append(append([]byte{}, text...), []byte("load:\n  - "+item+"\n")...), nil
	}
	if load.Kind != yaml.SequenceNode || load.Style&yaml.FlowStyle != 0 || len(load.Content) == 0 {
		return nil, ErrNotEditable
	}
	for _, it := range load.Content {
		v := it.Value
		if it.Kind == yaml.MappingNode {
			if f := mapGet(it, "file"); f != nil {
				v = f.Value
			}
		}
		if strings.TrimPrefix(v, "./") == strings.TrimPrefix(file, "./") {
			return src, nil
		}
	}
	lines := splitLines(src)
	last := load.Content[len(load.Content)-1]
	endLine := maxLine(last)
	col := last.Column - 3 // the dash
	if col < 0 {
		col = 0
	}
	newLine := []byte(strings.Repeat(" ", col) + "- " + item + "\n")
	return insertAt(lines, endLine, newLine), nil
}

func maxLine(n *yaml.Node) int {
	m := n.Line
	for _, c := range n.Content {
		if l := maxLine(c); l > m {
			m = l
		}
	}
	return m
}

func quoteYAML(s string) string {
	n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
	b, err := yaml.Marshal(n)
	if err != nil {
		return s
	}
	return strings.TrimSpace(string(b))
}

// JSONNode turns a JSON value into a YAML node, keeping object key order.
// Short lists of words and small mappings of plain values are written in
// flow style ([a, b], {log: ready}), like dekit's own examples.
func JSONNode(raw json.RawMessage) (*yaml.Node, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	n, err := jsonNode(dec)
	if err != nil {
		return nil, fmt.Errorf("invalid value: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid value: trailing data")
	}
	styleFlow(n)
	return n, nil
}

func jsonNode(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				if k == "$js" { // {"$js": src} stands for a !js value
					v, err := jsonNode(dec)
					if err != nil {
						return nil, err
					}
					if _, err := dec.Token(); err != nil {
						return nil, err
					}
					return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!js", Value: v.Value, Style: yaml.SingleQuotedStyle}, nil
				}
				v, err := jsonNode(dec)
				if err != nil {
					return nil, err
				}
				m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k}, v)
			}
			_, err := dec.Token()
			return m, err
		case '[':
			s := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for dec.More() {
				v, err := jsonNode(dec)
				if err != nil {
					return nil, err
				}
				s.Content = append(s.Content, v)
			}
			_, err := dec.Token()
			return s, err
		}
	case string:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}, nil
	case json.Number:
		if strings.ContainsAny(t.String(), ".eE") {
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: t.String()}, nil
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: t.String()}, nil
	case bool:
		v := "false"
		if t {
			v = "true"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: v}, nil
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	return nil, fmt.Errorf("unexpected %v", tok)
}

func styleFlow(n *yaml.Node) {
	for _, c := range n.Content {
		styleFlow(c)
	}
	if n.Kind != yaml.SequenceNode && n.Kind != yaml.MappingNode {
		return
	}
	width := 0
	for _, c := range n.Content {
		if c.Kind != yaml.ScalarNode {
			return
		}
		width += len(c.Value) + 4
	}
	if n.Kind == yaml.SequenceNode && width <= 100 || n.Kind == yaml.MappingNode && width <= 60 {
		n.Style = yaml.FlowStyle
	}
}

// WriteFileAtomic writes b to path through a temporary file, keeping the
// file's mode, and writes through a symlink to the file it points to.
func WriteFileAtomic(path string, b []byte) error {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

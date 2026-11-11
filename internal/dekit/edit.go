package dekit

import (
	"bytes"
	"errors"
	"fmt"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Editing a dekit file the user wrote (ADR-0022). Only the block that
// changes is written again; every other byte of the file stays as it was,
// comments and blank lines included. Inside the block, yaml.v3 keeps
// comments, key order and scalar styles.

// ErrNotEditable means the change touches something Portplane will not
// rewrite safely: a !js value, an anchor, alias or merge key, a key inside
// a flow-style mapping ({…}), or a document that is not a block mapping.
var ErrNotEditable = errors.New("this part of the file can't be edited from Portplane; open it in your editor")

// EditBlock changes the value at path, a list of mapping keys from the top
// of the file (such as ["tasks", "web"]), with fn, and returns the new file.
// fn gets the value node and may change it in place; it must not replace
// the key.
func EditBlock(src []byte, path []string, fn func(value *yaml.Node) error) ([]byte, error) {
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	parent, i, err := find(doc, path)
	if err != nil {
		return nil, err
	}
	key, val := parent.Content[i], parent.Content[i+1]
	if err := editable(val); err != nil {
		return nil, err
	}
	if err := fn(val); err != nil {
		return nil, err
	}
	if err := editable(val); err != nil {
		return nil, err
	}
	return splice(src, parent, i, key, val)
}

// SetKey sets one key of the mapping at path to value (any value yaml can
// encode); a nil value removes the key. It is EditBlock for the common case.
func SetKey(src []byte, path []string, key string, value any) ([]byte, error) {
	return EditBlock(src, path, func(m *yaml.Node) error {
		if m.Kind != yaml.MappingNode {
			return fmt.Errorf("%s is not a mapping", strings.Join(path, "."))
		}
		for j := 0; j+1 < len(m.Content); j += 2 {
			if m.Content[j].Value != key {
				continue
			}
			if value == nil {
				m.Content = append(m.Content[:j], m.Content[j+2:]...)
				return nil
			}
			if isJS(m.Content[j+1]) {
				return ErrNotEditable
			}
			n, err := ToNode(value)
			if err != nil {
				return err
			}
			// Keep the comments that were on the old value.
			n.LineComment, n.HeadComment, n.FootComment = m.Content[j+1].LineComment, m.Content[j+1].HeadComment, m.Content[j+1].FootComment
			m.Content[j+1] = n
			return nil
		}
		if value == nil {
			return nil
		}
		n, err := ToNode(value)
		if err != nil {
			return err
		}
		m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, n)
		return nil
	})
}

// InsertEntry adds key: value at the end of the mapping at parentPath
// (such as ["tasks"]). The mapping is created at the end of the file when
// it is a missing top-level key.
func InsertEntry(src []byte, parentPath []string, key string, value any) ([]byte, error) {
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	n, err := ToNode(value)
	if err != nil {
		return nil, err
	}
	block, err := render(&yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, n}}, indentUnit(src))
	if err != nil {
		return nil, err
	}
	lines := splitLines(src)
	if len(parentPath) == 0 {
		return joinAppend(lines, block, 0), nil
	}
	gparent, i, err := find(doc, parentPath)
	if errors.Is(err, errNotFound) && len(parentPath) == 1 {
		top := doc
		for j := 0; j+1 < len(top.Content); j += 2 {
			if top.Content[j].Value == parentPath[0] {
				return nil, ErrNotEditable // there, but not a block mapping
			}
		}
		head := []byte(parentPath[0] + ":\n")
		return joinAppend(lines, append(head, indent(block, indentUnit(src))...), 0), nil
	}
	if err != nil {
		return nil, err
	}
	m := gparent.Content[i+1]
	if m.Kind == yaml.ScalarNode && m.Tag == "!!null" { // "tasks:" with nothing yet
		end := blockEnd(lines, gparent, i)
		col := gparent.Content[i].Column - 1 + indentUnit(src)
		return insertAt(lines, end, indent(block, col)), nil
	}
	if m.Kind != yaml.MappingNode || m.Style&yaml.FlowStyle != 0 {
		return nil, ErrNotEditable
	}
	for j := 0; j+1 < len(m.Content); j += 2 {
		if m.Content[j].Value == key {
			return nil, fmt.Errorf("%s already has %q", strings.Join(parentPath, "."), key)
		}
	}
	col := gparent.Content[i].Column - 1 + indentUnit(src)
	if len(m.Content) > 0 {
		col = m.Content[0].Column - 1
	}
	end := blockEnd(lines, gparent, i)
	return insertAt(lines, end, indent(block, col)), nil
}

// DeleteEntry removes the entry at path, with the comment lines above it.
func DeleteEntry(src []byte, path []string) ([]byte, error) {
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	parent, i, err := find(doc, path)
	if err != nil {
		return nil, err
	}
	lines := splitLines(src)
	start := parent.Content[i].Line - 1 - commentLines(parent.Content[i].HeadComment)
	end := blockEnd(lines, parent, i)
	out := append(append([][]byte{}, lines[:start]...), lines[end:]...)
	return bytes.Join(out, nil), nil
}

// RenameKey renames the entry at path, keeping its value and comments.
func RenameKey(src []byte, path []string, to string) ([]byte, error) {
	doc, err := parseDoc(src)
	if err != nil {
		return nil, err
	}
	parent, i, err := find(doc, path)
	if err != nil {
		return nil, err
	}
	for j := 0; j+1 < len(parent.Content); j += 2 {
		if parent.Content[j].Value == to {
			return nil, fmt.Errorf("%q already exists", to)
		}
	}
	key := *parent.Content[i]
	key.Value = to
	key.Style = 0
	return splice(src, parent, i, &key, parent.Content[i+1])
}

// ToNode turns a Go value into a YAML node.
func ToNode(v any) (*yaml.Node, error) {
	if n, ok := v.(*yaml.Node); ok {
		return n, nil
	}
	var n yaml.Node
	if err := n.Encode(v); err != nil {
		return nil, err
	}
	return &n, nil
}

var errNotFound = errors.New("not found")

func parseDoc(src []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(src)) == 0 {
		return &yaml.Node{Kind: yaml.MappingNode}, nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode || doc.Content[0].Style&yaml.FlowStyle != 0 {
		return nil, ErrNotEditable
	}
	return doc.Content[0], nil
}

// find returns the mapping that holds the last key of path, and the index
// of that key in its Content.
func find(top *yaml.Node, path []string) (*yaml.Node, int, error) {
	m := top
	for depth, k := range path {
		if m.Kind != yaml.MappingNode || m.Style&yaml.FlowStyle != 0 {
			return nil, 0, ErrNotEditable
		}
		found := -1
		for j := 0; j+1 < len(m.Content); j += 2 {
			if m.Content[j].Kind == yaml.ScalarNode && m.Content[j].Value == k {
				found = j
				break
			}
			if m.Content[j].Kind == yaml.AliasNode || m.Content[j].Value == "<<" {
				return nil, 0, ErrNotEditable
			}
		}
		if found < 0 {
			return nil, 0, fmt.Errorf("%s: %w", strings.Join(path[:depth+1], "."), errNotFound)
		}
		if depth == len(path)-1 {
			return m, found, nil
		}
		m = m.Content[found+1]
	}
	return nil, 0, errNotFound
}

// editable refuses nodes Portplane will not rewrite.
func editable(n *yaml.Node) error {
	if n.Anchor != "" || n.Kind == yaml.AliasNode {
		return ErrNotEditable
	}
	if isJS(n) {
		return ErrNotEditable
	}
	for _, c := range n.Content {
		if c.Kind == yaml.AliasNode || c.Anchor != "" || (c.Kind == yaml.ScalarNode && c.Value == "<<") {
			return ErrNotEditable
		}
		if c.Kind == yaml.MappingNode || c.Kind == yaml.SequenceNode {
			if err := editable(c); err != nil {
				return err
			}
		}
	}
	return nil
}

// splice writes key: val again over the lines the entry at parent[i]
// occupies, at the same indentation.
func splice(src []byte, parent *yaml.Node, i int, key, val *yaml.Node) ([]byte, error) {
	lines := splitLines(src)
	oldKey := parent.Content[i]
	start := oldKey.Line - 1
	end := blockEnd(lines, parent, i)
	k := *key
	k.HeadComment = "" // stays in place, above the block
	block, err := render(&yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{&k, val}}, indentUnit(src))
	if err != nil {
		return nil, err
	}
	block = indent(block, oldKey.Column-1)
	out := append(append([][]byte{}, lines[:start]...), block)
	out = append(out, lines[end:]...)
	return bytes.Join(out, nil), nil
}

// blockEnd returns the index of the first line after the entry at
// parent[i]: the next sibling's first line (or its head comment), else the
// first line after the parent's own block.
func blockEnd(lines [][]byte, parent *yaml.Node, i int) int {
	key := parent.Content[i]
	limit := len(lines)
	if i+2 < len(parent.Content) {
		next := parent.Content[i+2]
		limit = next.Line - 1 - commentLines(next.HeadComment)
	} else {
		// The last entry ends where a line starts at or left of its key.
		for l := key.Line; l < len(lines); l++ {
			t := bytes.TrimRight(lines[l], "\r\n")
			if len(bytes.TrimSpace(t)) == 0 {
				continue
			}
			if leading(t) < key.Column-1 || (leading(t) == key.Column-1 && !bytes.HasPrefix(bytes.TrimSpace(t), []byte("- ")) && !isComment(t)) {
				limit = l
				break
			}
		}
	}
	// Blank and comment lines at the end belong to what follows.
	for limit > key.Line && (len(bytes.TrimSpace(lines[limit-1])) == 0 || (isComment(lines[limit-1]) && leading(lines[limit-1]) <= key.Column-1)) {
		limit--
	}
	return limit
}

func render(n *yaml.Node, unit int) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(unit)
	if err := enc.Encode(n); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// indentUnit guesses the file's indentation step: the smallest indent of a
// key line, 2 when there is none.
func indentUnit(src []byte) int {
	best := 0
	for _, l := range splitLines(src) {
		t := bytes.TrimRight(l, "\r\n")
		if len(bytes.TrimSpace(t)) == 0 || isComment(t) {
			continue
		}
		if n := leading(t); n > 0 && (best == 0 || n < best) {
			best = n
		}
	}
	if best < 2 || best > 8 {
		return 2
	}
	return best
}

func indent(block []byte, n int) []byte {
	if n <= 0 {
		return block
	}
	pad := bytes.Repeat([]byte{' '}, n)
	var out bytes.Buffer
	for _, l := range splitLines(block) {
		if len(bytes.TrimSpace(l)) > 0 {
			out.Write(pad)
		}
		out.Write(l)
	}
	return out.Bytes()
}

func splitLines(src []byte) [][]byte {
	if len(src) == 0 {
		return nil
	}
	lines := bytes.SplitAfter(src, []byte("\n"))
	if len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func insertAt(lines [][]byte, at int, block []byte) []byte {
	if at > 0 && !bytes.HasSuffix(lines[at-1], []byte("\n")) {
		lines[at-1] = append(append([]byte{}, lines[at-1]...), '\n')
	}
	out := append(append([][]byte{}, lines[:at]...), block)
	out = append(out, lines[at:]...)
	return bytes.Join(out, nil)
}

func joinAppend(lines [][]byte, block []byte, _ int) []byte {
	return insertAt(lines, len(lines), block)
}

func leading(l []byte) int {
	n := 0
	for n < len(l) && l[n] == ' ' {
		n++
	}
	return n
}

func isComment(l []byte) bool { return bytes.HasPrefix(bytes.TrimSpace(l), []byte("#")) }

func commentLines(c string) int {
	if c == "" {
		return 0
	}
	return strings.Count(c, "\n") + 1
}

package portless

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Editing one value of a JSON file (portless.json, package.json) without
// rewriting the rest: the bytes around the value stay as the user wrote
// them, key order and spacing included. Only objects are walked.

// member is one key of an object and where its value sits in the source.
type member struct {
	key                  string
	keyStart             int // the opening quote of the key
	valueStart, valueEnd int // [start, end) of the value
}

// objectSpan reads the object that starts at src[start] (after spaces) and
// returns its members and the offset of its closing brace.
func objectSpan(src []byte, start int) ([]member, int, error) {
	i := skipSpace(src, start)
	if i >= len(src) || src[i] != '{' {
		return nil, 0, errors.New("not a JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(src[i:]))
	if _, err := dec.Token(); err != nil { // {
		return nil, 0, err
	}
	var out []member
	for dec.More() {
		before := i + int(dec.InputOffset())
		tok, err := dec.Token()
		if err != nil {
			return nil, 0, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, 0, errors.New("bad JSON object key")
		}
		keyStart := skipSpace(src, before)
		if keyStart < len(src) && src[keyStart] == ',' {
			keyStart = skipSpace(src, keyStart+1)
		}
		afterKey := i + int(dec.InputOffset())
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, 0, err
		}
		end := i + int(dec.InputOffset())
		vs := skipSpace(src, afterKey)
		if vs < len(src) && src[vs] == ':' {
			vs = skipSpace(src, vs+1)
		}
		out = append(out, member{key: key, keyStart: keyStart, valueStart: vs, valueEnd: end})
	}
	if _, err := dec.Token(); err != nil { // }
		return nil, 0, err
	}
	closing := i + int(dec.InputOffset()) - 1
	return out, closing, nil
}

func skipSpace(src []byte, i int) int {
	for i < len(src) && (src[i] == ' ' || src[i] == '\t' || src[i] == '\n' || src[i] == '\r') {
		i++
	}
	return i
}

// SetJSONPath sets the value at path (object keys from the top) to value,
// creating missing objects on the way; a nil value removes the key. src
// must be a JSON object. Everything outside the changed value is kept.
func SetJSONPath(src []byte, path []string, value any) ([]byte, error) {
	if len(path) == 0 {
		return nil, errors.New("empty path")
	}
	if len(bytes.TrimSpace(src)) == 0 {
		src = []byte("{}\n")
	}
	if !json.Valid(src) {
		return nil, errors.New("the file is not valid JSON; fix it in your editor first")
	}
	return setAt(src, 0, path, value, 0)
}

func setAt(src []byte, start int, path []string, value any, depth int) ([]byte, error) {
	members, closing, err := objectSpan(src, start)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", strings.Join(path, "."), err)
	}
	unit := indentUnitJSON(src)
	for idx, m := range members {
		if m.key != path[0] {
			continue
		}
		if len(path) > 1 {
			if src[m.valueStart] != '{' {
				if value == nil {
					return src, nil
				}
				return nil, fmt.Errorf("%q is not an object", path[0])
			}
			return setAt(src, m.valueStart, path[1:], value, depth+1)
		}
		if value == nil {
			return removeMember(src, members, idx), nil
		}
		v, err := marshalAt(value, lineIndent(src, m.keyStart), unit)
		if err != nil {
			return nil, err
		}
		return splice(src, m.valueStart, m.valueEnd, v), nil
	}
	if value == nil {
		return src, nil // nothing to remove
	}
	// Missing: build the rest of the path as nested objects.
	nested := value
	for i := len(path) - 1; i >= 1; i-- {
		nested = map[string]any{path[i]: nested}
	}
	indent := strings.Repeat(unit, depth+1)
	if len(members) > 0 {
		indent = lineIndent(src, members[0].keyStart)
	}
	v, err := marshalAt(nested, indent, unit)
	if err != nil {
		return nil, err
	}
	k, _ := json.Marshal(path[0])
	entry := string(k) + ": " + string(v)
	if len(members) == 0 {
		closeIndent := lineIndent(src, closing)
		open := skipSpace(src, start)
		return splice(src, open, closing+1, []byte("{\n"+indent+entry+"\n"+closeIndent+"}")), nil
	}
	last := members[len(members)-1]
	if open := skipSpace(src, start); !bytes.ContainsRune(src[open:members[0].keyStart], '\n') {
		// {"a": 1} stays on one line: {"a": 1, "b": 2}
		v, err := marshalAt(nested, "", "")
		if err != nil {
			return nil, err
		}
		return splice(src, last.valueEnd, last.valueEnd, []byte(", "+string(k)+": "+string(v))), nil
	}
	return splice(src, last.valueEnd, last.valueEnd, []byte(",\n"+indent+entry)), nil
}

// removeMember cuts one member and the comma that separates it.
func removeMember(src []byte, members []member, idx int) []byte {
	m := members[idx]
	switch {
	case len(members) == 1:
		return splice(src, m.keyStart, m.valueEnd, nil)
	case idx < len(members)-1:
		return splice(src, m.keyStart, members[idx+1].keyStart, nil)
	default:
		return splice(src, members[idx-1].valueEnd, m.valueEnd, nil)
	}
}

func splice(src []byte, from, to int, with []byte) []byte {
	out := make([]byte, 0, len(src)-(to-from)+len(with))
	out = append(out, src[:from]...)
	out = append(out, with...)
	return append(out, src[to:]...)
}

// lineIndent is the whitespace that starts the line holding offset i.
func lineIndent(src []byte, i int) string {
	start := bytes.LastIndexByte(src[:min(i, len(src))], '\n') + 1
	end := start
	for end < len(src) && (src[end] == ' ' || src[end] == '\t') {
		end++
	}
	return string(src[start:end])
}

// indentUnitJSON guesses one level of indentation: a tab, or the smallest
// run of leading spaces; two spaces when the file has none.
func indentUnitJSON(src []byte) string {
	best := 0
	for _, line := range bytes.Split(src, []byte("\n")) {
		if len(line) > 0 && line[0] == '\t' {
			return "\t"
		}
		n := 0
		for n < len(line) && line[n] == ' ' {
			n++
		}
		if n > 0 && n < len(line) && (best == 0 || n < best) {
			best = n
		}
	}
	if best == 0 {
		best = 2
	}
	return strings.Repeat(" ", best)
}

// marshalAt encodes v for a place whose line starts with indent.
func marshalAt(v any, indent, unit string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent(indent, unit)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

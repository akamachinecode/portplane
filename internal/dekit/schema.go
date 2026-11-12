package dekit

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"go.yaml.in/yaml/v3"
)

// SchemaJSON is dekit's JSON schema for dekit.yaml (https://dekit.run/schemas/dekit.json),
// as published for dekit 0.10.3. The raw YAML editor checks a file against
// it before anything is written; dekit itself has the last word at reload.
//
//go:embed schema/dekit.json
var SchemaJSON []byte

// Problem is one thing wrong with a config file.
type Problem struct {
	Path    string `json:"path"`           // "tasks.web.ready", "" for the file
	Line    int    `json:"line,omitempty"` // 1-based, when known
	Message string `json:"message"`
}

// ValidateConfig checks a dekit.yaml (or fragment) text: YAML syntax, the
// schema, and the rules dekit applies that the schema leaves out. Values
// written with !js are not checked: only dekit can evaluate them.
func ValidateConfig(src []byte) []Problem {
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return []Problem{yamlProblem(err)}
	}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		return nil // an empty file is a project without tasks
	}
	lines := map[string]int{}
	val := nodeValue(doc.Content[0], "", lines)
	if _, ok := val.(*omap); !ok {
		return []Problem{{Line: doc.Content[0].Line, Message: "the file must be a mapping of keys such as tasks:, defaults: and load:"}}
	}
	v := &validator{root: loadedSchema(), lines: lines}
	probs, _ := v.validate(v.root, val, "")
	probs = append(probs, extraRules(val)...)
	for i := range probs {
		if probs[i].Line == 0 {
			probs[i].Line = v.lineOf(probs[i].Path)
		}
	}
	sort.SliceStable(probs, func(i, j int) bool { return probs[i].Line < probs[j].Line })
	return dedupe(probs)
}

func yamlProblem(err error) Problem {
	msg := strings.TrimPrefix(err.Error(), "yaml: ")
	p := Problem{Message: "not valid YAML: " + msg}
	if m := regexp.MustCompile(`line (\d+)`).FindStringSubmatch(msg); m != nil {
		p.Line, _ = strconv.Atoi(m[1])
	}
	return p
}

func dedupe(in []Problem) []Problem {
	seen := map[string]bool{}
	out := in[:0]
	for _, p := range in {
		k := p.Path + "\x00" + p.Message
		if !seen[k] {
			seen[k] = true
			out = append(out, p)
		}
	}
	return out
}

// extraRules are dekit's checks the schema does not express.
func extraRules(doc any) []Problem {
	var out []Problem
	m, _ := doc.(*omap)
	tasks, _ := m.get("tasks").(*omap)
	if tasks == nil {
		return nil
	}
	for _, k := range tasks.keys {
		t, ok := tasks.vals[k].(*omap)
		if !ok || strings.HasSuffix(k, "/") {
			continue
		}
		if tags, ok := t.get("tags").([]any); ok {
			for _, tag := range tags {
				if s, ok := tag.(string); ok && (s == "autostart" || s == "dynamic") {
					out = append(out, Problem{Path: "tasks." + k + ".tags", Message: fmt.Sprintf("the tag %q is dekit's own: use autostart: true instead", s)})
				}
			}
		}
		if cmd, ok := t.get("cmd").(string); ok {
			if c := ShellMetachar(cmd); c != "" {
				out = append(out, Problem{Path: "tasks." + k + ".cmd", Message: fmt.Sprintf("dekit refuses shell syntax (%s) in a command string: write it as a list, or run it through sh -c", c)})
			}
		}
	}
	return out
}

// ShellMetachar returns the first piece of shell syntax in a command
// string that dekit refuses, or "".
func ShellMetachar(s string) string {
	inSingle, inDouble := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && !inSingle:
			i++
		case c == '\'' && !inDouble:
			inSingle = !inSingle
		case c == '"' && !inSingle:
			inDouble = !inDouble
		case inSingle:
		case c == '$' || c == '`':
			return string(c)
		case inDouble:
		case strings.IndexByte("|&;<>()*?[]{}~#", c) >= 0:
			if c == '#' && i > 0 && s[i-1] != ' ' {
				continue
			}
			return string(c)
		}
	}
	return ""
}

// ---- values ----

// omap is a YAML mapping with its key order.
type omap struct {
	keys []string
	vals map[string]any
}

func (m *omap) get(k string) any {
	if m == nil {
		return nil
	}
	return m.vals[k]
}

// MarshalJSON keeps the key order, so the UI lists env like the file does.
func (m *omap) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range m.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := json.Marshal(m.vals[k])
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// jsValue is a value written with !js: only dekit can evaluate it.
type jsValue struct {
	Source string `json:"$js"`
}

// nodeValue turns a YAML node into plain values (omap, []any, string,
// int64, float64, bool, nil, jsValue), noting each path's line.
func nodeValue(n *yaml.Node, path string, lines map[string]int) any {
	if lines != nil {
		if _, ok := lines[path]; !ok {
			lines[path] = n.Line
		}
	}
	if n.Tag == "!js" {
		return jsValue{Source: n.Value}
	}
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil
		}
		return nodeValue(n.Content[0], path, lines)
	case yaml.AliasNode:
		return nodeValue(n.Alias, path, lines)
	case yaml.MappingNode:
		m := &omap{vals: map[string]any{}}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k := n.Content[i].Value
			p := k
			if path != "" {
				p = path + "." + k
			}
			if lines != nil {
				lines[p] = n.Content[i].Line
			}
			if _, dup := m.vals[k]; !dup {
				m.keys = append(m.keys, k)
			}
			m.vals[k] = nodeValue(n.Content[i+1], p, lines)
		}
		return m
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for i, c := range n.Content {
			out = append(out, nodeValue(c, path+"["+strconv.Itoa(i)+"]", lines))
		}
		return out
	}
	switch n.ShortTag() {
	case "!!null":
		return nil
	case "!!bool":
		var b bool
		_ = n.Decode(&b)
		return b
	case "!!int":
		var i int64
		if n.Decode(&i) == nil {
			return i
		}
	case "!!float":
		var f float64
		if n.Decode(&f) == nil {
			return f
		}
	}
	return n.Value
}

// ---- the validator ----

type schema struct {
	Ref                   string             `json:"$ref"`
	Type                  json.RawMessage    `json:"type"`
	Enum                  []any              `json:"enum"`
	Const                 *json.RawMessage   `json:"const"`
	OneOf                 []*schema          `json:"oneOf"`
	AnyOf                 []*schema          `json:"anyOf"`
	AllOf                 []*schema          `json:"allOf"`
	Not                   *schema            `json:"not"`
	Required              []string           `json:"required"`
	Properties            map[string]*schema `json:"properties"`
	PatternProperties     map[string]*schema `json:"patternProperties"`
	AdditionalProperties  json.RawMessage    `json:"additionalProperties"`
	UnevaluatedProperties json.RawMessage    `json:"unevaluatedProperties"`
	Items                 *schema            `json:"items"`
	MinItems              *int               `json:"minItems"`
	MinLength             *int               `json:"minLength"`
	Minimum               *float64           `json:"minimum"`
	Maximum               *float64           `json:"maximum"`
	Pattern               string             `json:"pattern"`
	Title                 string             `json:"title"`
	Defs                  map[string]*schema `json:"$defs"`

	types       []string
	additional  *schema
	addFalse    bool
	unevalFalse bool
	uneval      *schema
	re          *regexp.Regexp
	patterns    map[string]*regexp.Regexp
}

var schemaOnce struct {
	sync.Once
	s *schema
}

func loadedSchema() *schema {
	schemaOnce.Do(func() {
		var s schema
		if err := json.Unmarshal(SchemaJSON, &s); err != nil {
			panic("dekit: embedded schema: " + err.Error())
		}
		prepare(&s)
		for _, d := range s.Defs {
			prepare(d)
		}
		schemaOnce.s = &s
	})
	return schemaOnce.s
}

func prepare(s *schema) {
	if s == nil {
		return
	}
	if len(s.Type) > 0 {
		var one string
		if json.Unmarshal(s.Type, &one) == nil {
			s.types = []string{one}
		} else {
			_ = json.Unmarshal(s.Type, &s.types)
		}
	}
	sub := func(raw json.RawMessage) (*schema, bool) {
		if len(raw) == 0 {
			return nil, false
		}
		var b bool
		if json.Unmarshal(raw, &b) == nil {
			return nil, !b
		}
		var x schema
		if json.Unmarshal(raw, &x) == nil {
			prepare(&x)
			return &x, false
		}
		return nil, false
	}
	s.additional, s.addFalse = sub(s.AdditionalProperties)
	s.uneval, s.unevalFalse = sub(s.UnevaluatedProperties)
	if s.Pattern != "" {
		s.re = regexp.MustCompile(s.Pattern)
	}
	if len(s.PatternProperties) > 0 {
		s.patterns = map[string]*regexp.Regexp{}
		for p := range s.PatternProperties {
			s.patterns[p] = regexp.MustCompile(p)
		}
	}
	for _, list := range [][]*schema{s.OneOf, s.AnyOf, s.AllOf} {
		for _, c := range list {
			prepare(c)
		}
	}
	for _, c := range s.Properties {
		prepare(c)
	}
	for _, c := range s.PatternProperties {
		prepare(c)
	}
	prepare(s.Not)
	prepare(s.Items)
}

type validator struct {
	root  *schema
	lines map[string]int
}

func (v *validator) lineOf(path string) int {
	for p := path; ; {
		if l, ok := v.lines[p]; ok {
			return l
		}
		i := strings.LastIndexAny(p, ".[")
		if i < 0 {
			return v.lines[""]
		}
		p = p[:i]
	}
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// friendly names for the $defs dekit's schema uses.
var defMessages = map[string]string{
	"duration": "should be a duration such as 500ms, 10s, 5m or 1h",
	"signal":   "should be a signal name such as SIGTERM or SIGINT",
}

func (v *validator) validate(s *schema, val any, path string) ([]Problem, map[string]bool) {
	if _, js := val.(jsValue); js {
		return nil, nil
	}
	var probs []Problem
	evaluated := map[string]bool{}
	add := func(msg string) { probs = append(probs, Problem{Path: path, Message: msg}) }

	if s.Ref != "" {
		name := strings.TrimPrefix(s.Ref, "#/$defs/")
		def := v.root.Defs[name]
		if def == nil {
			return nil, nil
		}
		p, ev := v.validate(def, val, path)
		if len(p) > 0 {
			if msg, ok := defMessages[name]; ok && !isObject(val) {
				return []Problem{{Path: path, Message: msg}}, ev
			}
		}
		probs = append(probs, p...)
		merge(evaluated, ev)
	}
	if len(s.types) > 0 && !typeMatches(s.types, val) {
		add("should be " + typeWords(s.types))
		return probs, evaluated
	}
	if s.Const != nil {
		var c any
		_ = json.Unmarshal(*s.Const, &c)
		if !equalJSON(c, val) {
			add(fmt.Sprintf("should be %s", jsonText(c)))
		}
	}
	if len(s.Enum) > 0 {
		ok := false
		words := make([]string, len(s.Enum))
		for i, e := range s.Enum {
			words[i] = jsonText(e)
			if equalJSON(e, val) {
				ok = true
			}
		}
		if !ok {
			add("should be one of " + strings.Join(words, ", "))
		}
	}
	switch x := val.(type) {
	case string:
		if s.MinLength != nil && len(x) < *s.MinLength {
			add("can't be empty")
		}
		if s.re != nil && !s.re.MatchString(x) {
			switch {
			case strings.HasPrefix(s.Pattern, "^http"):
				add("should start with http://")
			case strings.HasSuffix(s.Pattern, "js$"):
				add("should be a .js or .mjs file")
			default:
				add(fmt.Sprintf("%q doesn't have the right form", x))
			}
		}
	case int64, float64:
		f := toFloat(x)
		if s.Minimum != nil && f < *s.Minimum {
			add(fmt.Sprintf("should be at least %v", *s.Minimum))
		}
		if s.Maximum != nil && f > *s.Maximum {
			add(fmt.Sprintf("should be at most %v", *s.Maximum))
		}
	case []any:
		if s.MinItems != nil && len(x) < *s.MinItems {
			add("can't be empty")
		}
		if s.Items != nil {
			for i, it := range x {
				p, _ := v.validate(s.Items, it, path+"["+strconv.Itoa(i)+"]")
				probs = append(probs, p...)
			}
		}
	case *omap:
		for _, r := range s.Required {
			if _, ok := x.vals[r]; !ok {
				add("needs " + r)
			}
		}
		for _, k := range x.keys {
			matched := false
			if ps, ok := s.Properties[k]; ok {
				p, _ := v.validate(ps, x.vals[k], join(path, k))
				probs = append(probs, p...)
				matched = true
			}
			for pat, re := range s.patterns {
				if re.MatchString(k) {
					p, _ := v.validate(s.PatternProperties[pat], x.vals[k], join(path, k))
					probs = append(probs, p...)
					matched = true
				}
			}
			if matched {
				evaluated[k] = true
				continue
			}
			switch {
			case s.addFalse:
				probs = append(probs, Problem{Path: join(path, k), Message: unknownKey(path, k)})
				evaluated[k] = true
			case s.additional != nil:
				p, _ := v.validate(s.additional, x.vals[k], join(path, k))
				probs = append(probs, p...)
				evaluated[k] = true
			}
		}
	}
	for _, sub := range s.AllOf {
		p, ev := v.validate(sub, val, path)
		probs = append(probs, p...)
		merge(evaluated, ev)
	}
	if len(s.OneOf) > 0 || len(s.AnyOf) > 0 {
		list, one := s.OneOf, true
		if len(list) == 0 {
			list, one = s.AnyOf, false
		}
		var okEv []map[string]bool
		var best []Problem
		bestScore := math.MaxInt
		for _, sub := range list {
			p, ev := v.validate(sub, val, path)
			if len(p) == 0 {
				okEv = append(okEv, ev)
				continue
			}
			if score := branchScore(sub, val, p); score < bestScore {
				best, bestScore = p, score
			}
		}
		switch {
		case len(okEv) == 0:
			if msg := oneOfMessage(list, val); msg != "" {
				add(msg)
			} else {
				probs = append(probs, best...)
			}
		case one && len(okEv) > 1:
			if msg := oneOfMessage(list, val); msg != "" {
				add(msg)
			} else {
				add("matches more than one form; remove one of its keys")
			}
		default:
			for _, ev := range okEv {
				merge(evaluated, ev)
			}
		}
	}
	if s.Not != nil {
		if p, _ := v.validate(s.Not, val, path); len(p) == 0 {
			if obj, ok := val.(*omap); ok && len(s.Not.Required) == 1 {
				if _, has := obj.vals[s.Not.Required[0]]; has {
					add(fmt.Sprintf("can't have %s here", s.Not.Required[0]))
				}
			} else {
				add("isn't allowed here")
			}
		}
	}
	if obj, ok := val.(*omap); ok && (s.unevalFalse || s.uneval != nil) {
		for _, k := range obj.keys {
			if evaluated[k] {
				continue
			}
			if s.unevalFalse {
				probs = append(probs, Problem{Path: join(path, k), Message: unknownKey(path, k)})
			} else {
				p, _ := v.validate(s.uneval, obj.vals[k], join(path, k))
				probs = append(probs, p...)
			}
			evaluated[k] = true
		}
	}
	return probs, evaluated
}

// branchScore ranks a failed oneOf branch: the branch the value was
// probably meant for has its required keys present and the fewest errors.
func branchScore(sub *schema, val any, p []Problem) int {
	score := len(p) * 10
	if obj, ok := val.(*omap); ok {
		for _, r := range sub.Required {
			if _, has := obj.vals[r]; !has {
				score += 100
			}
		}
		for k, ps := range sub.Properties {
			if ps.Const == nil {
				continue
			}
			var c any
			_ = json.Unmarshal(*ps.Const, &c)
			if v, has := obj.vals[k]; has && !equalJSON(c, v) {
				score += 500 // the branch for another value of a discriminator
			}
		}
		if sub.Ref == "" && len(sub.types) > 0 && !typeMatches(sub.types, val) {
			score += 1000
		}
	} else if sub.Ref == "" && len(sub.types) > 0 && !typeMatches(sub.types, val) {
		score += 1000
	}
	return score
}

// oneOfMessage explains in words the oneOf forms that differ by which key
// they need (cmd or script; one ready check; one way to stop).
func oneOfMessage(list []*schema, val any) string {
	obj, ok := val.(*omap)
	if !ok {
		return ""
	}
	var keys, present []string
	all := true
	for _, s := range list {
		if len(s.Required) != 1 {
			all = false
			continue
		}
		keys = append(keys, s.Required[0])
		if _, has := obj.vals[s.Required[0]]; has {
			present = append(present, s.Required[0])
		}
	}
	switch {
	case len(present) > 1:
		return "can have only one of " + strings.Join(present, ", ")
	case len(present) == 0 && all && len(keys) > 1:
		return "needs one of " + strings.Join(keys, ", ")
	}
	return ""
}

func unknownKey(path, k string) string {
	switch {
	case path == "":
		return fmt.Sprintf("%q isn't a dekit.yaml setting", k)
	case strings.HasPrefix(path, "tasks.") && strings.Count(path, ".") == 1:
		return fmt.Sprintf("%q isn't a task setting", k)
	}
	return fmt.Sprintf("%q isn't allowed here", k)
}

func merge(into, from map[string]bool) {
	for k := range from {
		into[k] = true
	}
}

func isObject(v any) bool { _, ok := v.(*omap); return ok }

func typeMatches(types []string, val any) bool {
	for _, t := range types {
		switch t {
		case "object":
			if _, ok := val.(*omap); ok {
				return true
			}
		case "array":
			if _, ok := val.([]any); ok {
				return true
			}
		case "string":
			if _, ok := val.(string); ok {
				return true
			}
		case "integer":
			if _, ok := val.(int64); ok {
				return true
			}
			if f, ok := val.(float64); ok && f == math.Trunc(f) {
				return true
			}
		case "number":
			switch val.(type) {
			case int64, float64:
				return true
			}
		case "boolean":
			if _, ok := val.(bool); ok {
				return true
			}
		case "null":
			if val == nil {
				return true
			}
		}
	}
	return false
}

func typeWords(types []string) string {
	words := map[string]string{"object": "a mapping", "array": "a list", "string": "text", "integer": "a whole number", "number": "a number", "boolean": "true or false", "null": "empty"}
	out := make([]string, len(types))
	for i, t := range types {
		out[i] = words[t]
	}
	return strings.Join(out, " or ")
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	}
	return 0
}

func equalJSON(a, b any) bool {
	if x, ok := b.(int64); ok {
		b = float64(x)
	}
	if x, ok := a.(int64); ok {
		a = float64(x)
	}
	return fmt.Sprint(a) == fmt.Sprint(b) && fmt.Sprintf("%T", a) == fmt.Sprintf("%T", b)
}

func jsonText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

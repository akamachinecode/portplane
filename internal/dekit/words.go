package dekit

import (
	"errors"
	"strings"
)

// SplitWords splits a string cmd into argv the way dekit does: spaces and
// tabs separate words, '...' keeps everything, "..." keeps everything except
// that \ escapes " \ $ and `, and outside quotes \ keeps the next character.
// dekit rejects strings with shell syntax; we only need the words, so we stay
// lenient and keep such characters as they are.
func SplitWords(s string) ([]string, error) {
	var (
		words   []string
		cur     strings.Builder
		inWord  bool
		runes   = []rune(s)
		inQuote rune
	)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case inQuote == '\'':
			if r == '\'' {
				inQuote = 0
			} else {
				cur.WriteRune(r)
			}
		case inQuote == '"':
			switch {
			case r == '"':
				inQuote = 0
			case r == '\\' && i+1 < len(runes) && strings.ContainsRune("\"\\$`", runes[i+1]):
				i++
				cur.WriteRune(runes[i])
			default:
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			inQuote = r
			inWord = true
		case r == '\\':
			if i+1 < len(runes) {
				i++
				if runes[i] == '\n' {
					continue // line continuation
				}
				cur.WriteRune(runes[i])
				inWord = true
			}
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if inQuote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}

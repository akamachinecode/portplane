package dekit

import (
	"reflect"
	"testing"
)

func TestSplitWords(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"npm run dev", []string{"npm", "run", "dev"}},
		{"  pnpm   run\tdev ", []string{"pnpm", "run", "dev"}},
		{`tail -f 'var/log/api server.log'`, []string{"tail", "-f", "var/log/api server.log"}},
		{`echo "a \"b\" \$HOME"`, []string{"echo", `a "b" $HOME`}},
		{`server.exe --data 'C:\data'`, []string{"server.exe", "--data", `C:\data`}},
		{`a\ b c`, []string{"a b", "c"}},
		{"one \\\ntwo", []string{"one", "two"}},
		{`""`, []string{""}},
	}
	for _, c := range cases {
		got, err := SplitWords(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitWords(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if _, err := SplitWords(`echo 'oops`); err == nil {
		t.Error("want error for an unterminated quote")
	}
}

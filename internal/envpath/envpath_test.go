package envpath

import (
	"reflect"
	"testing"
)

func TestMergeKeepsOrderAndExistingDirs(t *testing.T) {
	dir := t.TempDir()
	got := merge([]string{"/nonexistent-but-current", dir}, []string{dir, "/definitely/missing", ""})
	if !reflect.DeepEqual(got, []string{"/nonexistent-but-current", dir}) {
		t.Fatalf("got %v", got)
	}
}

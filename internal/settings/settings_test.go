package settings

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "nested", "settings.json"))
	st, err := s.Load()
	if err != nil || len(st.Folders) != 0 || st.Folders == nil {
		t.Fatalf("missing file: %+v %v", st, err)
	}
	want := Settings{Folders: []string{"/a", "/b"}, Machines: []Machine{{ID: "box", Name: "box", Host: "box", Folders: []string{"/srv"}}}}
	if err := s.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v %v", got, err)
	}
	got, err = s.Update(func(st *Settings) error { st.Folders = append(st.Folders, "/c"); return nil })
	if err != nil || len(got.Folders) != 3 {
		t.Fatalf("update: %+v %v", got, err)
	}
}

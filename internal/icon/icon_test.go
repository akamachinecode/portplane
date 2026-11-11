package icon

import (
	"bytes"
	"image/png"
	"testing"
)

func TestPNGAndContainers(t *testing.T) {
	p := PNG(64, 2)
	img, err := png.Decode(bytes.NewReader(p))
	if err != nil || img.Bounds().Dx() != 64 {
		t.Fatalf("png: %v", err)
	}
	// Corner is transparent (rounded tile), centre is opaque.
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
		t.Fatalf("corner alpha %d", a)
	}
	if _, _, _, a := img.At(32, 5).RGBA(); a == 0 {
		t.Fatal("tile should be opaque")
	}
	ico := ICO(PNG(16, 0), PNG(32, 0))
	if !bytes.Equal(ico[:4], []byte{0, 0, 1, 0}) || ico[4] != 2 {
		t.Fatalf("ico header % x", ico[:6])
	}
	icns := ICNS()
	if string(icns[:4]) != "icns" {
		t.Fatal("icns magic")
	}
	if _, err := png.Decode(bytes.NewReader(TemplatePNG(44, 1))); err != nil {
		t.Fatal(err)
	}
}

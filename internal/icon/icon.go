// Package icon draws the Portplane mark (web/public/icon.svg) as PNG, ICO
// and ICNS, so no binary image files live in the repository.
package icon

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
)

// The mark on a 64x64 grid: a dark tile with three rows, each with a dot.
// Dots: on, on, off.
type shape struct {
	x, y, w, h, r float64 // rounded rect, or circle when w == h == 2r
	c             color.NRGBA
}

var (
	tile  = color.NRGBA{0x17, 0x1a, 0x20, 0xff}
	row   = color.NRGBA{0x2a, 0x2f, 0x39, 0xff}
	green = color.NRGBA{0x3c, 0xcf, 0x7c, 0xff}
	grey  = color.NRGBA{0x5d, 0x62, 0x6c, 0xff}
)

func mark(running int) []shape {
	dots := []color.NRGBA{grey, grey, grey}
	for i := 0; i < running && i < 3; i++ {
		dots[i] = green
	}
	return []shape{
		{0, 0, 64, 64, 14, tile},
		{12, 14, 40, 10, 5, row}, {12, 27, 40, 10, 5, row}, {12, 40, 40, 10, 5, row},
		{16, 16, 6, 6, 3, dots[0]}, {16, 29, 6, 6, 3, dots[1]}, {16, 42, 6, 6, 3, dots[2]},
	}
}

// coverage of a rounded rect at a point (1 inside, 0 outside).
func inside(s shape, px, py float64) bool {
	if px < s.x || py < s.y || px > s.x+s.w || py > s.y+s.h {
		return false
	}
	cx := math.Max(s.x+s.r, math.Min(px, s.x+s.w-s.r))
	cy := math.Max(s.y+s.r, math.Min(py, s.y+s.h-s.r))
	dx, dy := px-cx, py-cy
	return dx*dx+dy*dy <= s.r*s.r
}

func render(size int, shapes []shape) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4 // supersampling per axis
	scale := 64 / float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px := (float64(x) + (float64(sx)+0.5)/ss) * scale
					py := (float64(y) + (float64(sy)+0.5)/ss) * scale
					// Paint shapes in order; later shapes cover earlier ones.
					var c color.NRGBA
					hit := false
					for _, s := range shapes {
						if inside(s, px, py) {
							c, hit = s.c, true
						}
					}
					if hit {
						fa := float64(c.A) / 255
						r += float64(c.R) * fa
						g += float64(c.G) * fa
						b += float64(c.B) * fa
						a += fa
					}
				}
			}
			n := float64(ss * ss)
			if a == 0 {
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(r / a), G: uint8(g / a), B: uint8(b / a), A: uint8(math.Round(a / n * 255)),
			})
		}
	}
	return img
}

func encode(img image.Image) []byte {
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// PNG returns the full-colour mark; running (0–3) lights that many dots.
func PNG(size, running int) []byte { return encode(render(size, mark(running))) }

// TemplatePNG is a monochrome glyph for the macOS menu bar, which tints it:
// three rows, solid where a dot is lit and outlined otherwise.
func TemplatePNG(size, running int) []byte {
	black := color.NRGBA{0, 0, 0, 0xff}
	clear := color.NRGBA{0, 0, 0, 0}
	var shapes []shape
	for i, y := range []float64{10, 27, 44} {
		shapes = append(shapes, shape{6, y, 52, 12, 6, black})
		if i >= running {
			shapes = append(shapes, shape{9, y + 3, 46, 6, 3, clear})
		}
	}
	img := render(size, shapes)
	// Transparent shapes above must punch holes: render treats them as hits
	// with alpha 0, which leaves the pixel clear. Nothing else to do.
	return encode(img)
}

// ICO wraps PNG images in an .ico container (Windows tray and installers).
func ICO(pngs ...[]byte) []byte {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, [3]uint16{0, 1, uint16(len(pngs))})
	offset := 6 + 16*len(pngs)
	for _, p := range pngs {
		cfg, _ := png.DecodeConfig(bytes.NewReader(p))
		w, h := cfg.Width, cfg.Height
		if w >= 256 {
			w = 0
		}
		if h >= 256 {
			h = 0
		}
		_ = binary.Write(&buf, binary.LittleEndian, struct {
			W, H, Colors, Reserved uint8
			Planes, BPP            uint16
			Size, Offset           uint32
		}{uint8(w), uint8(h), 0, 0, 1, 32, uint32(len(p)), uint32(offset)})
		offset += len(p)
	}
	for _, p := range pngs {
		buf.Write(p)
	}
	return buf.Bytes()
}

// ICNS builds a macOS .icns from the full-colour mark.
func ICNS() []byte {
	type entry struct {
		kind string
		size int
	}
	entries := []entry{{"icp4", 16}, {"icp5", 32}, {"icp6", 64}, {"ic07", 128}, {"ic08", 256}, {"ic09", 512}, {"ic10", 1024}}
	var body bytes.Buffer
	for _, e := range entries {
		p := PNG(e.size, 2)
		body.WriteString(e.kind)
		_ = binary.Write(&body, binary.BigEndian, uint32(len(p)+8))
		body.Write(p)
	}
	var out bytes.Buffer
	out.WriteString("icns")
	_ = binary.Write(&out, binary.BigEndian, uint32(body.Len()+8))
	out.Write(body.Bytes())
	return out.Bytes()
}

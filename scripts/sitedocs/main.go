// Command sitedocs turns the user guides in docs/ into the documentation
// pages of the website (site/docs/), with the landing page's look. The
// Markdown in docs/ stays the only source: GitHub shows it as is, and the
// Pages workflow runs this before it publishes site/.
//
//	go run ./scripts/sitedocs            # writes site/docs/
package main

import (
	"bytes"
	_ "embed"
	"flag"
	"fmt"
	"html/template"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

const repoURL = "https://github.com/akamachinecode/portplane"

// A page of the site, made from one file in docs/.
type page struct {
	Src   string // file in docs/
	Slug  string // "" for the docs home
	Nav   string // its name in the sidebar
	Group string
	// Questions: the page is a list of paragraphs that open with a bold
	// question (troubleshooting). Each gets an anchor and a contents entry.
	Questions bool
}

var pages = []page{
	{Src: "install.md", Slug: "", Nav: "Install", Group: "Get started"},
	{Src: "troubleshooting.md", Slug: "troubleshooting", Nav: "Troubleshooting", Group: "Get started", Questions: true},
	{Src: "security.md", Slug: "security", Nav: "Security model", Group: "Reference"},
	{Src: "vision.md", Slug: "vision", Nav: "Vision", Group: "Project"},
}

// Links in the sidebar that stay on GitHub.
var external = []struct{ Group, Nav, URL string }{
	{"Project", "Roadmap", repoURL + "/blob/main/docs/roadmap.md"},
	{"Project", "Decisions (ADRs)", repoURL + "/blob/main/docs/adr/README.md"},
	{"Project", "Changelog", repoURL + "/blob/main/CHANGELOG.md"},
}

//go:embed page.html
var pageHTML string

type navItem struct {
	Name, URL string
	Current   bool
	External  bool
}

type navGroup struct {
	Name  string
	Items []navItem
}

type tocItem struct {
	ID, Text string
	Sub      bool
}

type view struct {
	Title       string
	Description string
	Root        string // relative path from the page to site/
	Groups      []navGroup
	TOC         []tocItem
	Body        template.HTML
	EditURL     string
	Prev, Next  *navItem
}

func main() {
	docs := flag.String("docs", "docs", "folder with the Markdown guides")
	out := flag.String("out", "site/docs", "output folder")
	flag.Parse()

	tpl := template.Must(template.New("page").Parse(pageHTML))
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(
			html.WithXHTML(),
			renderer.WithNodeRenderers(util.Prioritized(rawAsText{}, 100)),
		),
	)

	if err := os.RemoveAll(*out); err != nil {
		log.Fatal(err)
	}
	for i, p := range pages {
		src, err := os.ReadFile(filepath.Join(*docs, p.Src))
		if err != nil {
			log.Fatal(err)
		}
		root := "../"
		if p.Slug != "" {
			root = "../../"
		}
		doc := md.Parser().Parse(text.NewReader(src))
		title, toc := transform(doc, src, p, root)
		var body bytes.Buffer
		if err := md.Renderer().Render(&body, src, doc); err != nil {
			log.Fatal(err)
		}
		v := view{
			Title:       title,
			Description: description(doc, src),
			Root:        root,
			Groups:      sidebar(root, p),
			TOC:         toc,
			Body:        template.HTML(body.String()),
			EditURL:     repoURL + "/blob/main/docs/" + p.Src,
		}
		if i > 0 {
			v.Prev = &navItem{Name: pages[i-1].Nav, URL: pageURL(root, pages[i-1].Slug)}
		}
		if i < len(pages)-1 {
			v.Next = &navItem{Name: pages[i+1].Nav, URL: pageURL(root, pages[i+1].Slug)}
		}
		dir := filepath.Join(*out, p.Slug)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatal(err)
		}
		var buf bytes.Buffer
		if err := tpl.Execute(&buf, v); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "index.html"), buf.Bytes(), 0o644); err != nil {
			log.Fatal(err)
		}
		fmt.Println(filepath.Join(dir, "index.html"))
	}
}

func pageURL(root, slug string) string {
	if slug == "" {
		return root + "docs/"
	}
	return root + "docs/" + slug + "/"
}

func sidebar(root string, current page) []navGroup {
	var groups []navGroup
	add := func(group string, item navItem) {
		for i := range groups {
			if groups[i].Name == group {
				groups[i].Items = append(groups[i].Items, item)
				return
			}
		}
		groups = append(groups, navGroup{Name: group, Items: []navItem{item}})
	}
	for _, p := range pages {
		add(p.Group, navItem{Name: p.Nav, URL: pageURL(root, p.Slug), Current: p.Src == current.Src})
	}
	for _, e := range external {
		add(e.Group, navItem{Name: e.Nav, URL: e.URL, External: true})
	}
	return groups
}

// transform rewrites links for the site, gives question paragraphs an
// anchor, and returns the page's title and its table of contents.
func transform(doc ast.Node, src []byte, p page, root string) (string, []tocItem) {
	var title string
	var toc []tocItem
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n := n.(type) {
		case *ast.Heading:
			id, _ := n.AttributeString("id")
			idStr := string(asBytes(id))
			switch {
			case n.Level == 1 && title == "":
				title = plain(n, src)
			case n.Level == 2 || (n.Level == 3 && !p.Questions):
				toc = append(toc, tocItem{ID: idStr, Text: plain(n, src), Sub: n.Level == 3})
			}
		case *ast.Paragraph:
			if !p.Questions {
				break
			}
			if strong, ok := n.FirstChild().(*ast.Emphasis); ok && strong.Level == 2 {
				q := strings.TrimRight(plain(strong, src), ".")
				id := slug(q)
				n.SetAttributeString("id", []byte(id))
				n.SetAttributeString("class", []byte("question"))
				toc = append(toc, tocItem{ID: id, Text: q})
			}
		case *ast.Link:
			n.Destination = []byte(rewrite(string(n.Destination), p.Src, root))
		case *ast.Image:
			n.Destination = []byte(rewrite(string(n.Destination), p.Src, root))
		}
		return ast.WalkContinue, nil
	})
	return title, toc
}

func asBytes(v any) []byte {
	if b, ok := v.([]byte); ok {
		return b
	}
	return nil
}

// rewrite points a relative link at the site's page when the target is one,
// and at the file on GitHub otherwise.
func rewrite(dest, from, root string) string {
	if dest == "" || strings.HasPrefix(dest, "#") || strings.Contains(dest, "://") || strings.HasPrefix(dest, "mailto:") {
		return dest
	}
	file, frag, _ := strings.Cut(dest, "#")
	if frag != "" {
		frag = "#" + frag
	}
	target := path.Clean(path.Join("docs", path.Dir(from), file))
	for _, p := range pages {
		if target == "docs/"+p.Src {
			return pageURL(root, p.Slug) + frag
		}
	}
	kind := "blob"
	if !strings.Contains(path.Base(target), ".") {
		kind = "tree"
	}
	return repoURL + "/" + kind + "/main/" + target + frag
}

// plain is a node's text without markup.
func plain(n ast.Node, src []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch c := c.(type) {
		case *ast.Text:
			b.Write(c.Segment.Value(src))
			if c.SoftLineBreak() {
				b.WriteByte(' ')
			}
		case *ast.String:
			b.Write(c.Value)
		case *ast.RawHTML:
			for i := 0; i < c.Segments.Len(); i++ {
				seg := c.Segments.At(i)
				b.Write(seg.Value(src))
			}
		}
		return ast.WalkContinue, nil
	})
	return strings.TrimSpace(b.String())
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	return strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// description is the first paragraph after the title, for search engines.
func description(doc ast.Node, src []byte) string {
	for n := doc.FirstChild(); n != nil; n = n.NextSibling() {
		if p, ok := n.(*ast.Paragraph); ok {
			d := plain(p, src)
			if len(d) > 180 {
				d = d[:strings.LastIndex(d[:180], " ")] + "…"
			}
			return d
		}
	}
	return ""
}

// rawAsText shows inline HTML as text: the guides write placeholders such as
// <machine>, never markup.
type rawAsText struct{}

func (rawAsText) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindRawHTML, func(w util.BufWriter, src []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		raw := n.(*ast.RawHTML)
		for i := 0; i < raw.Segments.Len(); i++ {
			seg := raw.Segments.At(i)
			_, _ = w.WriteString(template.HTMLEscapeString(string(seg.Value(src))))
		}
		return ast.WalkContinue, nil
	})
}

package docparser

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
)

func TestRelayLinkedImageUploadPipelinePreservesStructure(t *testing.T) {
	input := "# Diagram\n\n[![thumbnail](images/thumb.png)](images/full.png#view)\n\n<a id=\"target\"></a>\n\n| Item | Reference |\n| --- | --- |\n| A | [![table image](table-thumb.png)](table-full.png) |\n\n```text\n[![literal](code-thumb.png)](code-full.png)\n```\n"
	expected := NormalizeHTMLTables(input)
	converted, err := (&SimpleFormatReader{}).Read(context.Background(), &types.ReadRequest{FileType: "md", FileName: "structured.md", FileContent: []byte(input)})
	if err != nil {
		t.Fatal("simple Markdown parsing failed")
	}
	converted.MarkdownContent = NormalizeHTMLTables(converted.MarkdownContent)
	resolver := NewImageResolver()
	actual, _, err := resolver.ResolveAndStore(context.Background(), converted, nil, 1)
	if err != nil {
		t.Fatal("inline image resolution failed")
	}
	actual, _, err = resolver.ResolveRemoteImages(context.Background(), actual, nil, 1)
	if err != nil {
		t.Fatal("remote image resolution failed")
	}
	if actual != expected {
		t.Fatal("upload image-resolution pipeline changed normalized links, anchors, table or code bytes")
	}

}

func TestRelayLinkedImageInlineBytesRetainOuterHref(t *testing.T) {
	input := "[![thumbnail](images/thumb.png)](images/full-size.png#diagram)"
	result := &types.ReadResult{MarkdownContent: input, ImageRefs: []types.ImageRef{{Filename: "thumb.png", OriginalRef: "images/thumb.png", MimeType: "image/png", ImageData: createTestPNG(200, 150)}}}
	service := &captureSaveBytes{}
	output, images, err := NewImageResolver().ResolveAndStore(context.Background(), result, service, 1)
	if err != nil || len(images) != 1 || len(service.saved) != 1 {
		t.Fatal("linked image was not stored through the normal resolver")
	}
	if !strings.HasPrefix(output, "[![thumbnail](local://test/") || !strings.HasSuffix(output, ")](images/full-size.png#diagram)") {
		t.Fatal("image storage changed or removed the distinct outer href")
	}
}

func TestRelayLinkedImageDataURIRetainsOuterHref(t *testing.T) {
	image := base64.StdEncoding.EncodeToString(createTestPNG(200, 150))
	input := "[![thumbnail](data:image/png;base64," + image + ")](images/full-size.png#diagram)"
	service := &captureSaveBytes{}
	output, images, err := NewImageResolver().ResolveDataURIImages(context.Background(), input, service, 1)
	if err != nil || len(images) != 1 || len(service.saved) != 1 {
		t.Fatal("linked data image was not stored through the normal resolver")
	}
	if !strings.HasPrefix(output, "[![thumbnail](local://test/") || !strings.HasSuffix(output, ")](images/full-size.png#diagram)") {
		t.Fatal("data-image storage changed or removed the distinct outer href")
	}
}

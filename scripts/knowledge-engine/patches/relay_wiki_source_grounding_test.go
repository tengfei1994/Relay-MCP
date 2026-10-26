package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/Tencent/WeKnora/internal/agent"
	"github.com/Tencent/WeKnora/internal/models/chat"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
)

type relayGroundingPageStore struct {
	interfaces.WikiPageService
	page    *types.WikiPage
	writes  int
	similar []*types.WikiPageLite
}

func (s *relayGroundingPageStore) GetPageBySlug(context.Context, string, string) (*types.WikiPage, error) {
	if s.page == nil {
		return nil, nil
	}
	copy := *s.page
	return &copy, nil
}
func (s *relayGroundingPageStore) CreatePage(_ context.Context, p *types.WikiPage) (*types.WikiPage, error) {
	s.writes++
	s.page = p
	return p, nil
}
func (s *relayGroundingPageStore) UpdatePage(_ context.Context, p *types.WikiPage) (*types.WikiPage, error) {
	s.writes++
	s.page = p
	return p, nil
}

func relayGroundingReduce(t *testing.T, refs []string, chunks map[string][]*types.Chunk, existing *types.WikiPage) (*templateCaptureChatModel, *relayGroundingPageStore, bool, bool, error) {
	t.Helper()
	pages := &relayGroundingPageStore{page: existing}
	svc := &wikiIngestService{wikiService: pages, knowledgeSvc: liveKnowledgeStub{}, chunkRepo: &citedChunkRepo{byID: chunks}}
	model := &templateCaptureChatModel{response: "SUMMARY: Source facts\n# Alpha\nThe retained source fact."}
	updates := []SlugUpdate{{Slug: "entity/alpha", Type: types.WikiPageTypeEntity, KnowledgeID: "kn-1", SourceRef: "kn-1", DocTitle: "Source", SourceChunks: refs,
		Item: extractedItem{Name: "Alpha", Description: "UNSUPPORTED_DESCRIPTION", Details: "UNSUPPORTED_DETAILS"}, DocSummary: "GENERATED_SUMMARY_CONTEXT"}}
	batch := &WikiBatchContext{SlugTitleMany: func(context.Context, []string) map[string]string { return nil }}
	changed, _, failed, _, err := svc.reduceSlugUpdates(context.Background(), model, "kb-1", "entity/alpha", updates, 1, batch, nil)
	return model, pages, changed, failed, err
}

// Reintroducing generated descriptions or fallback details into the source
// block must fail this boundary test even when all chunk IDs are valid.
func TestRelayWikiGroundingRawEvidenceOnly(t *testing.T) {
	const raw = "The retained source fact.\n\n| key | value |\n| --- | --- |\n| alpha | 17 |"
	model, pages, changed, failed, err := relayGroundingReduce(t, []string{"chunk-1"}, map[string][]*types.Chunk{"chunk-1": {citationChunk("chunk-1", raw)}}, nil)
	if err != nil || failed || !changed || pages.writes != 1 {
		t.Fatalf("valid source addition failed: changed=%v failed=%v writes=%d err=%v", changed, failed, pages.writes, err)
	}
	if len(model.messages) != 2 {
		t.Fatalf("missing real reducer model call: %d messages", len(model.messages))
	}
	prompt := model.messages[1].Content
	start, end := strings.Index(prompt, "<new_information>"), strings.Index(prompt, "</new_information>")
	if start < 0 || end <= start {
		t.Fatal("missing evidence block")
	}
	evidence := prompt[start:end]
	if !strings.Contains(evidence, raw) {
		t.Fatal("source facts or table changed before generation")
	}
	for _, invented := range []string{"UNSUPPORTED_DESCRIPTION", "UNSUPPORTED_DETAILS", "GENERATED_SUMMARY_CONTEXT"} {
		if strings.Contains(evidence, invented) {
			t.Errorf("generated prose promoted to raw evidence: %s", invented)
		}
	}
	if !strings.Contains(prompt, "GENERATED_SUMMARY_CONTEXT") {
		t.Error("non-evidentiary source context should remain available")
	}
	if len(pages.page.ChunkRefs) != 1 || pages.page.ChunkRefs[0] != "chunk-1" {
		t.Fatalf("source references changed: %v", pages.page.ChunkRefs)
	}
}

func TestRelayWikiGroundingMissingEvidencePreservesPage(t *testing.T) {
	for _, refs := range [][]string{nil, {"ghost"}, {"chunk-1", "ghost"}} {
		t.Run(strings.Join(refs, ","), func(t *testing.T) {
			old := &types.WikiPage{Slug: "entity/alpha", Title: "Alpha", Content: "Preserved old draft", Version: 4, SourceRefs: types.StringArray{"older-source"}}
			model, pages, changed, failed, err := relayGroundingReduce(t, refs, map[string][]*types.Chunk{"chunk-1": {citationChunk("chunk-1", "The retained source fact.")}}, old)
			if err == nil && !failed {
				t.Error("unresolved source evidence accepted")
			}
			if changed || pages.writes != 0 || len(model.messages) != 0 {
				t.Errorf("unsupported addition reached model/storage: changed=%v writes=%d messages=%d", changed, pages.writes, len(model.messages))
			}
			if pages.page.Content != "Preserved old draft" || pages.page.Version != 4 {
				t.Fatal("old draft changed")
			}
		})
	}
}

func TestRelayWikiGroundingCitationAdmissionAndInstructions(t *testing.T) {
	model := &templateCaptureChatModel{response: `{"citations":{"entity/candidate":["c000","unknown"]},"new_slugs":[{"type":"entity","name":"Valid","slug":"entity/valid","source_chunks":["c000","unknown"]},{"type":"entity","name":"Ghost","slug":"entity/ghost","source_chunks":["unknown"]},{"type":"concept","name":"Empty","slug":"concept/empty","source_chunks":[]}]}`}
	svc := &wikiIngestService{}
	citations, news, batches := svc.classifyChunkCitations(context.Background(), model, "- slug: entity/candidate", []*types.Chunk{citationChunk("chunk-1", "Alpha has one supported setting.")}, "English", &WikiBatchContext{ExtractionInstructions: "EXTRACTION_SCOPE_SENTINEL"})
	if batches != 1 || len(citations["entity/candidate"]) != 1 || citations["entity/candidate"][0] != "chunk-1" {
		t.Fatalf("valid handles not preserved: %v", citations)
	}
	if len(news) != 1 || news[0].Slug != "entity/valid" || len(news[0].SourceChunks) != 1 || news[0].SourceChunks[0] != "chunk-1" {
		t.Errorf("zero-evidence new slug admitted: %+v", news)
	}
	if !strings.Contains(model.prompt, "EXTRACTION_SCOPE_SENTINEL") {
		t.Error("citation pass lost configured extraction guidance")
	}
}

// The provider request itself must not force a short source into hundreds of
// words. Semantic support still requires the separately bounded source review.
func TestRelayWikiGroundingShortSourceSummaryRequest(t *testing.T) {
	model := &templateCaptureChatModel{response: "SUMMARY: Alpha setting\n# Alpha\nSet alpha to 17."}
	svc := &wikiIngestService{}
	_, err := svc.generateWithTemplate(context.Background(), model, agent.WikiSummaryPrompt, map[string]string{"Content": "Set alpha to 17.", "Language": "English"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(model.prompt, "Set alpha to 17.") {
		t.Fatal("complete source omitted")
	}
	for _, forced := range []string{"500-1500 words", "At the end, include a", "Use proper heading hierarchy"} {
		if strings.Contains(model.prompt, forced) {
			t.Errorf("thin source expansion is mandatory: %s", forced)
		}
	}
}

type relayGroundingMapChunks struct {
	*citedChunkRepo
	chunks []*types.Chunk
}

func (r *relayGroundingMapChunks) ListChunksByKnowledgeID(context.Context, uint64, string) ([]*types.Chunk, error) {
	return r.chunks, nil
}
func (s *relayGroundingPageStore) ListSlugsBySourceRef(context.Context, string, string) ([]string, error) {
	return nil, nil
}
func (s *relayGroundingPageStore) FindSimilarPages(context.Context, string, string, []string, int) ([]*types.WikiPageLite, error) {
	return s.similar, nil
}
func (s *relayGroundingPageStore) FindPagesByNormalizedTitles(context.Context, string, string, []string) ([]*types.WikiPageLite, error) {
	return nil, nil
}

type relayGroundingLegacyModel struct {
	templateCaptureChatModel
	mu    sync.Mutex
	calls map[string]int
}

func (m *relayGroundingLegacyModel) Chat(ctx context.Context, _ []chat.Message, _ *chat.ChatOptions) (*types.ChatResponse, error) {
	purpose, _ := types.LLMCallMetadataFromContext(ctx)
	m.mu.Lock()
	m.calls[purpose]++
	m.mu.Unlock()
	var response string
	switch purpose {
	case "wiki_candidate_slug":
		response = "NOT_JSON"
	case "wiki_knowledge_extract":
		response = `{"entities":[{"name":"Alpha","slug":"entity/alpha","description":"GENERATED_DESCRIPTION","details":"GENERATED_DETAILS"}],"concepts":[]}`
	case "wiki_summary":
		response = "SUMMARY: Alpha settings\n# Alpha\nAlpha has one supported setting."
	case "wiki_chunk_citation":
		response = `{"citations":{"entity/alpha":["c000"]},"new_slugs":[]}`
	default:
		return nil, fmt.Errorf("unexpected real map stage: %s", purpose)
	}
	return &types.ChatResponse{Content: response}, nil
}

func TestRelayWikiGroundingLegacyFallbackStillCitesSource(t *testing.T) {
	chunk := citationChunk("chunk-1", "Alpha has one supported setting.")
	repo := &relayGroundingMapChunks{citedChunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"chunk-1": {chunk}}}, chunks: []*types.Chunk{chunk}}
	svc := &wikiIngestService{knowledgeSvc: liveKnowledgeStub{}, wikiService: &relayGroundingPageStore{}, chunkRepo: repo}
	model := &relayGroundingLegacyModel{calls: map[string]int{}}
	batch := &WikiBatchContext{SummaryContentByKnowledgeID: func(context.Context, string) string { return "" }, SlugTitle: func(context.Context, string) string { return "" }}
	result, updates, err := svc.mapOneDocument(context.Background(), model, WikiIngestPayload{TenantID: 1, KnowledgeBaseID: "kb-1"}, WikiPendingOp{KnowledgeID: "kn-1", Op: WikiOpIngest}, batch)
	if err != nil || result == nil {
		t.Fatalf("legacy fallback failed: %v", err)
	}
	for _, stage := range []string{"wiki_candidate_slug", "wiki_knowledge_extract", "wiki_summary", "wiki_chunk_citation"} {
		if model.calls[stage] != 1 {
			t.Errorf("expected exactly one %s invocation, got %d", stage, model.calls[stage])
		}
	}
	found := false
	for _, update := range updates {
		if update.Slug == "entity/alpha" {
			found = true
			if len(update.SourceChunks) != 1 || update.SourceChunks[0] != "chunk-1" {
				t.Errorf("legacy candidate lost raw source citations: %v", update.SourceChunks)
			}
		}
	}
	if !found {
		t.Fatal("usable legacy candidate was discarded")
	}
}

func TestRelayWikiGroundingMalformedOutputLogsMetadataOnly(t *testing.T) {
	logs := captureServiceLogs(t)
	const private = "PRIVATE_SOURCE_CANARY_DO_NOT_LOG"
	batch := &WikiBatchContext{}
	svc := &wikiIngestService{}
	for _, stage := range []string{"candidate", "legacy", "citation", "unknown-handle", "dedup"} {
		logs.Reset()
		model := &templateCaptureChatModel{response: private}
		switch stage {
		case "candidate":
			_, _, _, _ = svc.extractCandidateSlugs(context.Background(), model, "kb", "complete source fact", "English", nil, batch)
		case "legacy":
			_, _, _, _ = svc.extractEntitiesAndConceptsNoUpsert(context.Background(), model, "kb", "complete source fact", "English", nil, batch)
		case "citation":
			svc.classifyChunkCitations(context.Background(), model, "- slug: entity/alpha", []*types.Chunk{citationChunk("chunk-1", "complete source fact")}, "English", batch)
		case "dedup":
			dedup := &wikiIngestService{wikiService: &relayGroundingPageStore{similar: []*types.WikiPageLite{{Slug: "entity/alpha-reference", Title: "Alpha reference", PageType: types.WikiPageTypeEntity}}}}
			dedup.deduplicateExtractedBatch(context.Background(), model, "kb", []extractedItem{{Slug: "entity/alpha", Name: "Alpha"}}, nil, batch)
		case "unknown-handle":
			model.response = `{"citations":{"entity/alpha":["` + private + `"]},"new_slugs":[]}`
			svc.classifyChunkCitations(context.Background(), model, "- slug: entity/alpha", []*types.Chunk{citationChunk("chunk-1", "complete source fact")}, "English", batch)
		}
		if strings.Contains(logs.String(), private) {
			t.Errorf("%s logged raw model output", stage)
		}
		if !strings.Contains(logs.String(), "wiki ingest:") {
			t.Errorf("%s lost safe stage diagnostics", stage)
		}
	}
}

package service

import (
	"context"
	"github.com/Tencent/WeKnora/internal/agent"
	"github.com/Tencent/WeKnora/internal/models/chat"
	"github.com/Tencent/WeKnora/internal/types"
	"strings"
	"testing"
)

func TestRelayWikiSourceResolverRejectsForeignEvidence(t *testing.T) {
	good := citationChunk("good", "Supported source fact.")
	foreign := citationChunk("foreign", "FOREIGN_DOCUMENT_CANARY")
	foreign.KnowledgeID = "other-document"
	tenant := citationChunk("tenant", "FOREIGN_TENANT_CANARY")
	tenant.TenantID = 2
	disabled := citationChunk("disabled", "DISABLED_CANARY")
	disabled.IsEnabled = false
	nontext := citationChunk("nontext", "NON_TEXT_CANARY")
	nontext.ChunkType = types.ChunkTypeImageCaption
	svc := &wikiIngestService{chunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"good": {good}, "foreign": {foreign}, "tenant": {tenant}, "disabled": {disabled}, "nontext": {nontext}}}}
	got := svc.resolveCitedChunks(context.Background(), 1, []SlugUpdate{{KnowledgeID: "kn-1", SourceChunks: []string{"good", "foreign", "tenant", "disabled", "nontext"}}})
	if len(got) != 1 || got["good"] != "Supported source fact." {
		t.Fatalf("foreign or disabled evidence admitted: keys=%v", got)
	}
}

func TestRelayWikiSummaryReplacesCurrentSourceRefs(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "replace"}[existing], func(t *testing.T) {
			pages := &relayGroundingPageStore{}
			if existing {
				pages.page = &types.WikiPage{Slug: "summary/kn-1", Content: "Old summary", ChunkRefs: types.StringArray{"stale"}, SourceRefs: types.StringArray{"stale-document"}}
			}
			svc := &wikiIngestService{wikiService: pages, knowledgeSvc: liveKnowledgeStub{}, chunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"current": {citationChunk("current", "Current factual source.")}}}}
			updates := []SlugUpdate{{Slug: "summary/kn-1", Type: types.WikiPageTypeSummary, KnowledgeID: "kn-1", SourceRef: "kn-1", SummaryBody: "Current summary", SourceChunks: []string{"current", "current"}}}
			changed, _, failed, _, err := svc.reduceSlugUpdates(context.Background(), nil, "kb-1", "summary/kn-1", updates, 1, nil, nil)
			if err != nil || failed || !changed || pages.writes != 1 {
				t.Fatalf("summary write failed: %v", err)
			}
			if len(pages.page.ChunkRefs) != 1 || pages.page.ChunkRefs[0] != "current" {
				t.Fatalf("summary source refs=%v", pages.page.ChunkRefs)
			}
			if len(pages.page.SourceRefs) != 1 || pages.page.SourceRefs[0] != "kn-1" {
				t.Fatalf("summary retained stale document refs=%v", pages.page.SourceRefs)
			}
		})
	}
}

func TestRelayWikiSummaryMissingEvidencePreservesPage(t *testing.T) {
	for _, refs := range [][]string{nil, {"missing"}} {
		t.Run(strings.Join(refs, ","), func(t *testing.T) {
			pages := &relayGroundingPageStore{page: &types.WikiPage{Content: "Original draft", ChunkRefs: types.StringArray{"old"}}}
			svc := &wikiIngestService{wikiService: pages, knowledgeSvc: liveKnowledgeStub{}, chunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{}}}
			updates := []SlugUpdate{{Slug: "summary/kn-1", Type: types.WikiPageTypeSummary, KnowledgeID: "kn-1", SummaryBody: "New summary", SourceChunks: refs}}
			changed, _, failed, _, err := svc.reduceSlugUpdates(context.Background(), nil, "kb-1", "summary/kn-1", updates, 1, nil, nil)
			if err == nil || changed || !failed || pages.writes != 0 || pages.page.Content != "Original draft" {
				t.Fatalf("missing evidence changed draft: changed=%v failed=%v writes=%d err=%v", changed, failed, pages.writes, err)
			}
		})
	}
}

func TestRelayWikiEditorOmitsGeneratedContext(t *testing.T) {
	model, _, _, _, err := relayGroundingReduce(t, []string{"chunk-1"}, map[string][]*types.Chunk{"chunk-1": {citationChunk("chunk-1", "The source lists ALPHA_RANGE as a reference.")}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(model.messages[1].Content, "GENERATED_SUMMARY_CONTEXT") {
		t.Fatal("generated summary leaked into editor provider request")
	}
	if !strings.Contains(model.messages[1].Content, "The source lists ALPHA_RANGE as a reference.") {
		t.Fatal("raw source omitted")
	}
}

func TestRelayWikiSummaryMapCarriesSuppliedRawChunks(t *testing.T) {
	chunk := citationChunk("chunk-1", "Alpha has one supported setting.")
	repo := &relayGroundingMapChunks{citedChunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"chunk-1": {chunk}}}, chunks: []*types.Chunk{chunk}}
	svc := &wikiIngestService{knowledgeSvc: liveKnowledgeStub{}, wikiService: &relayGroundingPageStore{}, chunkRepo: repo}
	model := &relayGroundingLegacyModel{calls: map[string]int{}}
	batch := &WikiBatchContext{SummaryContentByKnowledgeID: func(context.Context, string) string { return "" }, SlugTitle: func(context.Context, string) string { return "" }}
	_, updates, err := svc.mapOneDocument(context.Background(), model, WikiIngestPayload{TenantID: 1, KnowledgeBaseID: "kb-1"}, WikiPendingOp{KnowledgeID: "kn-1", Op: WikiOpIngest}, batch)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, u := range updates {
		if u.Type == types.WikiPageTypeSummary {
			found = true
			if len(u.SourceChunks) != 1 || u.SourceChunks[0] != "chunk-1" {
				t.Fatalf("summary source set=%v", u.SourceChunks)
			}
		}
	}
	if !found {
		t.Fatal("summary absent")
	}
}

// This checks rendered provider-request policy, not model entailment.
func TestRelayWikiRenderedMentionGroundingContract(t *testing.T) {
	model := &templateCaptureChatModel{response: "SUMMARY: Alpha reference\n# Alpha\nAlpha is listed as a reference."}
	svc := &wikiIngestService{}
	_, err := svc.generateWithTemplate(context.Background(), model, agent.WikiPageModifyUserPrompt, map[string]string{"HasAdditions": "1", "PageTitle": "ALPHA_RANGE", "PageType": "entity", "NewContent": "ALPHA_RANGE is listed under References.", "Language": "English"})
	if err != nil {
		t.Fatal(err)
	}
	request := model.messages[0].Content + model.messages[1].Content
	for _, rule := range []string{"identifier names", "list membership or absence", "neutral mention", "no minimum length"} {
		if !strings.Contains(request, rule) {
			t.Errorf("missing generic grounding rule: %s", rule)
		}
	}
}

type relaySummaryRequestModel struct {
	relayGroundingLegacyModel
	summaryRequest string
}

func (m *relaySummaryRequestModel) Chat(ctx context.Context, messages []chat.Message, options *chat.ChatOptions) (*types.ChatResponse, error) {
	purpose, _ := types.LLMCallMetadataFromContext(ctx)
	if purpose == "wiki_summary" {
		for _, message := range messages {
			m.summaryRequest += message.Content
		}
	}
	return m.relayGroundingLegacyModel.Chat(ctx, messages, options)
}

func TestRelayWikiSummaryMapBoundsActualSourceSet(t *testing.T) {
	first := citationChunk("first", strings.Repeat("A", maxContentForWiki))
	first.ChunkIndex = 0
	tail := citationChunk("tail", "OMITTED_TAIL_CANARY")
	tail.ChunkIndex = 1
	foreign := citationChunk("foreign", "FOREIGN_DOCUMENT_CANARY")
	foreign.KnowledgeID = "another-document"
	wrongTenant := citationChunk("wrong-tenant", "FOREIGN_TENANT_CANARY")
	wrongTenant.TenantID = 2
	disabled := citationChunk("disabled", "DISABLED_TEXT_CANARY")
	disabled.IsEnabled = false
	caption := imageChildChunk("caption", "first", types.ChunkTypeImageCaption, `[{"url":"resource://image","caption":"GENERATED_CAPTION_CANARY"}]`, true)
	repo := &relayGroundingMapChunks{citedChunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"first": {first}, "tail": {tail}}}, chunks: []*types.Chunk{tail, foreign, wrongTenant, disabled, caption, first}}
	svc := &wikiIngestService{knowledgeSvc: liveKnowledgeStub{}, wikiService: &relayGroundingPageStore{}, chunkRepo: repo}
	model := &relaySummaryRequestModel{relayGroundingLegacyModel: relayGroundingLegacyModel{calls: map[string]int{}}}
	batch := &WikiBatchContext{SummaryContentByKnowledgeID: func(context.Context, string) string { return "" }, SlugTitle: func(context.Context, string) string { return "" }}
	_, updates, err := svc.mapOneDocument(context.Background(), model, WikiIngestPayload{TenantID: 1, KnowledgeBaseID: "kb-1"}, WikiPendingOp{KnowledgeID: "kn-1", Op: WikiOpIngest}, batch)
	if err != nil {
		t.Fatal(err)
	}
	for _, canary := range []string{"OMITTED_TAIL_CANARY", "FOREIGN_DOCUMENT_CANARY", "FOREIGN_TENANT_CANARY", "DISABLED_TEXT_CANARY", "GENERATED_CAPTION_CANARY"} {
		if strings.Contains(model.summaryRequest, canary) {
			t.Errorf("unsupplied raw evidence admitted to summary request: %s", canary)
		}
	}
	if !strings.Contains(model.summaryRequest, strings.Repeat("A", maxContentForWiki)) {
		t.Fatal("bounded raw source prefix absent")
	}
	found := false
	for _, u := range updates {
		if u.Type == types.WikiPageTypeSummary {
			found = true
			if len(u.SourceChunks) != 1 || u.SourceChunks[0] != "first" {
				t.Fatalf("summary refs exceed actual source prefix: %v", u.SourceChunks)
			}
		}
	}
	if !found {
		t.Fatal("summary absent")
	}
}

func TestRelayWikiSourceResolverRejectsAmbiguousDocumentOwnership(t *testing.T) {
	svc := &wikiIngestService{chunkRepo: &citedChunkRepo{byID: map[string][]*types.Chunk{"shared": {citationChunk("shared", "Supported only by kn-1.")}}}}
	got := svc.resolveCitedChunks(context.Background(), 1, []SlugUpdate{{KnowledgeID: "kn-1", SourceChunks: []string{"shared"}}, {KnowledgeID: "kn-2", SourceChunks: []string{"shared"}}})
	if len(got) != 0 {
		t.Fatal("global chunk map allowed a valid owner's evidence to satisfy another document")
	}
}

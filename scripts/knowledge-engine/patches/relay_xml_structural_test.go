package sqlite

import (
	"context"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

// A prose frequency match must not evict an explicit XML element at TopK.
func TestRelayXMLStructuralCandidatesBeforeLimit(t *testing.T) {
	for _, tc := range []struct{ name, query, source string }{
		{"open", "<Node>", "<Node>"},
		{"attributes", "<Node>", "<Node key=\"value\">"},
		{"whitespace", "<Node>", "<Node\n key='value' >"},
		{"self closing", "<Node />", "<Node/>"},
		{"closing", "</Node>", "</Node >"},
		{"namespace", "<p:Node>", "<p:Node key='value'/>"},
		{"punctuated name", "<_Node-Part.Value>", "<_Node-Part.Value/>"},
		{"attribute query", "<Node key='value'>", "<Node different='text'/>"},
		{"all query tags", "<Node> <Leaf>", "<Node><Leaf/>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			if !repo.db.Migrator().HasTable("lite_embeddings_fts") {
				t.Skip("FTS5 unavailable")
			}
			prose := sqliteTestIndex("prose", "kb", "prose-doc", "", true)
			prose.Content = "Node Leaf p Node Leaf p"
			target := sqliteTestIndex("target", "kb", "target-doc", "", true)
			target.Content = strings.Repeat("filler ", 120) + tc.source
			blocked := sqliteTestIndex("blocked", "other-kb", "blocked-doc", "", true)
			blocked.Content = tc.source
			for _, item := range []*types.IndexInfo{prose, target, blocked} {
				saveSQLiteTestVector(t, repo, item, []float32{1, 0})
			}
			got, err := repo.keywordsRetrieve(context.Background(), types.RetrieveParams{Query: tc.query, TopK: 1, KnowledgeBaseIDs: []string{"kb"}, RetrieverType: types.KeywordsRetrieverType})
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Len(t, got[0].Results, 1)
			require.Equal(t, "target", got[0].Results[0].ChunkID)
		})
	}
}

func TestRelayXMLStructuralFallbackAndBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, query, target, decoy string
		want                       string
	}{
		{"case sensitive", "<Node>", "Node", "<node> filler filler filler filler", "target"},
		{"name boundary", "<Node>", "Node", "<NodeExtra> Node", "target"},
		{"prose comparison", "a < b > c", "a b c", "<b> filler filler filler filler filler", "target"},
		{"malformed attribute", "<Node garbage>", "Node garbage", "<Node> filler filler filler filler filler", "target"},
		{"no structural evidence", "<Absent>", "Absent", "Absent filler filler filler filler filler", "target"},
		{"all tags required", "<Node> <Leaf>", "<Node><Leaf/> filler filler filler", "<Node> Leaf", "target"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			if !repo.db.Migrator().HasTable("lite_embeddings_fts") {
				t.Skip("FTS5 unavailable")
			}
			a := sqliteTestIndex("target", "kb", "target-doc", "", true)
			a.Content = tc.target
			b := sqliteTestIndex("decoy", "kb", "decoy-doc", "", true)
			b.Content = tc.decoy
			saveSQLiteTestVector(t, repo, a, []float32{1, 0})
			saveSQLiteTestVector(t, repo, b, []float32{1, 0})
			got := keywordSearch(t, repo, tc.query)
			require.NotEmpty(t, got)
			require.Equal(t, tc.want, got[0].ChunkID)
		})
	}
}
func TestRelayXMLStructuralCandidatesRespectDocumentAndEnabledScope(t *testing.T) {
	repo := newSQLiteRetrieverTestRepository(t)
	if !repo.db.Migrator().HasTable("lite_embeddings_fts") {
		t.Skip("FTS5 unavailable")
	}
	for _, info := range []*types.IndexInfo{
		{SourceID: "allowed", SourceType: types.ChunkSourceType, ChunkID: "allowed", KnowledgeID: "allowed-doc", KnowledgeBaseID: "kb", Content: strings.Repeat("filler ", 120) + "<Node/>", IsEnabled: true},
		{SourceID: "forbidden", SourceType: types.ChunkSourceType, ChunkID: "forbidden", KnowledgeID: "forbidden-doc", KnowledgeBaseID: "kb", Content: "<Node/>", IsEnabled: true},
		{SourceID: "disabled", SourceType: types.ChunkSourceType, ChunkID: "disabled", KnowledgeID: "allowed-doc", KnowledgeBaseID: "kb", Content: "<Node/>", IsEnabled: false},
	} {
		saveSQLiteTestVector(t, repo, info, []float32{1, 0})
	}
	got, err := repo.keywordsRetrieve(context.Background(), types.RetrieveParams{Query: "<Node>", TopK: 1, KnowledgeIDs: []string{"allowed-doc"}, RetrieverType: types.KeywordsRetrieverType})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Len(t, got[0].Results, 1)
	require.Equal(t, "allowed", got[0].Results[0].ChunkID)
}

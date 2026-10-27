package sqlite

import (
	"context"
	"strings"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelayXMLEncodedComparisonBeforeLimit(t *testing.T) {
	for _, tc := range []struct{ name, query, literal, prose string }{
		{"named angles", "<Node>", "&lt;Node&gt;", "Node"},
		{"upper entity names", "<Node>", "&LT;Node&GT;", "Node"},
		{"attributes", "<Node>", "&lt;Node key='value'&gt;", "Node"},
		{"self closing", "<Node>", "&lt;Node/&gt;", "Node"},
		{"closing", "</Node>", "&lt;/Node&gt;", "Node"},
		{"namespace", "<p:Node>", "&lt;p:Node key='value'/&gt;", "p Node"},
		{"raw encoded conjunction", "<Root> <Node>", "<Root>&lt;Node/&gt;", "Root Node"},
		{"identifier conjunction", "<Node> LOAD_RECORD", "&lt;Node&gt; LOAD_RECORD()", "&lt;Node&gt; LOAD RECORD"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			require.True(t, repo.db.Migrator().HasTable("lite_embeddings_fts"))
			original := strings.Repeat("filler ", 120) + tc.literal
			target := sqliteTestIndex("target", "kb", "allowed", "", true)
			target.Content = original
			prose := sqliteTestIndex("prose", "kb", "allowed", "", true)
			prose.Content = tc.prose
			forbidden := sqliteTestIndex("forbidden", "kb", "other-doc", "", true)
			forbidden.Content = tc.literal
			disabled := sqliteTestIndex("disabled", "kb", "allowed", "", false)
			disabled.Content = tc.literal
			for _, r := range []*types.IndexInfo{prose, target, forbidden, disabled} {
				saveSQLiteTestVector(t, repo, r, []float32{1, 0})
			}
			got, err := repo.keywordsRetrieve(context.Background(), types.RetrieveParams{Query: tc.query, KnowledgeIDs: []string{"allowed"}, TopK: 1, RetrieverType: types.KeywordsRetrieverType})
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Len(t, got[0].Results, 1)
			require.Equal(t, "target", got[0].Results[0].ChunkID)
			require.Equal(t, original, got[0].Results[0].Content, "comparison must not rewrite returned source")
			var stored string
			require.NoError(t, repo.db.Raw("SELECT content FROM lite_embeddings WHERE chunk_id = ?", "target").Scan(&stored).Error)
			require.Equal(t, original, stored, "comparison must not rewrite indexed source")
		})
	}
}

func TestRelayXMLEncodedComparisonDoesNotGeneralUnescape(t *testing.T) {
	for _, tc := range []struct{ name, encoded string }{
		{"element case", "&lt;node&gt;"},
		{"element name prefix", "&lt;NodeExtra&gt; Node"},
		{"double encoded", "&amp;lt;Node&amp;gt;"},
		{"different mixed-case entity", "&Lt;Node&gt;"},
		{"numeric entity outside contract", "&#60;Node&#62;"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			require.True(t, repo.db.Migrator().HasTable("lite_embeddings_fts"))
			prose := sqliteTestIndex("prose", "kb", "a", "", true)
			prose.Content = "Node"
			decoy := sqliteTestIndex("decoy", "kb", "b", "", true)
			decoy.Content = strings.Repeat("filler ", 120) + tc.encoded
			saveSQLiteTestVector(t, repo, prose, []float32{1, 0})
			saveSQLiteTestVector(t, repo, decoy, []float32{1, 0})
			got := keywordSearch(t, repo, "<Node>")
			require.NotEmpty(t, got)
			require.Equal(t, "prose", got[0].ChunkID)
		})
	}
}

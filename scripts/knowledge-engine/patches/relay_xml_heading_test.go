package sqlite

import (
	"context"
	"strings"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelayXMLHeadingPriorityBeforeKeywordFusion(t *testing.T) {
	for _, tc := range []struct{ name, heading string }{
		{"raw", "# SampleManager <field>"},
		{"encoded with anchors", "<a id=\"main\"></a>\n\n# <a id=\"title\"></a> &lt;field&gt;"},
		{"upper entities", "## SampleManager &LT;field&GT;"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			require.True(t, repo.db.Migrator().HasTable("lite_embeddings_fts"))
			target := sqliteTestIndex("target", "kb", "target-doc", "", true)
			target.Content = tc.heading + "\n\nSampleManager 21.3 field"
			decoy := sqliteTestIndex("decoy", "kb", "decoy-doc", "", true)
			decoy.Content = "SampleManager 21.3 " + strings.Repeat("<field> ", 30)
			for _, item := range []*types.IndexInfo{decoy, target} {
				saveSQLiteTestVector(t, repo, item, []float32{1, 0})
			}
			got, err := repo.keywordsRetrieve(context.Background(), types.RetrieveParams{Query: "SampleManager 21.3 <field>", TopK: 2, KnowledgeBaseIDs: []string{"kb"}, RetrieverType: types.KeywordsRetrieverType})
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Len(t, got[0].Results, 2)
			require.Equal(t, "target", got[0].Results[0].ChunkID)
			require.True(t, got[0].Results[0].KeywordStructuralMatch)
			require.True(t, got[0].Results[0].KeywordStructuralHeadingMatch)
			require.False(t, got[0].Results[1].KeywordStructuralHeadingMatch)
		})
	}
}

func TestRelayXMLHeadingBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, query, content string
		want                 bool
	}{
		{"case sensitive", "<Node>", "# <node>", false},
		{"body is not heading", "<Node>", "Example <Node>", false},
		{"fenced backtick code", "<Node>", "```md\n# <Node>\n```", false},
		{"fenced tilde code", "<Node>", "~~~md\n# <Node>\n~~~", false},
		{"heading after fence", "<Node>", "```md\n# example\n```\n# <Node>", true},
		{"all elements in heading", "<Root> <Node>", "# <Root> <Node/>", true},
		{"missing element in heading", "<Root> <Node>", "# <Root>", false},
		{"heading level seven", "<Node>", "####### <Node>", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, keywordXMLHeadingMatch(tc.query, tc.content))
		})
	}
}

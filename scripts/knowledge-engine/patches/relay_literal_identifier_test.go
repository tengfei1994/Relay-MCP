package sqlite

import (
	"context"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

// Technical identifiers keep their spelling; split-word prose is broad fallback.
func TestRelayLiteralIdentifierCandidatesBeforeLimit(t *testing.T) {
	for _, tc := range []struct{ name, query, literal, prose string }{
		{"call", "LOAD_RECORD", "LOAD_RECORD(argument)", "LOAD RECORD"},
		{"context word", "language LOAD_RECORD", "LOAD_RECORD(argument)", "language LOAD RECORD"},
		{"lower case", "load_record", "load_record(argument)", "load record"},
		{"multiple segments", "table_row_id", "table_row_id", "table row id"},
		{"quoted", "`LOAD_RECORD`", "LOAD_RECORD(argument)", "LOAD RECORD"},
		{"case insensitive", "load_record", "LOAD_RECORD(argument)", "load record"},
		{"sentence punctuation", "LOAD_RECORD.", "LOAD_RECORD(argument)", "LOAD RECORD"},
		{"conjunction", "LOAD_RECORD SAVE_ROW", "LOAD_RECORD() SAVE_ROW()", "LOAD_RECORD() SAVE ROW"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			require.True(t, repo.db.Migrator().HasTable("lite_embeddings_fts"))
			target := sqliteTestIndex("target", "kb", "allowed", "", true)
			target.Content = strings.Repeat("filler ", 120) + tc.literal
			prose := sqliteTestIndex("prose", "kb", "allowed", "", true)
			prose.Content = tc.prose
			forbidden := sqliteTestIndex("forbidden", "kb", "forbidden", "", true)
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
		})
	}
}
func TestRelayLiteralIdentifierBoundariesAndXMLAttributes(t *testing.T) {
	for _, tc := range []struct{ name, query, target, decoy string }{
		{"identifier boundary", "LOAD_RECORD", "LOAD_RECORD() filler filler filler filler", "PRE_LOAD_RECORD_POST LOAD RECORD"},
		{"XML attributes are not identifiers", "<Node some_key='value'>", "<Node other='text'/> filler filler filler filler", "some_key value Node"},
		{"ordinary prose fallback", "load record", "load record", "LOAD_RECORD filler filler filler filler"},
		{"numeric separators fallback", "1_000", "1 000", "x1_000 filler filler filler filler"},
		{"filename fallback", "foo_bar.txt", "foo bar txt", "foo_bar txt filler filler filler filler"},
		{"path fallback", "dir/foo_bar/file", "dir foo bar file", "foo_bar filler filler filler filler"},
		{"windows path fallback", `C:\dir\foo_bar`, `C dir foo bar`, "foo_bar filler filler filler filler"},
		{"version fallback", "v1_2", "v1 2", "v1_2 filler filler filler filler"},
		{"element identifier conjunction", "<Node> LOAD_RECORD", "<Node> LOAD_RECORD() filler filler filler filler", "<Node> LOAD RECORD"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := newSQLiteRetrieverTestRepository(t)
			require.True(t, repo.db.Migrator().HasTable("lite_embeddings_fts"))
			a := sqliteTestIndex("target", "kb", "a", "", true)
			a.Content = tc.target
			b := sqliteTestIndex("decoy", "kb", "b", "", true)
			b.Content = tc.decoy
			saveSQLiteTestVector(t, repo, a, []float32{1, 0})
			saveSQLiteTestVector(t, repo, b, []float32{1, 0})
			got := keywordSearch(t, repo, tc.query)
			require.NotEmpty(t, got)
			require.Equal(t, "target", got[0].ChunkID)
		})
	}
}

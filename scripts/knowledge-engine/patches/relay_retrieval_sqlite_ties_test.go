package sqlite

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelayRetrievalKeywordCutoffStableTies(t *testing.T) {
	repository := newSQLiteRetrieverTestRepository(t)
	require.True(t, repository.db.Migrator().HasTable("lite_embeddings_fts"), "the regression requires an FTS5-enabled build")
	for _, id := range []string{"z", "b", "a"} {
		info := sqliteTestIndex(id, "kb", "manual-"+id, "", true)
		info.Content = "shared keyword example"
		saveSQLiteTestVector(t, repository, info, []float32{1, 0})
	}
	got, err := repository.keywordsRetrieve(context.Background(), types.RetrieveParams{Query: "keyword", TopK: 2, RetrieverType: types.KeywordsRetrieverType})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Len(t, got[0].Results, 2)
	require.Equal(t, "a", got[0].Results[0].ChunkID, "equal-score cutoff must not depend on insertion order")
	require.Equal(t, "b", got[0].Results[1].ChunkID)
}

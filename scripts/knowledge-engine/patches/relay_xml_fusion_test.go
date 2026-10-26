package service

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	retrieversqlite "github.com/Tencent/WeKnora/internal/application/repository/retriever/sqlite"
	"github.com/Tencent/WeKnora/internal/types"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/stretchr/testify/require"
	gormsqlite "gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// SQL ordering alone is insufficient: keyword fusion used to re-sort on BM25.
func TestRelayXMLStructuralPrioritySurvivesRealSQLiteFusion(t *testing.T) {
	sqlitevec.Auto()
	db, err := gorm.Open(gormsqlite.Open(filepath.Join(t.TempDir(), "search.db")), &gorm.Config{})
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	require.NoError(t, db.Exec("CREATE TABLE chunks(id TEXT, chunk_type TEXT, is_enabled BOOLEAN)").Error)
	repo := retrieversqlite.NewSQLiteRetrieveEngineRepository(db)
	if !db.Migrator().HasTable("lite_embeddings_fts") {
		t.Skip("FTS5 unavailable")
	}
	for _, item := range []struct{ id, content string }{{"prose", "Node"}, {"target", strings.Repeat("filler ", 120) + "<Node key='value'/>"}} {
		info := &types.IndexInfo{SourceID: item.id, SourceType: types.ChunkSourceType, ChunkID: item.id, KnowledgeID: item.id, KnowledgeBaseID: "kb", Content: item.content, IsEnabled: true}
		require.NoError(t, repo.Save(context.Background(), info, map[string]any{"embedding": map[string][]float32{item.id: {1, 0}}}))
	}
	for _, hybrid := range []bool{false, true} {
		name := "keyword-only"
		if hybrid {
			name = "hybrid"
		}
		t.Run(name, func(t *testing.T) {
			got, err := repo.Retrieve(context.Background(), types.RetrieveParams{Query: "<Node>", TopK: 10, KnowledgeBaseIDs: []string{"kb"}, RetrieverType: types.KeywordsRetrieverType})
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Len(t, got[0].Results, 2)
			keyword := got[0].Results
			raw := map[string]float64{}
			for _, r := range keyword {
				raw[r.ChunkID] = r.Score
			}
			require.Greater(t, raw["prose"], raw["target"], "fixture must give prose higher raw BM25")
			var vectors [][]*types.IndexWithScore
			if hybrid {
				vectors = [][]*types.IndexWithScore{{{ChunkID: "prose", Score: .8}, {ChunkID: "target", Score: .7}}}
			}
			ranked := fuseOrDeduplicate(context.Background(), vectors, [][]*types.IndexWithScore{keyword}, nil)
			require.Equal(t, "target", ranked[0].ChunkID, "structural preference must survive keyword-only and RRF paths")
			if !hybrid {
				require.InDelta(t, raw["target"]/raw["prose"], ranked[0].Score, 1e-9, "preserve BM25 normalization instead of synthesizing ordinal scores")
			}
		})
	}
}

func TestRelayXMLStructuralKeywordTiesAndPrivateMetadata(t *testing.T) {
	for i := 0; i < 32; i++ {
		items := []*types.IndexWithScore{{ChunkID: "b", Score: 2, KeywordStructuralMatch: true}, {ChunkID: "a", Score: 2, KeywordStructuralMatch: true}, {ChunkID: "prose", Score: 8}}
		ranked := fuseOrDeduplicate(context.Background(), nil, [][]*types.IndexWithScore{items}, nil)
		require.Equal(t, "a", ranked[0].ChunkID)
		require.Equal(t, "b", ranked[1].ChunkID)
		require.Equal(t, "prose", ranked[2].ChunkID)
		require.Equal(t, 0.25, ranked[0].Score)
		raw, err := json.Marshal(ranked[0])
		require.NoError(t, err)
		require.NotContains(t, string(raw), "KeywordStructuralMatch")
	}
}

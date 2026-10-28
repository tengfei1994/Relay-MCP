package service

import (
	"context"
	retrieversqlite "github.com/Tencent/WeKnora/internal/application/repository/retriever/sqlite"
	"github.com/Tencent/WeKnora/internal/types"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	"github.com/stretchr/testify/require"
	gormsqlite "gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"path/filepath"
	"strings"
	"testing"
)

func TestRelayLiteralIdentifierSurvivesSQLiteFusion(t *testing.T) {
	sqlitevec.Auto()
	db, err := gorm.Open(gormsqlite.Open(filepath.Join(t.TempDir(), "literal.db")), &gorm.Config{})
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	defer conn.Close()
	require.NoError(t, db.Exec("CREATE TABLE chunks(id TEXT, chunk_type TEXT, is_enabled BOOLEAN)").Error)
	repo := retrieversqlite.NewSQLiteRetrieveEngineRepository(db)
	require.True(t, db.Migrator().HasTable("lite_embeddings_fts"))
	for _, r := range []struct{ id, content string }{{"prose", "LOAD RECORD"}, {"target", strings.Repeat("filler ", 120) + "LOAD_RECORD(argument)"}} {
		info := &types.IndexInfo{SourceID: r.id, SourceType: types.ChunkSourceType, ChunkID: r.id, KnowledgeID: r.id, KnowledgeBaseID: "kb", Content: r.content, IsEnabled: true}
		require.NoError(t, repo.Save(context.Background(), info, map[string]any{"embedding": map[string][]float32{r.id: {1, 0}}}))
	}
	for _, hybrid := range []bool{false, true} {
		name := "keyword-only"
		if hybrid {
			name = "hybrid"
		}
		t.Run(name, func(t *testing.T) {
			raw, err := repo.Retrieve(context.Background(), types.RetrieveParams{Query: "LOAD_RECORD", TopK: 10, RetrieverType: types.KeywordsRetrieverType, KnowledgeBaseIDs: []string{"kb"}})
			require.NoError(t, err)
			require.Len(t, raw, 1)
			require.Len(t, raw[0].Results, 2)
			scores := map[string]float64{}
			for _, r := range raw[0].Results {
				scores[r.ChunkID] = r.Score
			}
			require.Greater(t, scores["prose"], scores["target"])
			var vectors [][]*types.IndexWithScore
			if hybrid {
				vectors = [][]*types.IndexWithScore{{{ChunkID: "prose", Score: .8}, {ChunkID: "target", Score: .7}}}
			}
			got := fuseOrDeduplicate(context.Background(), vectors, [][]*types.IndexWithScore{raw[0].Results}, nil)
			require.Equal(t, "target", got[0].ChunkID)
			if !hybrid {
				require.InDelta(t, scores["target"]/scores["prose"], got[0].Score, 1e-9)
			}
		})
	}
}

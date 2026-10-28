package service

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

// Relay #53 requires technical keyword recall to take priority. These tests
// exercise the existing fusion implementation, without fixture-specific terms.
func TestRelayKeywordFirstRRFDefaults(t *testing.T) {
	for name, cfg := range map[string]*types.RetrievalConfig{
		"nil": nil, "unset": {}, "nonpositive": {RRFVectorWeight: -1, RRFKeywordWeight: -1},
		"zero-negative": {RRFVectorWeight: 0, RRFKeywordWeight: -1},
	} {
		t.Run(name, func(t *testing.T) {
			got := fuseOrDeduplicate(context.Background(),
				[][]*types.IndexWithScore{{{ChunkID: "vector-only", Score: 0.9}}},
				[][]*types.IndexWithScore{{{ChunkID: "keyword-only", Score: 20}}}, cfg)
			require.Len(t, got, 2)
			require.Equal(t, "keyword-only", got[0].ChunkID)
			require.InDelta(t, 0.7, got[0].Score, 1e-9)
			require.Equal(t, "vector-only", got[1].ChunkID)
			require.InDelta(t, 0.3, got[1].Score, 1e-9)
		})
	}
}

func TestRelayKeywordFirstRRFVectorStillContributes(t *testing.T) {
	got := fuseOrDeduplicate(context.Background(),
		[][]*types.IndexWithScore{{{ChunkID: "both", Score: 0.9}}},
		[][]*types.IndexWithScore{{{ChunkID: "keyword-only", Score: 20}, {ChunkID: "both", Score: 10}}}, nil)
	require.Equal(t, "both", got[0].ChunkID)
	require.InDelta(t, 0.3+0.7*61.0/62.0, got[0].Score, 1e-9)
	require.Greater(t, got[0].Score, 0.7*61.0/62.0)
}

func TestRelayKeywordFirstRRFExplicitSettingsPreserved(t *testing.T) {
	cfg := &types.RetrievalConfig{RRFVectorWeight: 0.8, RRFKeywordWeight: 0.2, RRFK: 17,
		EmbeddingTopK: 66, VectorThreshold: 0.42, KeywordThreshold: 0.24,
		RerankTopK: 12, RerankThreshold: -0.1, RerankModelID: "user-reranker"}
	before := *cfg
	got := fuseOrDeduplicate(context.Background(),
		[][]*types.IndexWithScore{{{ChunkID: "vector-only", Score: 0.9}}},
		[][]*types.IndexWithScore{{{ChunkID: "keyword-only", Score: 20}}}, cfg)
	require.Equal(t, "vector-only", got[0].ChunkID)
	require.InDelta(t, 0.8, got[0].Score, 1e-9)
	require.InDelta(t, 0.2, got[1].Score, 1e-9)
	require.Equal(t, 17, cfg.GetEffectiveRRFK())
	require.Equal(t, before, *cfg)
	for _, tc := range []struct{ vector, keyword, wantVector, wantKeyword float64 }{
		{0.9, 0, 0.9, 0.3}, {0, 0.1, 0.7, 0.1},
		{0.9, -0.1, 0.9, 0.3}, {-0.1, 0.1, 0.7, 0.1},
	} {
		partial := &types.RetrievalConfig{RRFVectorWeight: tc.vector, RRFKeywordWeight: tc.keyword}
		vector, keyword := partial.GetEffectiveRRFWeights()
		require.Equal(t, tc.wantVector, vector)
		require.Equal(t, tc.wantKeyword, keyword)
	}
}

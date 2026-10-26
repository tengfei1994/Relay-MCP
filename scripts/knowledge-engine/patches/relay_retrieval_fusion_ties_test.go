package service

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelayRetrievalFusionStableTies(t *testing.T) {
	a := &types.IndexWithScore{ChunkID: "a", Score: 1}
	b := &types.IndexWithScore{ChunkID: "b", Score: 1}
	require.Less(t, sortByScoreDesc(a, b), 0, "tied scores must use stable chunk identity")
	require.Greater(t, sortByScoreDesc(b, a), 0)
	for i := 0; i < 64; i++ {
		got := deduplicateByScore([]*types.IndexWithScore{b, a})
		require.Equal(t, "a", got[0].ChunkID)
		require.Equal(t, "b", got[1].ChunkID)
		ranks := bestRanks([][]*types.IndexWithScore{{b, a}})
		require.Equal(t, 1, ranks["a"])
		require.Equal(t, 2, ranks["b"])
		fused := fuseOrDeduplicate(context.Background(), [][]*types.IndexWithScore{{{ChunkID: "z", Score: 0.9}}}, [][]*types.IndexWithScore{{{ChunkID: "b", Score: 10}, {ChunkID: "a", Score: 10}}}, nil)
		require.Equal(t, "a", fused[0].ChunkID)
		require.Equal(t, "b", fused[1].ChunkID)
	}
}

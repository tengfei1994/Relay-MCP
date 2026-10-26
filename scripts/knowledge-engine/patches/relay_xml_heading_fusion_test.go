package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelayXMLHeadingPrioritySurvivesKeywordFusion(t *testing.T) {
	for _, hybrid := range []bool{false, true} {
		keyword := []*types.IndexWithScore{
			{ChunkID: "body", Score: 8, KeywordStructuralMatch: true},
			{ChunkID: "heading", Score: 2, KeywordStructuralMatch: true, KeywordStructuralHeadingMatch: true},
			{ChunkID: "prose", Score: 9},
		}
		var vectors [][]*types.IndexWithScore
		if hybrid {
			vectors = [][]*types.IndexWithScore{{
				{ChunkID: "body", Score: .9},
				{ChunkID: "heading", Score: .8},
				{ChunkID: "prose", Score: .7},
			}}
		}
		ranked := fuseOrDeduplicate(context.Background(), vectors, [][]*types.IndexWithScore{keyword}, nil)
		require.Equal(t, "heading", ranked[0].ChunkID)
		require.True(t, ranked[0].KeywordStructuralHeadingMatch)
		raw, err := json.Marshal(ranked[0])
		require.NoError(t, err)
		require.NotContains(t, string(raw), "KeywordStructuralHeadingMatch")
	}
}

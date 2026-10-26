package chatpipeline

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestRelaySourceAwareExactDedup(t *testing.T) {
	body := "<setting name=\"shared-key\">same independently citable configuration example</setting>"
	a := &types.SearchResult{ID: "a", KnowledgeID: "manual-a", Content: body, Score: 0.9}
	b := &types.SearchResult{ID: "b", KnowledgeID: "manual-b", Content: body, Score: 0.8}
	require.Equal(t, []*types.SearchResult{a, b}, removeDuplicateResults([]*types.SearchResult{a, b}), "distinct sources must retain their own citations")
	same := &types.SearchResult{ID: "a-copy", KnowledgeID: "manual-a", Content: body, Score: 0.5}
	require.Equal(t, []*types.SearchResult{a}, removeDuplicateResults([]*types.SearchResult{a, same, a}), "same-source repeated content and chunk IDs still deduplicate")
}

func TestRelaySourceAwarePartialOverlap(t *testing.T) {
	for _, distinct := range []bool{true, false} {
		source := "manual-a"
		if distinct {
			source = "manual-b"
		}
		a := &types.SearchResult{ID: "a", KnowledgeID: "manual-a", Content: "alpha beta gamma delta epsilon zeta eta theta", Score: 0.9}
		b := &types.SearchResult{ID: "b", KnowledgeID: source, Content: "alpha beta gamma delta epsilon zeta eta theta iota", Score: 0.5}
		got := removePartialOverlaps(context.Background(), []*types.SearchResult{a, b})
		if distinct {
			require.Equal(t, []*types.SearchResult{a, b}, got, "overlap cannot erase a separately citable source")
		} else {
			require.Equal(t, []*types.SearchResult{a}, got)
		}
	}
}

func TestRelaySourceAwareUnknownCannotEraseKnown(t *testing.T) {
	body := "a shared independently citable configuration example with stable source metadata"
	unknown := &types.SearchResult{ID: "unknown", Content: body, Score: 0.95}
	a := &types.SearchResult{ID: "a", KnowledgeID: "manual-a", Content: body, Score: 0.9}
	b := &types.SearchResult{ID: "b", KnowledgeID: "manual-b", Content: body, Score: 0.8}
	require.Equal(t, []*types.SearchResult{unknown, a, b}, removeDuplicateResults([]*types.SearchResult{unknown, a, b}))
	require.Equal(t, []*types.SearchResult{unknown, a, b}, removePartialOverlaps(context.Background(), []*types.SearchResult{unknown, a, b}))
}

func TestRelaySourceAwareTokenOverlap(t *testing.T) {
	a := &types.SearchResult{ID: "a", KnowledgeID: "manual-a", Content: "alpha beta gamma delta epsilon zeta eta theta", Score: 0.9}
	b := &types.SearchResult{ID: "b", KnowledgeID: "manual-b", Content: "alpha gamma beta delta epsilon zeta eta theta iota", Score: 0.8}
	require.Equal(t, []*types.SearchResult{a, b}, removePartialOverlaps(context.Background(), []*types.SearchResult{a, b}))
	b.KnowledgeID = a.KnowledgeID
	require.Equal(t, []*types.SearchResult{a}, removePartialOverlaps(context.Background(), []*types.SearchResult{a, b}))
}

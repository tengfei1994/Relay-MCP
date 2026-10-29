/** Query indexes for bounded Product graph adjacency expansion. */
export const PRODUCT_GRAPH_QUERY_INDEXES_MIGRATION = {
  version: "050-product-graph-query-indexes",
  sql: `
CREATE INDEX IF NOT EXISTS idx_product_graph_entities_scope_canonical
  ON knowledge_product_graph_entities(project_id, environment, canonical_key, id);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_from_endpoint
  ON knowledge_product_graph_relations(from_entity_id, relation_type, to_entity_id);
CREATE INDEX IF NOT EXISTS idx_product_graph_relations_to_endpoint
  ON knowledge_product_graph_relations(to_entity_id, relation_type, from_entity_id);
`
};

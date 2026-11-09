import { strict as assert } from "node:assert";
import { test } from "vitest";
import { classifyElasticsearchRequestRisk, classifyElasticsearchSourceRisk } from "../../apps/desktop/src/lib/elasticsearch/elasticsearchRequestRisk.ts";
import type { ElasticsearchRequestRisk } from "../../apps/desktop/src/lib/elasticsearch/elasticsearchRequestRisk.ts";

// Keep these route-role cases aligned with classifies_elasticsearch_route_roles in Rust.
const routeCases: [string, ElasticsearchRequestRisk][] = [
  ["POST /books/_doc/_search", "write"],
  ["POST /books/_doc/_count", "write"],
  ["POST /books/_doc/_sql", "write"],
  ["POST /books/_doc/_bulk", "write"],
  ["POST /books/_doc/_doc", "write"],
  ["POST /books/_doc/plain-id", "write"],
  ["POST /books/_create/_search", "write"],
  ["POST /books/_create/_count", "write"],
  ["POST /books/_create/_sql", "write"],
  ["POST /books/_create/_bulk", "write"],
  ["POST /books/_create/_doc", "write"],
  ["POST /books/_create/plain-id", "write"],
  ["POST /books/_update/_search", "write"],
  ["POST /books/_update/_count", "write"],
  ["POST /books/_update/_sql", "write"],
  ["POST /books/_update/_bulk", "write"],
  ["POST /books/_update/_doc", "write"],
  ["POST /books/_update/plain-id", "write"],
  ["POST /books/_doc", "write"],
  ["POST /_bulk", "write"],
  ["POST /books/_bulk", "write"],
  ["PUT /books/_doc/_search", "write"],
  ["PUT /books/_create/_sql", "write"],
  ["DELETE /books/_doc/_count", "write"],
  ["post books/_doc/_search?refresh=true", "write"],
  ["POST /books/_doc/_search/", "write"],
  ["POST /_search", "read"],
  ["POST /books/_search", "read"],
  ["POST /_count", "read"],
  ["POST /books/_count", "read"],
  ["POST /_msearch", "read"],
  ["POST /books/_msearch", "read"],
  ["POST /_field_caps", "read"],
  ["POST /books/_field_caps", "read"],
  ["POST /_rank_eval", "read"],
  ["POST /books/_rank_eval", "read"],
  ["POST /_search_shards", "read"],
  ["POST /books/_search_shards", "read"],
  ["POST /_validate/query", "read"],
  ["POST /books/_validate/query", "read"],
  ["POST /_search/template", "read"],
  ["POST /books/_search/template", "read"],
  ["POST /_msearch/template", "read"],
  ["POST /books/_msearch/template", "read"],
  ["POST /books/_terms_enum", "read"],
  ["POST /books/_explain/_doc", "read"],
  ["POST /books/_explain/_update", "read"],
  ["POST /_sql", "read"],
  ["POST /_sql/translate", "read"],
  ["POST /_sql/close", "read"],
  ["POST /_search/scroll", "read"],
  ["POST /_search/scroll/_doc", "read"],
  ["post /books/_search?pretty=true", "read"],
  ["POST /books/_search/", "read"],
  ["POST /_all/_search", "read"],
  ["POST /.internal/_search", "read"],
  ["POST books/_search", "read"],
  ["POST /_scripts/_search", "dangerous"],
  ["POST /_scripts/_count", "dangerous"],
  ["POST /_doc/_search", "dangerous"],
  ["POST /books/_sql", "dangerous"],
  ["POST /books/_sql/close", "dangerous"],
  ["POST /_sql/close/extra", "dangerous"],
  ["POST /_sql/unknown", "dangerous"],
  ["POST /_terms_enum", "dangerous"],
  ["POST /books/_validate", "dangerous"],
  ["POST /books/_explain", "dangerous"],
  ["POST /books/_create", "dangerous"],
  ["POST /books/_update", "dangerous"],
  ["POST /books/_bulk/_search", "dangerous"],
  ["POST /books/_doc/_search/extra", "dangerous"],
  ["POST /books/_search/extra", "dangerous"],
  ["POST /books/_search/scroll", "dangerous"],
  ["POST /books/type/_search", "dangerous"],
  ["POST /books/slice/_search", "dangerous"],
  ["POST /books/_update_by_query", "dangerous"],
  ["POST /books/_delete_by_query", "dangerous"],
  ["POST /_reindex", "dangerous"],
  ["PUT /books", "dangerous"],
  ["DELETE /books", "dangerous"],
  ["PUT /books/_doc", "dangerous"],
  ["DELETE /books/_doc", "dangerous"],
  ["PATCH /books/_doc/_search", "dangerous"],
  ["POST /books/_SEARCH", "dangerous"],
  ["POST /books//_search", "dangerous"],
  ["POST //books/_search", "dangerous"],
  ["POST /books/_search//", "dangerous"],
  ["POST /books/../_search", "dangerous"],
  ["POST /books/%2e%2e/_search", "dangerous"],
  ["POST /books/%5Fsearch", "dangerous"],
  ["POST /books\\other/_search", "dangerous"],
  ["POST /books#ignored/_search", "dangerous"],
  ["POST /books/_doc/%5Fsearch", "dangerous"],
  ["POST /<logs-{now/d}>/_search", "dangerous"],
  ["POST /_plugins/_sql", "dangerous"],
  ["POST /books/_search/template/extra", "dangerous"],
  ["GET /books/_doc/_update", "read"],
  ["HEAD /books", "read"],
  ["OPTIONS /books", "read"],
];

for (const [request, expected] of routeCases) {
  test(`Elasticsearch route roles: ${request}`, () => {
    assert.equal(classifyElasticsearchRequestRisk(request), expected);
    assert.equal(classifyElasticsearchSourceRisk(request), expected);
  });
}

test("Elasticsearch source uses the highest request risk and preserves comment parsing", () => {
  assert.equal(classifyElasticsearchSourceRisk("POST /books/_search\n{}\nPOST /books/_doc/_search\n{}"), "write");
  assert.equal(classifyElasticsearchSourceRisk("POST /books/_doc/_search\n{}\nPOST /books/_search"), "write");
  assert.equal(classifyElasticsearchSourceRisk("POST /books/_doc/_search\n{}\nPOST /_scripts/_search"), "dangerous");
  assert.equal(classifyElasticsearchSourceRisk("/* POST /books/_doc/_search\nDELETE /books */\n# POST /_reindex\n// POST /_scripts/_search\nPOST /books/_explain/_doc"), "read");
  assert.equal(classifyElasticsearchRequestRisk("/* comment */ POST /books/_doc/_search\n{}"), "write");
  assert.equal(classifyElasticsearchSourceRisk("SELECT * FROM books\nPOST /books/_doc/_search"), null);
  assert.equal(classifyElasticsearchRequestRisk("SELECT * FROM books"), null);
});

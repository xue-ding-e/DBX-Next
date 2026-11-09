/**
 * Read/write classification for Elasticsearch-compatible REST requests.
 *
 * Mirrors `classify_search_engine_query_risk` in
 * `crates/dbx-sql-core/src/query_execution_sql.rs` so the desktop guards (read-only
 * unlock, production safety) agree with the backend read-only gate instead of
 * treating every `GET`/`POST` request as an unrecognized — and therefore
 * unsafe — statement.
 */

export type ElasticsearchRequestRisk = "read" | "write" | "dangerous";

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
const RISK_ORDER: Record<ElasticsearchRequestRisk, number> = { read: 0, write: 1, dangerous: 2 };

interface ParsedRequestLine {
  method: string;
  segments: string[];
}

function parseRequestLine(line: string): ParsedRequestLine | null {
  const match = line.trim().match(REQUEST_LINE);
  if (!match) return null;
  // The transport adds a leading slash but does not lowercase or decode paths.
  const path = (match[2].split("?", 1)[0] ?? "").replace(/^\//, "").replace(/\/$/, "");
  return { method: match[1].toUpperCase(), segments: path.split("/") };
}

function classifyParsedRequest({ method, segments }: ParsedRequestLine): ElasticsearchRequestRisk {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";

  // Do not infer a safe route after URL normalization or percent decoding.
  // Empty/dot segments and encoded paths need a separate transport-aware review.
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[%\\#]/.test(segment))) return "dangerous";

  // Root resources such as /_scripts/{id} are not index-scoped endpoints.
  const isIndex = (segment: string) => !segment.startsWith("_") || segment === "_all";
  const indexed = segments.length > 1 && isIndex(segments[0]);
  const route = indexed ? segments.slice(1) : segments;
  const endpoint = route[0];
  const document = indexed && route.length === 2;

  if (method === "POST") {
    // Match complete route shapes: an ID named _search is still an ID.
    if (document && ["_doc", "_create", "_update"].includes(endpoint)) return "write";
    if ((indexed && route.length === 1 && endpoint === "_doc") ||
        (route.length === 1 && endpoint === "_bulk")) return "write";
    if (route.length === 1 && ["_search", "_count", "_msearch", "_field_caps", "_rank_eval", "_search_shards"].includes(endpoint)) return "read";
    if (indexed && route.length === 1 && endpoint === "_terms_enum") return "read";
    if (document && endpoint === "_explain") return "read";
    if (route.length === 2 && ((endpoint === "_validate" && route[1] === "query") ||
        (["_search", "_msearch"].includes(endpoint) && route[1] === "template"))) return "read";
    if (!indexed && endpoint === "_sql" && (route.length === 1 ||
        (route.length === 2 && ["translate", "close"].includes(route[1])))) return "read";
    if (!indexed && endpoint === "_search" && route[1] === "scroll" &&
        (route.length === 2 || route.length === 3)) return "read";
    // Legacy typed, feature-flagged slice, and vendor/plugin routes are not
    // interchangeable with these untyped routes. Unknown POSTs fail closed.
    return "dangerous";
  }
  if (method === "PUT" && document && ["_doc", "_create"].includes(endpoint)) return "write";
  if (method === "DELETE" && document && endpoint === "_doc") return "write";
  return "dangerous";
}

/**
 * Classifies a single request: the request line is the first non-comment line,
 * everything after it is the JSON/NDJSON body. Returns null when the text is
 * not a REST request — Elasticsearch also accepts SQL, classified elsewhere.
 */
export function classifyElasticsearchRequestRisk(request: string): ElasticsearchRequestRisk | null {
  const parsed = parseRequestLine(uncommentedLines(request)[0] ?? "");
  return parsed ? classifyParsedRequest(parsed) : null;
}

/**
 * Classifies every request in the editor text and returns the highest risk, so
 * a read request followed by a write is still guarded. Like the backend, the
 * text only counts as REST when its first non-comment line is a request line;
 * anything else is left to the SQL classification.
 */
export function classifyElasticsearchSourceRisk(source: string): ElasticsearchRequestRisk | null {
  const lines = uncommentedLines(source);
  if (!parseRequestLine(lines[0] ?? "")) return null;

  let highest: ElasticsearchRequestRisk = "read";
  for (const line of lines) {
    const parsed = parseRequestLine(line);
    if (!parsed) continue;
    const risk = classifyParsedRequest(parsed);
    if (RISK_ORDER[risk] > RISK_ORDER[highest]) highest = risk;
  }
  return highest;
}

/**
 * Returns each line with its leading comments removed, dropping lines that hold
 * nothing else. Block comments spanning several lines are skipped as a whole so
 * a commented-out request line is never classified.
 */
function uncommentedLines(source: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;

  for (const rawLine of source.split("\n")) {
    let offset = 0;
    while (offset < rawLine.length) {
      if (inBlockComment) {
        const close = rawLine.indexOf("*/", offset);
        if (close < 0) break;
        inBlockComment = false;
        offset = close + 2;
        continue;
      }
      while (offset < rawLine.length && /\s/.test(rawLine[offset] ?? "")) offset += 1;
      if (offset >= rawLine.length) break;
      if (rawLine.startsWith("/*", offset)) {
        inBlockComment = true;
        offset += 2;
        continue;
      }
      if (rawLine[offset] === "#" || rawLine.startsWith("//", offset)) break;
      lines.push(rawLine.slice(offset));
      break;
    }
  }

  return lines;
}

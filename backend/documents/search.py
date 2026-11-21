"""Project-scoped evidence search.

Candidates come from Postgres full-text search (any query term, weighted by section/excerpt)
plus trigram word similarity, so codes such as EX-02 or FND-B match exactly. Only passages of
the caller's project whose source was available at `as_of` are eligible. The optional reranker
reorders the top candidates; if it is unavailable the database ranking is returned.
"""

import re

from sqlalchemy import text

from . import llm
from .parsers import KIND_LABEL

CODE = re.compile(r"\b[A-Z]{1,6}-?[A-Z0-9]{0,4}\d[A-Z0-9]*\b|\b[A-Z]{2,6}-[A-Z0-9]{1,4}\b")

CANDIDATES = text("""
    WITH lexemes AS (
        SELECT array_agg(quote_literal(lexeme)) AS items
        FROM unnest(tsvector_to_array(to_tsvector('english', :q))) AS lexeme
        WHERE lexeme !~ '^[a-z]$'
    ), query AS (
        SELECT CASE WHEN items IS NULL THEN NULL ELSE CAST(array_to_string(items, ' | ') AS tsquery) END AS tsq,
               coalesce(items, '{}') AS items
        FROM lexemes
    )
    SELECT sp.source_id, sp.locator, sp.page, sp.excerpt, sp.kind, sp.section, sp.untrusted,
           CASE s.kind WHEN 'voice_note' THEN 'voice' ELSE s.kind END AS source_kind, s.title AS source_title, s.available_at,
           coalesce(ts_rank(sp.search, query.tsq), 0) AS text_rank,
           -- share of distinct query terms the passage contains
           (SELECT count(*) FROM unnest(query.items) AS item WHERE sp.search @@ CAST(item AS tsquery))::float
               / greatest(cardinality(query.items), 1) AS coverage,
           extensions.word_similarity(:q, sp.excerpt) AS trigram
    FROM sitemate.source_passages sp
    JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
    CROSS JOIN query
    WHERE sp.project_id = :p
      AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
      AND (sp.search @@ query.tsq OR extensions.word_similarity(:q, sp.excerpt) > 0.35
           OR sp.excerpt ILIKE ANY (CAST(:codes AS text[])))
    ORDER BY coverage DESC, text_rank DESC
    LIMIT 80
""")


def search(conn, project_id, query, as_of=None, limit=10, use_rerank=True):
    query = (query or "").strip()
    if not query:
        return {"query": query, "reranked": False, "results": []}
    codes = sorted(set(CODE.findall(query)))
    rows = conn.execute(CANDIDATES, {"p": project_id, "q": query, "cutoff": as_of,
                                     "codes": [f"%{c}%" for c in codes]}).mappings().all()
    scored = []
    for row in rows:
        score = 2.0 * float(row["coverage"]) + float(row["text_rank"]) + 0.5 * float(row["trigram"])
        score += sum(0.3 for code in codes if code.lower() in row["excerpt"].lower())
        if row["kind"] == "metadata" or (row["kind"] == "header" and row["source_kind"] != "email"):
            score *= 0.6
        scored.append((score, row))
    scored.sort(key=lambda pair: (-pair[0], pair[1]["source_id"], pair[1]["locator"]))
    top = scored[:25]
    reranked = False
    if use_rerank and len(top) > 1:
        documents = [f"{KIND_LABEL.get(r['source_kind'], r['source_kind'])} {r['source_id']}, "
                     f"{r['available_at']:%d %B %Y %H:%M} UTC: {r['source_title'] or ''} | {r['section'] or ''} | "
                     f"{r['excerpt']}" for _, r in top]
        try:
            order = llm.rerank(query, documents)
            by_index = {index: score for index, score in order}
            top = sorted(((by_index.get(i, -1.0), row) for i, (_, row) in enumerate(top)),
                         key=lambda pair: -pair[0])
            reranked = True
        except llm.ModelUnavailable:
            pass
    results = []
    for score, row in top[:limit]:
        results.append({
            "source_id": row["source_id"], "locator": row["locator"], "page": row["page"],
            "excerpt": row["excerpt"], "kind": row["kind"], "section": row["section"],
            "untrusted": row["untrusted"], "source_kind": row["source_kind"],
            "source_title": row["source_title"], "available_at": row["available_at"],
            "score": round(score, 4),
            "citation": f"{row['source_id']}" + (f" p.{row['page']}" if row["page"] else "") + f" · {row['locator']}",
        })
    return {"query": query, "as_of": as_of, "reranked": reranked, "results": results}

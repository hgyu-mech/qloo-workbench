"""A complete local search-plan flow consuming the existing Qloo adapter.

All entities and tags below are invented test fixtures. This module performs
local keyword/tag sorting, never Qloo affinity scoring or model inference.
"""
import json
import re
import unicodedata

import qloo_search as search

CATEGORIES = ("movie", "book", "artist")
MOODS = ("calm", "curious", "energetic")
SOURCE = "synthetic-catalog-v1"

# Synthetic titles and IDs, not real works/artists or actual Qloo records.
_CATALOG = (
    ("1", "Orbit Lantern", "movie", ("space", "exploration"), ("calm", "curious")),
    ("2", "Rocket Parade", "movie", ("space", "adventure"), ("energetic",)),
    ("3", "Quiet Circuit", "movie", ("robot", "science"), ("calm", "curious")),
    ("4", "Forest Relay", "movie", ("nature", "adventure"), ("energetic",)),
    ("5", "Atlas of Small Orbits", "book", ("space", "science"), ("curious",)),
    ("6", "The Moss Notebook", "book", ("nature", "exploration"), ("calm",)),
    ("7", "Paper Automaton", "book", ("robot", "adventure"), ("energetic",)),
    ("8", "Soft Satellite Ensemble", "artist", ("space", "ambient"), ("calm",)),
    ("9", "Circuit Sprint Collective", "artist", ("robot", "electronic"), ("energetic",)),
)


def _normalize(value):
    return unicodedata.normalize("NFKC", value).casefold()


def _tokens(query):
    return set(re.findall(r"[^\W_]+", _normalize(query), re.UNICODE))


def _entity_id(number):
    return "00000000-0000-0000-0000-" + number.zfill(12)


def _failure(status):
    return {"status": status, "mode": "SYNTHETIC / NO LIVE",
            "source": "offline-fixture", "catalog": SOURCE, "apiVerified": False,
            "requestAttempted": False, "plan": [], "recommendations": []}


def run_workflow(query, *, category="movie", mood="curious", limit=3,
                 live=False, cost_confirmed=False):
    """Search synthetic records and explain their deterministic local order.

    No separate raw-query field is returned or saved. An exact-title search can
    naturally return that same fixture title. This is a short title/topic search
    input, not a model prompt. Existing search_entities validates
    the input and every projected response before any result is consumed.
    """
    if type(live) is not bool or type(cost_confirmed) is not bool:
        return _failure("INVALID_ARGUMENTS")
    if live:
        result = search.search_entities(query, live=True,
                                         cost_confirmed=cost_confirmed)
        return _failure(result.status)
    if (type(query) is not str or not 1 <= len(query) <= search.MAX_QUERY_CHARS
            or type(category) is not str or category not in CATEGORIES
            or type(mood) is not str or mood not in MOODS
            or type(limit) is not int or not 1 <= limit <= search.MAX_RESULTS):
        return _failure("INVALID_ARGUMENTS")
    terms = _tokens(query)
    ranked = []
    for number, name, kind, tags, moods in _CATALOG:
        if kind != category:
            continue
        words = _tokens(name + " " + " ".join(tags))
        overlap = len(terms & words)
        if overlap:
            ranked.append((overlap, mood in moods, name,
                           _entity_id(number), kind))
    ranked.sort(key=lambda item: (-item[0], -int(item[1]), item[2]))
    selected = ranked[:limit]
    payload = {"results": [{"entity_id": item[3], "name": item[2],
                             "types": ["urn:entity:" + item[4]]}
                            for item in selected]}
    # Only a built-in, memory-only fixture transport enters the adapter here.
    result = search.search_entities(query, take=limit,
                                     transport=search.FixtureTransport(
                                         json.dumps(payload).encode("utf-8")))
    if result.status != "OFFLINE_RESULTS_READY":
        return _failure(result.status)
    ranked_by_id = {item[3]: item for item in selected}
    recommendations = []
    for entity in result.entities:
        local = ranked_by_id[entity.entity_id]
        reasons = [str(local[0]) + " requested keyword(s) match this synthetic title or topic tags."]
        reasons.append("Matches the requested mood in fixture tags." if local[1]
                       else "Keyword match; requested mood tag is absent.")
        recommendations.append({"entity": entity.as_dict(), "reasons": reasons,
                                "source": SOURCE, "synthetic": True,
                                "apiVerified": False,
                                "rankingMethod": "local keyword count, mood tag, title"})
    return {"status": "LOCAL_PLAN_READY" if recommendations else "NO_MATCHES",
            "mode": "SYNTHETIC / NO LIVE", "source": "offline-fixture", "catalog": SOURCE,
            "apiVerified": False, "requestAttempted": False,
            "inputSummary": {"category": category, "mood": mood,
                             "limit": limit, "rawQueryFieldIncluded": False,
                             "querySaved": False},
            "plan": ["Search the chosen category in the synthetic catalog.",
                     "Order by keyword-overlap count, then mood tags and title.",
                     "Review each result's reason and evidence status."],
            "recommendations": recommendations,
            "emptyState": (None if recommendations else
                           "No matching synthetic record. Try space, robot or nature, "
                           "or choose another category. No result was invented."),
            "verification": {"adapterContract": search.CONTRACT,
                             "qlooResponseVerified": False,
                             "qlooAffinityComputed": False,
                             "modelOrAgentExecuted": False},
            "nextRequired": ["Confirm the event's usable free quota and endpoint.",
                             "Verify an authorized live response before integrating real results."]}


def render_text(result):
    """Plain terminal output only. Names never become markup or instructions."""
    lines = ["Qloo local search workbench", result["mode"],
             "API verified: NO | Live requests: 0", "Status: " + result["status"]]
    if "inputSummary" in result:
        summary = result["inputSummary"]
        lines.append("Category: {category} | Mood: {mood} | Limit: {limit}".format(**summary))
    if result["plan"]:
        lines.append("Plan:")
        lines.extend("  " + str(i) + ". " + step for i, step in enumerate(result["plan"], 1))
    for i, item in enumerate(result["recommendations"], 1):
        lines.append(str(i) + ". " + item["entity"]["name"])
        lines.extend("   Why: " + reason for reason in item["reasons"])
        lines.append("   Evidence: " + item["source"] + " | SYNTHETIC | API NOT VERIFIED")
    if result.get("emptyState"):
        lines.append(result["emptyState"])
    lines.append("No real Qloo recommendations, affinity scores or agent performance are claimed.")
    return "\n".join(lines)

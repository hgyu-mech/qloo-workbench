"""Deterministic fixture preview. This is not an actual Qloo response."""
import json

from qloo_search import FixtureTransport, search_entities


def main():
    # Synthetic identifiers/titles used only to exercise the local contract.
    payload = {"results": [
        {"entity_id": "00000000-0000-0000-0000-000000000001",
         "name": "Sample Film One", "types": ["urn:entity:movie"],
         "properties": {"description": "discarded fixture data"}},
        {"entity_id": "00000000-0000-0000-0000-000000000002",
         "name": "샘플 영화 둘", "types": ["urn:entity:movie"]},
    ]}
    result = search_entities("Sample", take=2,
                             transport=FixtureTransport(json.dumps(payload).encode("utf-8")))
    print(json.dumps(result.as_dict(), ensure_ascii=True, indent=2))
    return 0 if result.status == "OFFLINE_RESULTS_READY" else 1


if __name__ == "__main__":
    raise SystemExit(main())

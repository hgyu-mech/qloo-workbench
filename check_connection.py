"""CLI emits only bounded status fields. No key arguments are accepted."""
import json
import sys


def internal_error():
    print(json.dumps({"status": "INTERNAL_ERROR", "credentialReady": False,
                      "requestAttempted": False, "httpStatus": None}))
    return 1


def main(argv=None, checker=None):
    try:
        from qloo_connector import CheckResult, check_connection
    except Exception:
        return internal_error()
    if checker is None:
        checker = check_connection
    args = sys.argv[1:] if argv is None else argv
    allowed = {"--live", "--cost-confirmed"}
    if any(arg not in allowed for arg in args) or len(args) != len(set(args)):
        result = CheckResult("INVALID_ARGUMENTS")
    else:
        result = checker(live="--live" in args,
                         cost_confirmed="--cost-confirmed" in args)
    print(json.dumps(result.as_dict(), ensure_ascii=True))
    return 0 if result.status in {"LOCAL_READY_NETWORK_NOT_RUN", "API_RESPONDED"} else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(internal_error())

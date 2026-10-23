"""Local CLI. No login, credential reads, network or saved user input."""
import argparse
import json
import sys

from qloo_workflow import CATEGORIES, MOODS, _failure, render_text, run_workflow


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default message may echo a private unknown argument.
        raise ValueError("INVALID_ARGUMENTS")


def main(argv=None):
    parser = _Parser(description="Search and explain synthetic records. NO LIVE API.",
                     allow_abbrev=False)
    parser.add_argument("--query", required=True, help="Short topic: space, robot or nature")
    parser.add_argument("--category", choices=CATEGORIES, default="movie")
    parser.add_argument("--mood", choices=MOODS, default="curious")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--json", action="store_true", help="Output a structured local plan")
    parser.add_argument("--agent", action="store_true", help="Run bounded local tool calls; no model or live API")
    parser.add_argument("--live", action="store_true", help="Blocked until live integration is approved")
    parser.add_argument("--cost-confirmed", action="store_true", help="Does not enable live mode")
    try:
        args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    except ValueError:
        print(json.dumps(_failure("INVALID_ARGUMENTS")))
        return 1
    try:
        if args.agent:
            from qloo_agent import run_agent, render_agent_text
            result = run_agent(args.query, category=args.category, mood=args.mood,
                               limit=args.limit, live=args.live,
                               cost_confirmed=args.cost_confirmed)
            print(json.dumps(result, ensure_ascii=True, indent=2) if args.json
                  else render_agent_text(result))
            return 0 if result["status"] in ("AGENT_PLAN_READY", "NO_MATCHES") else 1
        result = run_workflow(args.query, category=args.category, mood=args.mood,
                              limit=args.limit, live=args.live,
                              cost_confirmed=args.cost_confirmed)
        print(json.dumps(result, ensure_ascii=True, indent=2) if args.json
              else render_text(result))
        return 0 if result["status"] in ("LOCAL_PLAN_READY", "NO_MATCHES") else 1
    except Exception:
        # No traceback, raw input or provider/credential exception is printed.
        print(json.dumps(_failure("INTERNAL_ERROR")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

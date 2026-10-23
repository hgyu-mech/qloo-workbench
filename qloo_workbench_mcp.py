"""Qloo Workbench MCP launcher. The default demo needs no key or network."""
import argparse
import json
import sys


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('INVALID_ARGUMENTS')


def main(argv=None):
    parser = _Parser(description='Resolve, confirm and recommend with evidence.', allow_abbrev=False)
    parser.add_argument('--mode', choices=('demo', 'live'), default='demo')
    parser.add_argument('--policy', help='Private, reviewed no-cost access policy; required for live mode')
    try:
        args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    except ValueError:
        print(json.dumps({'status': 'INVALID_ARGUMENTS', 'requestAttempted': False}), file=sys.stderr)
        return 1
    from taste_product import TasteWorkbench, serve_stdio
    from qloo_live_runtime import CanonicalMcpBackend, LiveAccessError
    backend = None
    try:
        if args.mode == 'live':
            if not args.policy:
                raise LiveAccessError('FREE_ACCESS_NOT_VERIFIED')
            backend = CanonicalMcpBackend(args.policy)
            app = TasteWorkbench(backend=backend, data_source='qloo-live', live=True,
                                 live_policy_verified=True, max_backend_calls=4)
        else:
            app = TasteWorkbench()
        try:
            serve_stdio(app)
        finally:
            app.close()
        return 0
    except LiveAccessError:
        print(json.dumps({'status': 'FREE_ACCESS_NOT_VERIFIED', 'data_source': 'qloo-live',
                          'requestAttempted': False, 'credentialRead': False}), file=sys.stderr)
        return 1
    finally:
        if backend is not None:
            backend.close()


if __name__ == '__main__':
    raise SystemExit(main())

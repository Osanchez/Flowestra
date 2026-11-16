import argparse

from .server import make_server


def main(argv=None):
    parser = argparse.ArgumentParser(prog="orders_service")
    parser.add_argument("--port", type=int, default=8080, help="port to listen on, 0 for any free port")
    parser.add_argument("--db", default=":memory:", help="sqlite database path")
    args = parser.parse_args(argv)

    server = make_server(args.port, args.db)
    print("listening on %d" % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.store.close()


if __name__ == "__main__":
    main()

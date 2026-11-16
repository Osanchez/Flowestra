import argparse
import json
import sys

from .client import ApiError, Client


def build_parser():
    parser = argparse.ArgumentParser(prog="orders_client")
    parser.add_argument("--url", required=True, help="base URL of the service")
    parser.add_argument("--timeout", type=float, default=5)
    groups = parser.add_subparsers(dest="group", required=True)

    items = groups.add_parser("items").add_subparsers(dest="action", required=True)
    p = items.add_parser("list")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--limit", type=int, default=20)
    p = items.add_parser("add")
    p.add_argument("sku")
    p.add_argument("name")
    p.add_argument("price", type=int)

    stock = groups.add_parser("stock").add_subparsers(dest="action", required=True)
    p = stock.add_parser("get")
    p.add_argument("id", type=int)
    p = stock.add_parser("set")
    p.add_argument("id", type=int)
    p.add_argument("qty", type=int)

    orders = groups.add_parser("orders").add_subparsers(dest="action", required=True)
    p = orders.add_parser("list")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--limit", type=int, default=20)
    p = orders.add_parser("create")
    p.add_argument("item", type=int)
    p.add_argument("qty", type=int)
    p = orders.add_parser("cancel")
    p.add_argument("id", type=int)
    return parser


def run(client, args):
    key = (args.group, args.action)
    if key == ("items", "list"):
        return client.list_items(offset=args.offset, limit=args.limit)
    if key == ("items", "add"):
        return client.create_item(args.sku, args.name, args.price)
    if key == ("stock", "get"):
        return client.get_stock(args.id)
    if key == ("stock", "set"):
        return client.set_stock(args.id, args.qty)
    if key == ("orders", "list"):
        return client.list_orders(offset=args.offset, limit=args.limit)
    if key == ("orders", "create"):
        return client.create_order(args.item, args.qty)
    if key == ("orders", "cancel"):
        return client.cancel_order(args.id)
    raise SystemExit("unknown command: %s %s" % key)


def main(argv=None):
    args = build_parser().parse_args(argv)
    client = Client(args.url, timeout=args.timeout)
    try:
        result = run(client, args)
    except ApiError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0

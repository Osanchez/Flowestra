"""HTTP layer: routing, JSON encoding and the mapping from errors to responses."""
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import validation
from .errors import BadState, Duplicate, InsufficientStock, NotFound
from .store import Store


class Reply(Exception):
    """A finished response: status plus a dict (sent as JSON) or a str (sent as text)."""

    def __init__(self, status, payload):
        super().__init__(status)
        self.status = status
        self.payload = payload


ROUTES = [
    ("GET", re.compile(r"^/items$"), "list_items"),
    ("POST", re.compile(r"^/items$"), "create_item"),
    ("GET", re.compile(r"^/items/(\d+)$"), "get_item"),
    ("GET", re.compile(r"^/stock/(\d+)$"), "get_stock"),
    ("PUT", re.compile(r"^/stock/(\d+)$"), "set_stock"),
    ("GET", re.compile(r"^/orders$"), "list_orders"),
    ("POST", re.compile(r"^/orders$"), "create_order"),
    ("GET", re.compile(r"^/orders/(\d+)$"), "get_order"),
    ("POST", re.compile(r"^/orders/(\d+)/cancel$"), "cancel_order"),
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "orders-service/1.0"

    # plumbing

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _send(self, status, payload):
        if isinstance(payload, str):
            data = payload.encode("utf-8")
            content_type = "text/plain; charset=utf-8"
        else:
            data = json.dumps(payload).encode("utf-8")
            content_type = "application/json"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _dispatch(self, method):
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        query = parse_qs(parts.query)
        try:
            for route_method, pattern, name in ROUTES:
                match = pattern.match(parts.path)
                if match and route_method == method:
                    args = [int(g) for g in match.groups()]
                    status, payload = getattr(self, "h_" + name)(raw, query, *args)
                    self._send(status, payload)
                    return
            raise Reply(404, "no such route: %s %s" % (method, parts.path))
        except Reply as reply:
            self._send(reply.status, reply.payload)
        except validation.ValidationError as exc:
            self._send(400, {"error": str(exc)})
        except NotFound:
            self._send(404, {"message": "not found"})
        except InsufficientStock:
            self._send(400, {"error": "insufficient stock"})
        except BadState as exc:
            self._send(400, "cannot cancel: %s" % exc)
        except Duplicate as exc:
            self._send(400, {"error": str(exc)})

    @property
    def store(self):
        return self.server.store

    # items

    def h_list_items(self, raw, query):
        offset, limit = validation.page_params(query)
        items, total = self.store.list_items(offset, limit)
        return 200, {"items": items, "total": total}

    def h_create_item(self, raw, query):
        sku, name, price = validation.new_item(validation.parse_body(raw))
        return 201, self.store.create_item(sku, name, price)

    def h_get_item(self, raw, query, item_id):
        return 200, self.store.get_item(item_id)

    # stock

    def h_get_stock(self, raw, query, item_id):
        return 200, self.store.get_stock(item_id)

    def h_set_stock(self, raw, query, item_id):
        qty = validation.stock_update(validation.parse_body(raw))
        return 200, self.store.set_stock(item_id, qty)

    # orders

    def h_list_orders(self, raw, query):
        offset, limit = validation.page_params(query)
        orders, total = self.store.list_orders(offset, limit)
        return 200, {"orders": orders, "total": total}

    def h_create_order(self, raw, query):
        item_id, qty = validation.new_order(validation.parse_body(raw))
        return 201, self.store.create_order(item_id, qty)

    def h_get_order(self, raw, query, order_id):
        return 200, self.store.get_order(order_id)

    def h_cancel_order(self, raw, query, order_id):
        return 200, self.store.cancel_order(order_id)


class OrdersServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store):
        super().__init__(address, Handler)
        self.store = store


def make_server(port=0, db=":memory:", host="127.0.0.1"):
    return OrdersServer((host, port), Store(db))

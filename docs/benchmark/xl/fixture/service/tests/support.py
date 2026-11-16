"""Shared helpers: an in-process server on an ephemeral port and a tiny JSON client."""
import http.client
import json
import threading
import unittest

from orders_service.server import make_server


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.server = make_server(0, ":memory:")
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.store.close()
        self.thread.join(5)

    def call(self, method, path, body=None, raw=None):
        """Return (status, decoded JSON or text, raw text)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            data = raw if raw is not None else (json.dumps(body) if body is not None else None)
            headers = {"Content-Type": "application/json"} if data is not None else {}
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            text = resp.read().decode("utf-8")
        finally:
            conn.close()
        try:
            return resp.status, json.loads(text), text
        except ValueError:
            return resp.status, text, text

    def add_item(self, sku="SKU-1", name="Widget", price_cents=100, stock=None):
        status, item, _ = self.call("POST", "/items", {"sku": sku, "name": name, "price_cents": price_cents})
        self.assertEqual(status, 201)
        if stock is not None:
            self.call("PUT", "/stock/%d" % item["id"], {"qty": stock})
        return item

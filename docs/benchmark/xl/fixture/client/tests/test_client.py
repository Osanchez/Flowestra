import json
import unittest

from orders_client import ApiError, Client
from stub import StubServer


class RequestShape(unittest.TestCase):
    def test_list_items_sends_paging(self):
        with StubServer() as stub:
            Client(stub.url).list_items(offset=40, limit=10)
        request = stub.requests[0]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["path"], "/items?offset=40&limit=10")

    def test_list_defaults(self):
        with StubServer() as stub:
            Client(stub.url).list_orders()
        self.assertEqual(stub.requests[0]["path"], "/orders?offset=0&limit=20")

    def test_create_item_body(self):
        with StubServer(default=(201, {"id": 1})) as stub:
            result = Client(stub.url).create_item("S-1", "Name", 99)
        self.assertEqual(result, {"id": 1})
        self.assertEqual(json.loads(stub.requests[0]["body"]),
                         {"sku": "S-1", "name": "Name", "price_cents": 99})
        self.assertEqual(stub.requests[0]["headers"]["Content-Type"], "application/json")

    def test_stock_calls(self):
        with StubServer(default=(200, {"item_id": 3, "qty": 8})) as stub:
            client = Client(stub.url)
            self.assertEqual(client.get_stock(3), {"item_id": 3, "qty": 8})
            client.set_stock(3, 8)
        self.assertEqual(stub.requests[0]["path"], "/stock/3")
        self.assertEqual((stub.requests[1]["method"], stub.requests[1]["path"]), ("PUT", "/stock/3"))
        self.assertEqual(json.loads(stub.requests[1]["body"]), {"qty": 8})

    def test_order_calls(self):
        with StubServer(default=(200, {"id": 4})) as stub:
            client = Client(stub.url)
            client.create_order(3, 2)
            client.get_order(4)
            client.cancel_order(4)
        self.assertEqual(json.loads(stub.requests[0]["body"]), {"item_id": 3, "qty": 2})
        self.assertEqual([(r["method"], r["path"]) for r in stub.requests[1:]],
                         [("GET", "/orders/4"), ("POST", "/orders/4/cancel")])

    def test_base_url_prefix_and_trailing_slash(self):
        with StubServer() as stub:
            Client(stub.url + "/api/").get_item(1)
        self.assertEqual(stub.requests[0]["path"], "/api/items/1")


class Errors(unittest.TestCase):
    def test_json_error_body_is_raw_text(self):
        with StubServer(default=(404, {"message": "not found"})) as stub:
            with self.assertRaises(ApiError) as ctx:
                Client(stub.url).get_item(9)
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(json.loads(ctx.exception.body), {"message": "not found"})

    def test_plain_text_error_body(self):
        with StubServer(default=(400, "cannot cancel: order is cancelled")) as stub:
            with self.assertRaises(ApiError) as ctx:
                Client(stub.url).cancel_order(1)
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.body, "cannot cancel: order is cancelled")

    def test_any_non_2xx_raises(self):
        for status in (301, 400, 404, 500, 503):
            with StubServer(default=(status, "x")) as stub:
                with self.assertRaises(ApiError, msg=str(status)):
                    Client(stub.url).get_item(1)

    def test_connection_refused_is_not_swallowed(self):
        with StubServer() as stub:
            url = stub.url
        with self.assertRaises(OSError):
            Client(url, timeout=1).get_item(1)

    def test_empty_success_body(self):
        with StubServer(default=(200, "")) as stub:
            self.assertIsNone(Client(stub.url).get_item(1))


if __name__ == "__main__":
    unittest.main()

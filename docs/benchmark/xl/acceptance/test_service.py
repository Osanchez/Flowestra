import os
import tempfile
import unittest
from urllib.parse import quote

import helpers
from helpers import ServiceCase


class Pagination(ServiceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ids = []
        for n in range(45):
            status, body, _ = helpers.http(cls.base, "POST", "/items", {
                "sku": "PG-%03d" % n, "name": "Page item %d" % n, "price_cents": n})
            assert status == 201, body
            cls.ids.append(body["id"])
        helpers.http(cls.base, "PUT", "/stock/%d" % cls.ids[0], {"qty": 1000})
        for _ in range(25):
            status, body, _ = helpers.http(cls.base, "POST", "/orders", {"item_id": cls.ids[0], "qty": 1})
            assert status == 201, body

    def walk(self, path, key, limit):
        seen, cursor, pages = [], None, 0
        while True:
            query = "?limit=%d" % limit + ("&cursor=" + quote(cursor) if cursor else "")
            status, body, _ = self.call("GET", path + query)
            self.assertEqual(status, 200, body)
            self.assertEqual(sorted(body), sorted([key, "next_cursor"]), body)
            seen.extend(r["id"] for r in body[key])
            pages += 1
            cursor = body["next_cursor"]
            if cursor is None:
                return seen, pages
            self.assertIsInstance(cursor, str)
            self.assertLess(pages, 100, "cursor chain does not end")

    def test_default_limit_is_20(self):
        status, body, _ = self.call("GET", "/items")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["items"]), 20)
        self.assertIsInstance(body["next_cursor"], str)
        self.assertEqual([i["id"] for i in body["items"]], self.ids[:20])

    def test_no_offset_or_total(self):
        for path, key in (("/items", "items"), ("/orders", "orders")):
            status, body, _ = self.call("GET", path)
            self.assertEqual(status, 200)
            self.assertNotIn("total", body)
            self.assertIn("next_cursor", body)
            self.assertEqual(sorted(body), sorted([key, "next_cursor"]))

    def test_cursor_chain_covers_all_items_once_in_order(self):
        seen, pages = self.walk("/items", "items", 10)
        self.assertEqual(seen, self.ids)
        self.assertEqual(pages, 5)

    def test_cursor_chain_for_orders(self):
        seen, pages = self.walk("/orders", "orders", 7)
        self.assertEqual(seen, sorted(seen))
        self.assertEqual(len(seen), 25)
        self.assertEqual(len(set(seen)), 25)
        self.assertEqual(pages, 4)

    def test_last_page_has_null_cursor(self):
        status, body, _ = self.call("GET", "/items?limit=100")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["items"]), 45)
        self.assertIsNone(body["next_cursor"])

    def test_invalid_cursor(self):
        for path in ("/items", "/orders"):
            status, body, _ = self.call("GET", path + "?cursor=" + quote("not a cursor!!"))
            self.assertEnvelope(status, body, 400, "invalid_cursor")

    def test_limit_out_of_range_or_not_integer(self):
        for path in ("/items", "/orders"):
            for bad in ("0", "101", "x", "-1", "2.5"):
                status, body, _ = self.call("GET", "%s?limit=%s" % (path, bad))
                self.assertEnvelope(status, body, 400, "validation_error")
        status, body, _ = self.call("GET", "/items?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["items"]), 1)


class Envelope(ServiceCase):
    def test_not_found_for_unknown_ids_and_routes(self):
        for path in ("/items/99999", "/orders/99999", "/nothing/here"):
            status, body, _ = self.call("GET", path)
            self.assertEnvelope(status, body, 404, "not_found")
        status, body, _ = self.call("POST", "/orders/99999/cancel")
        self.assertEnvelope(status, body, 404, "not_found")

    def test_validation_error(self):
        item = self.new_item(stock=5)
        status, body, _ = self.call("POST", "/orders", {})
        self.assertEnvelope(status, body, 400, "validation_error")
        status, body, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 0})
        self.assertEnvelope(status, body, 400, "validation_error")

    def test_insufficient_stock_is_409(self):
        item = self.new_item(stock=1)
        status, body, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 2})
        self.assertEnvelope(status, body, 409, "insufficient_stock")

    def test_invalid_state_is_409(self):
        item = self.new_item(stock=2)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 1})
        status, body, _ = self.call("POST", "/orders/%d/cancel" % order["id"])
        self.assertEqual(status, 200, body)
        status, body, _ = self.call("POST", "/orders/%d/cancel" % order["id"])
        self.assertEnvelope(status, body, 409, "invalid_state")


class Idempotency(ServiceCase):
    def order_count(self):
        count, cursor = 0, None
        while True:
            status, body, _ = self.call("GET", "/orders?limit=100" + ("&cursor=" + quote(cursor) if cursor else ""))
            self.assertEqual(status, 200, body)
            count += len(body["orders"])
            cursor = body.get("next_cursor")
            if not cursor:
                return count

    def test_replay_returns_the_first_response(self):
        item = self.new_item(stock=10)
        before = self.order_count()
        headers = {"Idempotency-Key": "replay-key-1"}
        body = {"item_id": item["id"], "quantity": 3}
        first = self.call("POST", "/orders", body, headers)
        second = self.call("POST", "/orders", dict(body), headers)
        self.assertEqual(first[0], 201, first[1])
        self.assertEqual(second[0], first[0])
        self.assertEqual(second[1], first[1])
        self.assertEqual(self.order_count(), before + 1)
        _, stock, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual(stock["quantity"], 7)

    def test_same_key_different_body_conflicts(self):
        item = self.new_item(stock=10)
        headers = {"Idempotency-Key": "conflict-key-1"}
        status, _, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 1}, headers)
        self.assertEqual(status, 201)
        status, body, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 2}, headers)
        self.assertEnvelope(status, body, 409, "idempotency_conflict")
        _, stock, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual(stock["quantity"], 9)

    def test_without_header_each_request_creates_an_order(self):
        item = self.new_item(stock=10)
        before = self.order_count()
        for _ in range(2):
            status, _, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 1})
            self.assertEqual(status, 201)
        self.assertEqual(self.order_count(), before + 2)

    def test_different_keys_create_different_orders(self):
        item = self.new_item(stock=10)
        body = {"item_id": item["id"], "quantity": 1}
        a = self.call("POST", "/orders", body, {"Idempotency-Key": "diff-a"})
        b = self.call("POST", "/orders", body, {"Idempotency-Key": "diff-b"})
        self.assertEqual((a[0], b[0]), (201, 201))
        self.assertNotEqual(a[1]["id"], b[1]["id"])

    def test_keys_survive_a_restart_on_the_same_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "restart.db")
            first_service = helpers.Service(db)
            try:
                _, item, _ = helpers.http(first_service.url, "POST", "/items",
                                          {"sku": "RS-1", "name": "Restart", "price_cents": 5})
                helpers.http(first_service.url, "PUT", "/stock/%d" % item["id"], {"qty": 5})
                body = {"item_id": item["id"], "quantity": 2}
                headers = {"Idempotency-Key": "restart-key"}
                first = helpers.http(first_service.url, "POST", "/orders", body, headers)
            finally:
                first_service.stop()
            second_service = helpers.Service(db)
            try:
                second = helpers.http(second_service.url, "POST", "/orders", body, headers)
                _, stock, _ = helpers.http(second_service.url, "GET", "/stock/%d" % item["id"])
            finally:
                second_service.stop()
        self.assertEqual(first[0], 201, first[1])
        self.assertEqual((second[0], second[1]), (first[0], first[1]))
        self.assertEqual(stock["quantity"], 3)


class Quantity(ServiceCase):
    def test_stock_uses_quantity(self):
        item = self.new_item()
        status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"quantity": 5})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["quantity"], 5)
        self.assertNotIn("qty", body)
        status, body, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual((body["item_id"], body["quantity"]), (item["id"], 5))
        self.assertNotIn("qty", body)

    def test_orders_use_quantity_everywhere(self):
        item = self.new_item(stock=9)
        status, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 4})
        self.assertEqual(status, 201, order)
        self.assertEqual(order["quantity"], 4)
        self.assertNotIn("qty", order)
        _, fetched, _ = self.call("GET", "/orders/%d" % order["id"])
        self.assertEqual(fetched, order)
        _, page, _ = self.call("GET", "/orders?limit=100")
        listed = [o for o in page["orders"] if o["id"] == order["id"]]
        self.assertEqual(listed, [order])
        _, cancelled, _ = self.call("POST", "/orders/%d/cancel" % order["id"])
        self.assertEqual(cancelled["quantity"], 4)
        self.assertNotIn("qty", cancelled)

    def test_qty_alias_is_still_accepted(self):
        item = self.new_item()
        status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"qty": 6})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["quantity"], 6)
        status, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 2})
        self.assertEqual(status, 201, order)
        self.assertEqual(order["quantity"], 2)
        status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"quantity": 3, "qty": 3})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["quantity"], 3)

    def test_differing_quantity_and_qty_is_rejected(self):
        item = self.new_item(stock=5)
        status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"quantity": 3, "qty": 4})
        self.assertEnvelope(status, body, 400, "validation_error")
        status, body, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 1, "qty": 2})
        self.assertEnvelope(status, body, 400, "validation_error")


class RealResponsesMatchTheContract(ServiceCase):
    def test_every_response_validates(self):
        api = helpers.load_api()
        self.assertEqual(api["version"], "2")
        check = helpers.load_check()
        item = self.new_item(stock=5)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "quantity": 2})
        _, cancelled, _ = self.call("POST", "/orders/%d/cancel" % order["id"])
        checks = [
            ("Item", item),
            ("Item", self.call("GET", "/items/%d" % item["id"])[1]),
            ("Stock", self.call("GET", "/stock/%d" % item["id"])[1]),
            ("Order", order),
            ("Order", cancelled),
            ("ItemPage", self.call("GET", "/items?limit=1")[1]),
            ("OrderPage", self.call("GET", "/orders")[1]),
            ("Error", self.call("GET", "/items/99999")[1]),
            ("Error", self.call("GET", "/items?limit=0")[1]),
        ]
        for name, payload in checks:
            self.assertEqual(check.validate(name, payload), [], (name, payload))


if __name__ == "__main__":
    unittest.main()

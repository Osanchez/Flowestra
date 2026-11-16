from support import ServiceTestCase


class OrderTests(ServiceTestCase):
    def stock_of(self, item_id):
        return self.call("GET", "/stock/%d" % item_id)[1]["qty"]

    def test_create_decrements_stock(self):
        item = self.add_item(stock=10)
        status, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 3})
        self.assertEqual(status, 201)
        self.assertEqual(order, {"id": 1, "item_id": item["id"], "qty": 3, "status": "open"})
        self.assertEqual(self.stock_of(item["id"]), 7)

    def test_get_order(self):
        item = self.add_item(stock=2)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 1})
        status, again, _ = self.call("GET", "/orders/%d" % order["id"])
        self.assertEqual((status, again), (200, order))

    def test_list_orders(self):
        item = self.add_item(stock=10)
        for _ in range(3):
            self.call("POST", "/orders", {"item_id": item["id"], "qty": 1})
        status, body, _ = self.call("GET", "/orders?limit=2")
        self.assertEqual(status, 200)
        self.assertEqual([o["id"] for o in body["orders"]], [1, 2])
        self.assertEqual(body["total"], 3)
        _, body, _ = self.call("GET", "/orders?offset=2")
        self.assertEqual([o["id"] for o in body["orders"]], [3])

    def test_insufficient_stock(self):
        item = self.add_item(stock=1)
        status, body, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 2})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "insufficient stock"})
        self.assertEqual(self.stock_of(item["id"]), 1)
        self.assertEqual(self.call("GET", "/orders")[1]["total"], 0)

    def test_order_for_unknown_item(self):
        status, body, _ = self.call("POST", "/orders", {"item_id": 77, "qty": 1})
        self.assertEqual((status, body), (404, {"message": "not found"}))

    def test_unknown_order(self):
        self.assertEqual(self.call("GET", "/orders/5")[0], 404)
        self.assertEqual(self.call("POST", "/orders/5/cancel")[0], 404)

    def test_validation(self):
        item = self.add_item(stock=5)
        for body in ({}, {"item_id": item["id"]}, {"item_id": item["id"], "qty": 0},
                     {"item_id": "1", "qty": 1}, {"item_id": item["id"], "qty": 1, "note": "x"}):
            status, payload, _ = self.call("POST", "/orders", body)
            self.assertEqual(status, 400, body)
            self.assertIn("error", payload)

    def test_cancel_returns_stock(self):
        item = self.add_item(stock=4)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 4})
        self.assertEqual(self.stock_of(item["id"]), 0)
        status, cancelled, _ = self.call("POST", "/orders/%d/cancel" % order["id"])
        self.assertEqual(status, 200)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.stock_of(item["id"]), 4)

    def test_cancel_twice_is_plain_text_400(self):
        item = self.add_item(stock=1)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 1})
        self.call("POST", "/orders/%d/cancel" % order["id"])
        status, payload, text = self.call("POST", "/orders/%d/cancel" % order["id"])
        self.assertEqual(status, 400)
        self.assertIsInstance(payload, str)
        self.assertEqual(self.stock_of(item["id"]), 1)

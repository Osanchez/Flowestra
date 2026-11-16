from support import ServiceTestCase


class StockTests(ServiceTestCase):
    def test_never_set_is_zero(self):
        item = self.add_item()
        status, body, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual((status, body), (200, {"item_id": item["id"], "qty": 0}))

    def test_set_and_get(self):
        item = self.add_item()
        status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"qty": 12})
        self.assertEqual((status, body), (200, {"item_id": item["id"], "qty": 12}))
        status, body, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual(body["qty"], 12)

    def test_set_overwrites(self):
        item = self.add_item()
        self.call("PUT", "/stock/%d" % item["id"], {"qty": 5})
        self.call("PUT", "/stock/%d" % item["id"], {"qty": 2})
        _, body, _ = self.call("GET", "/stock/%d" % item["id"])
        self.assertEqual(body["qty"], 2)

    def test_unknown_item(self):
        status, body, _ = self.call("GET", "/stock/42")
        self.assertEqual((status, body), (404, {"message": "not found"}))
        status, body, _ = self.call("PUT", "/stock/42", {"qty": 1})
        self.assertEqual((status, body), (404, {"message": "not found"}))

    def test_validation(self):
        item = self.add_item()
        for body in ({}, {"qty": -3}, {"qty": "x"}, {"qty": 1.5}, {"qty": 1, "extra": 1}):
            status, payload, _ = self.call("PUT", "/stock/%d" % item["id"], body)
            self.assertEqual(status, 400, body)
            self.assertIn("error", payload)

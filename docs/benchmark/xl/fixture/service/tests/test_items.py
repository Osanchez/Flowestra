from support import ServiceTestCase


class ItemTests(ServiceTestCase):
    def test_create_and_get(self):
        status, item, _ = self.call("POST", "/items", {"sku": "A-1", "name": "Alpha", "price_cents": 250})
        self.assertEqual(status, 201)
        self.assertEqual(item, {"id": 1, "sku": "A-1", "name": "Alpha", "price_cents": 250})
        status, again, _ = self.call("GET", "/items/1")
        self.assertEqual(status, 200)
        self.assertEqual(again, item)

    def test_list_is_ordered_and_paged(self):
        for n in range(5):
            self.add_item(sku="S-%d" % n)
        status, body, _ = self.call("GET", "/items")
        self.assertEqual(status, 200)
        self.assertEqual([i["id"] for i in body["items"]], [1, 2, 3, 4, 5])
        self.assertEqual(body["total"], 5)
        status, body, _ = self.call("GET", "/items?offset=3&limit=2")
        self.assertEqual([i["id"] for i in body["items"]], [4, 5])
        self.assertEqual(body["total"], 5)

    def test_list_empty(self):
        status, body, _ = self.call("GET", "/items")
        self.assertEqual((status, body), (200, {"items": [], "total": 0}))

    def test_unknown_item_is_404(self):
        status, body, _ = self.call("GET", "/items/99")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"message": "not found"})

    def test_bad_paging_is_400(self):
        for query in ("limit=0", "limit=101", "limit=abc", "offset=-1", "offset=x"):
            status, body, _ = self.call("GET", "/items?" + query)
            self.assertEqual(status, 400, query)
            self.assertIn("error", body)

    def test_validation_errors(self):
        cases = [
            {"sku": "A", "name": "B"},
            {"sku": "", "name": "B", "price_cents": 1},
            {"sku": "A", "name": "B", "price_cents": -1},
            {"sku": "A", "name": "B", "price_cents": "5"},
            {"sku": "A", "name": "B", "price_cents": True},
            {"sku": "A", "name": "B", "price_cents": 1, "color": "red"},
        ]
        for body in cases:
            status, payload, _ = self.call("POST", "/items", body)
            self.assertEqual(status, 400, body)
            self.assertIsInstance(payload["error"], str)

    def test_body_must_be_json_object(self):
        for raw in ("not json", "[1, 2]", ""):
            status, payload, _ = self.call("POST", "/items", raw=raw)
            self.assertEqual(status, 400, raw)
            self.assertIn("error", payload)

    def test_duplicate_sku(self):
        self.add_item(sku="DUP")
        status, payload, _ = self.call("POST", "/items", {"sku": "DUP", "name": "N", "price_cents": 1})
        self.assertEqual(status, 400)
        self.assertEqual(payload, {"error": "sku already exists"})

    def test_unknown_route_is_plain_text_404(self):
        status, payload, text = self.call("GET", "/nothing")
        self.assertEqual(status, 404)
        self.assertIsInstance(payload, str)
        self.assertIn("/nothing", text)

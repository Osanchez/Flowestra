import http.client
import json
from urllib.parse import quote, urlencode, urlsplit


class ApiError(Exception):
    """A non-2xx response. `body` is the raw response text."""

    def __init__(self, status, body):
        super().__init__("HTTP %d: %s" % (status, body))
        self.status = status
        self.body = body


class Client:
    def __init__(self, base_url, timeout=5):
        parts = urlsplit(base_url)
        self._host = parts.hostname
        self._port = parts.port or 80
        self._prefix = parts.path.rstrip("/")
        self.timeout = timeout

    def _request(self, method, path, params=None, body=None):
        target = self._prefix + path
        if params:
            target += "?" + urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection(self._host, self._port, timeout=self.timeout)
        try:
            conn.request(method, target, body=data, headers=headers)
            resp = conn.getresponse()
            text = resp.read().decode("utf-8", "replace")
        finally:
            conn.close()
        if not 200 <= resp.status < 300:
            raise ApiError(resp.status, text)
        return json.loads(text) if text else None

    # items

    def list_items(self, offset=0, limit=20):
        return self._request("GET", "/items", {"offset": offset, "limit": limit})

    def create_item(self, sku, name, price_cents):
        return self._request("POST", "/items", body={"sku": sku, "name": name, "price_cents": price_cents})

    def get_item(self, id):
        return self._request("GET", "/items/%s" % quote(str(id)))

    # stock

    def get_stock(self, item_id):
        return self._request("GET", "/stock/%s" % quote(str(item_id)))

    def set_stock(self, item_id, qty):
        return self._request("PUT", "/stock/%s" % quote(str(item_id)), body={"qty": qty})

    # orders

    def list_orders(self, offset=0, limit=20):
        return self._request("GET", "/orders", {"offset": offset, "limit": limit})

    def create_order(self, item_id, qty):
        return self._request("POST", "/orders", body={"item_id": item_id, "qty": qty})

    def get_order(self, id):
        return self._request("GET", "/orders/%s" % quote(str(id)))

    def cancel_order(self, id):
        return self._request("POST", "/orders/%s/cancel" % quote(str(id)))

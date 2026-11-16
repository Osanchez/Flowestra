"""sqlite3 storage. One connection shared by all request threads, behind a lock."""
import sqlite3
import threading

from .errors import BadState, Duplicate, InsufficientStock, NotFound

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);
CREATE TABLE IF NOT EXISTS stock (
    item_id INTEGER PRIMARY KEY REFERENCES items(id),
    qty INTEGER NOT NULL CHECK (qty >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    qty INTEGER NOT NULL CHECK (qty >= 1),
    status TEXT NOT NULL CHECK (status IN ('open', 'cancelled'))
);
"""


def _item(row):
    return {"id": row["id"], "sku": row["sku"], "name": row["name"], "price_cents": row["price_cents"]}


def _order(row):
    return {"id": row["id"], "item_id": row["item_id"], "qty": row["qty"], "status": row["status"]}


class Store:
    def __init__(self, path=":memory:"):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)

    def close(self):
        with self._lock:
            self._conn.close()

    # items

    def list_items(self, offset, limit):
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM items ORDER BY id LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            total = self._conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        return [_item(r) for r in rows], total

    def create_item(self, sku, name, price_cents):
        with self._lock:
            try:
                with self._conn:
                    cur = self._conn.execute(
                        "INSERT INTO items (sku, name, price_cents) VALUES (?, ?, ?)",
                        (sku, name, price_cents))
            except sqlite3.IntegrityError:
                raise Duplicate("sku already exists")
            row = self._conn.execute("SELECT * FROM items WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _item(row)

    def get_item(self, item_id):
        with self._lock:
            row = self._conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise NotFound("item %d" % item_id)
        return _item(row)

    # stock

    def _require_item(self, item_id):
        if self._conn.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone() is None:
            raise NotFound("item %d" % item_id)

    def _stock_qty(self, item_id):
        row = self._conn.execute("SELECT qty FROM stock WHERE item_id = ?", (item_id,)).fetchone()
        return row["qty"] if row else 0

    def get_stock(self, item_id):
        with self._lock:
            self._require_item(item_id)
            return {"item_id": item_id, "qty": self._stock_qty(item_id)}

    def set_stock(self, item_id, qty):
        with self._lock:
            self._require_item(item_id)
            with self._conn:
                self._conn.execute(
                    "INSERT OR REPLACE INTO stock (item_id, qty) VALUES (?, ?)", (item_id, qty))
        return {"item_id": item_id, "qty": qty}

    # orders

    def list_orders(self, offset, limit):
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM orders ORDER BY id LIMIT ? OFFSET ?", (limit, offset)).fetchall()
            total = self._conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        return [_order(r) for r in rows], total

    def create_order(self, item_id, qty):
        with self._lock:
            self._require_item(item_id)
            available = self._stock_qty(item_id)
            if available < qty:
                raise InsufficientStock("only %d left" % available)
            with self._conn:
                self._conn.execute(
                    "INSERT OR REPLACE INTO stock (item_id, qty) VALUES (?, ?)",
                    (item_id, available - qty))
                cur = self._conn.execute(
                    "INSERT INTO orders (item_id, qty, status) VALUES (?, ?, 'open')", (item_id, qty))
            row = self._conn.execute("SELECT * FROM orders WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _order(row)

    def get_order(self, order_id):
        with self._lock:
            row = self._conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if row is None:
            raise NotFound("order %d" % order_id)
        return _order(row)

    def cancel_order(self, order_id):
        with self._lock:
            row = self._conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if row is None:
                raise NotFound("order %d" % order_id)
            if row["status"] != "open":
                raise BadState("order is %s" % row["status"])
            with self._conn:
                self._conn.execute("UPDATE orders SET status = 'cancelled' WHERE id = ?", (order_id,))
                self._conn.execute(
                    "INSERT OR REPLACE INTO stock (item_id, qty) VALUES (?, ?)",
                    (row["item_id"], self._stock_qty(row["item_id"]) + row["qty"]))
            row = self._conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        return _order(row)

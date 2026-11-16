# orders service

A small HTTP + sqlite3 orders service (package `orders_service`), standard library only.

    python3 -m orders_service --port 0 --db /tmp/orders.db

`--port 0` picks a free port, `--db` defaults to `:memory:`. On start the service
prints exactly `listening on <port>` on stdout (flushed). Other tools start the
service this way and read that line, so keep it stable.

## Endpoints

All bodies are JSON. Shapes are defined in the sibling `contract` repository.

| Method and path | Result |
| --- | --- |
| `GET /items?offset=&limit=` | `{"items": [...], "total": n}`, ordered by id |
| `POST /items` | 201 with the new item |
| `GET /items/{id}` | the item |
| `GET /stock/{item_id}` | `{"item_id", "qty"}`, `qty` is 0 when never set |
| `PUT /stock/{item_id}` | sets the stock, returns it |
| `GET /orders?offset=&limit=` | `{"orders": [...], "total": n}`, ordered by id |
| `POST /orders` | 201 with an open order, decrements stock |
| `GET /orders/{id}` | the order |
| `POST /orders/{id}/cancel` | the order, now cancelled, stock returned |

## Layout

- `orders_service/server.py`: HTTP routing and handlers
- `orders_service/store.py`: sqlite3 access, one connection behind a lock
- `orders_service/validation.py`: request parsing
- `orders_service/errors.py`: store-level exceptions

## Tests

    python3 -m unittest discover -s tests

`tests/test_contract.py` validates real responses with `../contract/check.py`
and is skipped when that folder is not next to this repository.

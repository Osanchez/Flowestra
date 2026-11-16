# orders client

A Python client library and command line tool for the orders service (package
`orders_client`), standard library only.

## Library

    from orders_client import Client, ApiError

    client = Client("http://127.0.0.1:8080", timeout=5)
    item = client.create_item("SKU-1", "Widget", 250)
    client.set_stock(item["id"], 10)
    order = client.create_order(item["id"], 2)
    client.cancel_order(order["id"])
    page = client.list_items(offset=0, limit=20)

Methods return decoded JSON. Any non-2xx response raises `ApiError(status, body)`
where `body` is the raw response text.

## Command line

    python3 -m orders_client --url http://127.0.0.1:8080 items list --limit 5
    python3 -m orders_client --url URL items add SKU NAME PRICE
    python3 -m orders_client --url URL stock get ID
    python3 -m orders_client --url URL stock set ID QTY
    python3 -m orders_client --url URL orders list
    python3 -m orders_client --url URL orders create ITEM QTY
    python3 -m orders_client --url URL orders cancel ID

Output is JSON. On an API error the command prints the error to stderr and exits 1.

## Tests

    python3 -m unittest discover -s tests

`tests/test_integration.py` starts `../service` as a subprocess and is skipped
when that folder is not next to this repository.

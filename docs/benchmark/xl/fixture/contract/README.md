# contract

The API contract of the orders system: `api.json` lists the endpoints and the
payload schemas, `check.py` validates a payload against a schema, and
`examples/` holds one or more example payloads per schema.

## Schema language

A small subset of JSON Schema:

- `type`: one of `object`, `array`, `string`, `integer`, `boolean`, `null`, or a list of those
- `properties`, `required`, `additionalProperties: false` for objects
- `items` for arrays
- `enum`, `minimum`, `maximum`
- `{"schema": "Name"}` refers to another schema in `api.json`

## Usage

    python3 check.py            # validates every examples/<Schema>.<label>.json

From Python:

    import check
    errors = check.validate("Item", payload)   # [] when valid

## Tests

    python3 -m unittest discover -s tests

The service and the client repositories load `check.py` from a sibling
`../contract` folder to validate real traffic.

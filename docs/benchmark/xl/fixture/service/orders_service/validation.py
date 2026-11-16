"""Request parsing and validation. Every failure raises ValidationError(text)."""
import json


class ValidationError(Exception):
    pass


def parse_body(raw):
    if not raw:
        raise ValidationError("request body is required")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ValidationError("body is not valid JSON")
    if not isinstance(body, dict):
        raise ValidationError("body must be a JSON object")
    return body


def _check_fields(body, allowed):
    for key in body:
        if key not in allowed:
            raise ValidationError("unknown field: %s" % key)


def _integer(body, key, minimum):
    if key not in body:
        raise ValidationError("%s is required" % key)
    value = body[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError("%s must be an integer" % key)
    if value < minimum:
        raise ValidationError("%s must be at least %d" % (key, minimum))
    return value


def _string(body, key):
    if key not in body:
        raise ValidationError("%s is required" % key)
    value = body[key]
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("%s must be a non-empty string" % key)
    return value


def new_item(body):
    _check_fields(body, ("sku", "name", "price_cents"))
    return _string(body, "sku"), _string(body, "name"), _integer(body, "price_cents", 0)


def stock_update(body):
    _check_fields(body, ("qty",))
    return _integer(body, "qty", 0)


def new_order(body):
    _check_fields(body, ("item_id", "qty"))
    return _integer(body, "item_id", 1), _integer(body, "qty", 1)


def _query_int(query, key, default, minimum, maximum=None):
    values = query.get(key)
    if not values:
        return default
    try:
        value = int(values[-1])
    except ValueError:
        raise ValidationError("%s must be an integer" % key)
    if value < minimum or (maximum is not None and value > maximum):
        raise ValidationError("%s is out of range" % key)
    return value


def page_params(query):
    """Return (offset, limit) from a parse_qs dict."""
    return _query_int(query, "offset", 0, 0), _query_int(query, "limit", 20, 1, 100)

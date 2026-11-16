"""Validate payloads against the schemas in api.json.

Run as a script it validates every examples/<SchemaName>.<label>.json file
against <SchemaName> and exits non-zero on any error.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def load_api(path=None):
    with open(path or os.path.join(HERE, "api.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _type_name(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    for name in ("object", "array", "string", "integer"):
        if _TYPE_CHECKS[name](value):
            return name
    return type(value).__name__


def _walk(schema, value, path, schemas, errors):
    if "schema" in schema:
        target = schemas.get(schema["schema"])
        if target is None:
            errors.append("%s: unknown schema %r" % (path, schema["schema"]))
            return
        _walk(target, value, path, schemas, errors)
        return

    types = schema.get("type")
    if types is not None:
        if isinstance(types, str):
            types = [types]
        if not any(_TYPE_CHECKS[t](value) for t in types):
            errors.append("%s: expected %s, got %s" % (path, "|".join(types), _type_name(value)))
            return

    if "enum" in schema and value not in schema["enum"]:
        errors.append("%s: %r is not one of %s" % (path, value, schema["enum"]))

    if _TYPE_CHECKS["integer"](value):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append("%s: %d is below the minimum %d" % (path, value, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            errors.append("%s: %d is above the maximum %d" % (path, value, schema["maximum"]))

    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append("%s: missing required property %r" % (path, key))
        for key, sub in value.items():
            if key in properties:
                _walk(properties[key], sub, "%s.%s" % (path, key), schemas, errors)
            elif schema.get("additionalProperties") is False:
                errors.append("%s: unexpected property %r" % (path, key))

    if isinstance(value, list) and "items" in schema:
        for index, element in enumerate(value):
            _walk(schema["items"], element, "%s[%d]" % (path, index), schemas, errors)


def validate(name, payload, api=None):
    """Return a list of error strings for payload against schema `name`."""
    schemas = (api or load_api())["schemas"]
    if name not in schemas:
        return ["unknown schema %r" % name]
    errors = []
    _walk(schemas[name], payload, "$", schemas, errors)
    return errors


def check_examples(directory=None):
    """Validate every example file; returns (checked, error lines)."""
    directory = directory or os.path.join(HERE, "examples")
    api = load_api()
    problems = []
    paths = sorted(glob.glob(os.path.join(directory, "*.json")))
    for path in paths:
        base = os.path.basename(path)
        schema_name = base.split(".")[0]
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except ValueError as exc:
            problems.append("%s: not valid JSON (%s)" % (base, exc))
            continue
        for err in validate(schema_name, payload, api):
            problems.append("%s: %s" % (base, err))
    return len(paths), problems


def main():
    checked, problems = check_examples()
    for line in problems:
        print(line)
    print("%d examples checked, %d errors" % (checked, len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

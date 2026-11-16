"""Exceptions raised by the store; the HTTP layer maps them to responses."""


class StoreError(Exception):
    pass


class NotFound(StoreError):
    pass


class InsufficientStock(StoreError):
    pass


class BadState(StoreError):
    pass


class Duplicate(StoreError):
    pass

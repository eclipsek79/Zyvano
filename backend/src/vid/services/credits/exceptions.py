"""Typed errors for the Zyvano credit economy."""

class ZyvanoCreditError(Exception):
    """Base class for credit-economy errors."""

class InsufficientCreditsError(ZyvanoCreditError):
    def __init__(self, required: int, available: int):
        self.required = required
        self.available = available
        super().__init__(f"Insufficient credits: required={required}, available={available}")

class DuplicateReservationError(ZyvanoCreditError):
    def __init__(self, idempotency_key: str):
        self.idempotency_key = idempotency_key
        super().__init__(f"Idempotency key already used with different parameters: {idempotency_key!r}")

class InvalidReservationStateError(ZyvanoCreditError):
    def __init__(self, reservation_id: str, current_status: str, action: str):
        self.reservation_id = reservation_id
        self.current_status = current_status
        self.action = action
        super().__init__(f"Cannot {action} reservation {reservation_id!r} in status {current_status!r}")

class PlanEntitlementError(ZyvanoCreditError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)

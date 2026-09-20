"""FastAPI credit and payment-method routes using the canonical Zyvano schema."""
from __future__ import annotations
from decimal import Decimal
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from vid.auth.dependencies import get_current_user
from vid.db.models import User
from vid.db.session import get_db
from vid.db.credit_models import Plan, UserPlan, CreditLedgerEntry, PaymentMethod
from .config import PRICING_CONFIG
from .entitlements import EntitlementChecker
from .exceptions import InsufficientCreditsError
from .ledger import CreditLedger
from .pricing import PricingEngine
from .reservation import ReservationService
from .schemas import CostEstimateResponse, EntitlementBlockedResponse, InsufficientCreditsResponse

router = APIRouter(prefix="/credits", tags=["credits"])

class VideoGenerationRequest(BaseModel):
    duration_seconds: Decimal
    resolution: str
    model: str = "standard"
    quality: str = "standard"
    is_desktop_device: bool = False
    provider_supports_resolution: bool = True

def _user_id(user: User) -> str:
    return str(user.id)

def _get_user_plan_or_404(user_id: str, session: Session) -> Plan:
    user_plan = session.query(UserPlan).filter(UserPlan.user_id == user_id).first()
    plan = user_plan.plan if user_plan else None
    if plan is None:
        raise HTTPException(status_code=404, detail="No plan assigned")
    return plan

def _entitlement_response_or_raise(entitlement) -> None:
    if not entitlement.available:
        raise HTTPException(status_code=403, detail=EntitlementBlockedResponse(
            error=entitlement.reason.value,
            detail=entitlement.detail,
            upgrade_path_applicable=entitlement.upgrade_path_applicable,
        ).model_dump())

@router.get("/payment-methods")
def get_payment_methods():
    """Return checkout methods supported by Zyvano's payment abstraction.

    This endpoint advertises Google Pay without pretending that a transaction
    succeeded. A provider adapter must create/confirm the payment before
    credits are granted.
    """
    return {
        "methods": [
            {"id": PaymentMethod.MPESA.value, "label": "M-Pesa", "enabled": True},
            {"id": PaymentMethod.CARD.value, "label": "Visa / Mastercard", "enabled": True},
            {"id": PaymentMethod.GOOGLE_PAY.value, "label": "Google Pay", "enabled": True},
            {"id": PaymentMethod.APPLE_PAY.value, "label": "Apple Pay", "enabled": True},
            {"id": PaymentMethod.PAYPAL.value, "label": "PayPal", "enabled": True},
            {"id": PaymentMethod.BANK_TRANSFER.value, "label": "Bank transfer", "enabled": True},
        ]
    }

@router.get("/balance")
def get_balance(user: User = Depends(get_current_user), session: Session = Depends(get_db)):
    return {"balance": CreditLedger(session, PRICING_CONFIG).get_balance(_user_id(user))}

@router.get("/transactions")
def get_transaction_history(limit: int = 50, user: User = Depends(get_current_user), session: Session = Depends(get_db)):
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    rows = session.query(CreditLedgerEntry).filter(
        CreditLedgerEntry.user_id == _user_id(user)
    ).order_by(CreditLedgerEntry.created_at.desc()).limit(limit).all()
    return [{"id": str(r.id), "type": r.entry_type.value, "amount": r.amount,
             "reason": r.reason, "createdAt": r.created_at.isoformat()} for r in rows]

@router.get("/entitlements")
def get_resolution_entitlements(
    is_desktop_device: bool = False,
    provider_supported_resolutions: Optional[str] = None,
    user: User = Depends(get_current_user), session: Session = Depends(get_db),
):
    plan = _get_user_plan_or_404(_user_id(user), session)
    checker = EntitlementChecker(PRICING_CONFIG)
    supported = set(provider_supported_resolutions.split(",")) if provider_supported_resolutions is not None else None
    results = {}
    for resolution in PRICING_CONFIG.resolution_multipliers:
        entitlement = checker.check_resolution(
            resolution=resolution, plan=plan, is_desktop_device=is_desktop_device,
            provider_supports_resolution=(supported is None or resolution in supported),
        )
        results[resolution] = {"available": True} if entitlement.available else {
            "available": False, "error": entitlement.reason.value,
            "detail": entitlement.detail, "upgradePathApplicable": entitlement.upgrade_path_applicable,
        }
    return results

@router.post("/video/estimate", response_model=CostEstimateResponse)
def estimate_video_cost(req: VideoGenerationRequest, user: User = Depends(get_current_user), session: Session = Depends(get_db)):
    breakdown = PricingEngine(PRICING_CONFIG).video_generation_cost(
        duration_seconds=req.duration_seconds, resolution=req.resolution,
        model=req.model, quality=req.quality,
    )
    balance = CreditLedger(session, PRICING_CONFIG).get_balance(_user_id(user))
    return CostEstimateResponse.build(breakdown.total_credits, balance, breakdown.line_items)

@router.post("/video/generate")
def start_video_generation(
    req: VideoGenerationRequest, idempotency_key: str,
    user: User = Depends(get_current_user), session: Session = Depends(get_db),
):
    user_id = _user_id(user)
    plan = _get_user_plan_or_404(user_id, session)
    entitlement = EntitlementChecker(PRICING_CONFIG).check_resolution(
        resolution=req.resolution, plan=plan, is_desktop_device=req.is_desktop_device,
        provider_supports_resolution=req.provider_supports_resolution,
    )
    _entitlement_response_or_raise(entitlement)
    breakdown = PricingEngine(PRICING_CONFIG).video_generation_cost(
        duration_seconds=req.duration_seconds, resolution=req.resolution,
        model=req.model, quality=req.quality,
    )
    try:
        entry = ReservationService(session, PRICING_CONFIG).reserve(
            user_id=user_id, amount=breakdown.total_credits,
            reason=f"video_generation:{req.resolution}:{req.duration_seconds}s",
            idempotency_key=idempotency_key,
        )
    except InsufficientCreditsError as e:
        session.rollback()
        raise HTTPException(status_code=402, detail=InsufficientCreditsResponse(
            required=e.required, available=e.available).model_dump())
    session.commit()
    return {"reservation_id": str(entry.id), "charged_credits": breakdown.total_credits}

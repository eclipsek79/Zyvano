"""Plan/device/provider entitlement checks using canonical Plan rows."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from vid.db.credit_models import Plan
from .config import PricingConfig

class UnavailabilityReason(str,Enum):
    PREMIUM_REQUIRED="premium_required"; DEVICE_UNSUPPORTED="device_unsupported"
    PROVIDER_UNSUPPORTED="provider_unsupported"; TEMPORARILY_UNAVAILABLE="temporarily_unavailable"

@dataclass(frozen=True)
class EntitlementResult:
    available: bool
    reason: UnavailabilityReason|None=None
    detail: str=""
    @property
    def upgrade_path_applicable(self)->bool:
        return self.reason is UnavailabilityReason.PREMIUM_REQUIRED

class EntitlementChecker:
    def __init__(self,config:PricingConfig): self.config=config
    def check_resolution(self,resolution:str,plan:Plan,is_desktop_device:bool,
                          provider_supports_resolution:bool,provider_temporarily_available:bool=True)->EntitlementResult:
        if resolution in self.config.premium_only_resolutions and not self._plan_allows(plan,resolution):
            return EntitlementResult(False,UnavailabilityReason.PREMIUM_REQUIRED,f"{resolution} requires a plan entitlement this account does not have.")
        if resolution in self.config.desktop_only_resolutions and not is_desktop_device:
            return EntitlementResult(False,UnavailabilityReason.DEVICE_UNSUPPORTED,f"{resolution} requires a compatible desktop/PC device.")
        if not provider_supports_resolution:
            return EntitlementResult(False,UnavailabilityReason.PROVIDER_UNSUPPORTED,f"No connected provider currently renders {resolution}.")
        if not provider_temporarily_available:
            return EntitlementResult(False,UnavailabilityReason.TEMPORARILY_UNAVAILABLE,"The rendering service for this resolution is temporarily unavailable.")
        return EntitlementResult(True)
    def _plan_allows(self,plan:Plan,resolution:str)->bool:
        ordered=list(self.config.resolution_multipliers)
        try: return ordered.index(resolution)<=ordered.index(plan.max_resolution)
        except ValueError: return False

"""Single application-level pricing configuration.

No database models live here. Resolution and plan limits mirror the canonical
database constraints in public.plans; this module is the economic calculation
catalog used by the services.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum

class RoundingRule(str, Enum):
    HALF_UP = "half_up"
    CEILING = "ceiling"
    FLOOR = "floor"

def apply_rounding(value: Decimal, rule: RoundingRule) -> int:
    if rule is RoundingRule.HALF_UP:
        return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if rule is RoundingRule.CEILING:
        return int(value.to_integral_value(rounding="ROUND_CEILING"))
    if rule is RoundingRule.FLOOR:
        return int(value.to_integral_value(rounding="ROUND_FLOOR"))
    raise ValueError(f"Unknown rounding rule: {rule!r}")

class Resolution(str, Enum):
    P480="480p"; P720="720p"; P1080="1080p"; K2="2k"; K4="4k"; K8="8k"; K12="12k"; K16="16k"; K24="24k"

class ModelTier(str, Enum):
    STANDARD="standard"; HIGH_QUALITY="high_quality"; PREMIUM_MODEL="premium_model"

class QualityTier(str, Enum):
    STANDARD="standard"; HIGH_QUALITY="high_quality"; MAXIMUM_QUALITY="maximum_quality"

class Tier(str, Enum):
    LOW="low"; MID="mid"; HIGH="high"

@dataclass(frozen=True)
class CostRange:
    low: int
    high: int
    default: Tier = Tier.LOW
    def for_tier(self, tier: Tier | None = None) -> int:
        tier = tier or self.default
        if tier is Tier.LOW: return self.low
        if tier is Tier.HIGH: return self.high
        return self.low + (self.high - self.low + 1) // 2

@dataclass
class PricingConfig:
    rounding_rule: RoundingRule = RoundingRule.HALF_UP
    free_plan_initial_grant: int = 500
    image_costs: dict[str,int] = field(default_factory=lambda: {"standard":5,"high_quality":10,"advanced":15})
    image_editing_cost: CostRange = field(default_factory=lambda: CostRange(5,15))
    video_base_rate_480p_per_second: Decimal = Decimal("4")
    resolution_multipliers: dict[str,Decimal] = field(default_factory=lambda: {
        "480p":Decimal("1.0"), "720p":Decimal("1.5"), "1080p":Decimal("2.0"),
        "2k":Decimal("2.75"), "4k":Decimal("4.0"), "8k":Decimal("7.0"),
        "12k":Decimal("10.0"), "16k":Decimal("14.0"), "24k":Decimal("20.0"),
    })
    model_multipliers: dict[str,Decimal] = field(default_factory=lambda: {
        "standard":Decimal("1.0"), "high_quality":Decimal("1.5"), "premium_model":Decimal("2.0")
    })
    quality_multipliers: dict[str,Decimal] = field(default_factory=lambda: {
        "standard":Decimal("1.0"), "high_quality":Decimal("1.25"), "maximum_quality":Decimal("1.5")
    })
    video_editing_costs: dict[str,CostRange] = field(default_factory=lambda: {
        "simple_trim_cut":CostRange(2,2), "basic_edit":CostRange(5,5),
        "advanced_ai_edit":CostRange(10,25),
        "ai_object_background_modification":CostRange(10,30),
        "major_ai_transformation":CostRange(20,50),
    })
    avatar_costs: dict[str,int] = field(default_factory=lambda: {
        "avatar_image_creation":10, "avatar_animation":20, "short_talking_avatar":25
    })
    voice_credits_per_30_seconds: int = 1
    voice_minimum_charge: int = 1
    voice_premium_multipliers: dict[str,Decimal] = field(default_factory=lambda: {
        "standard":Decimal("1.0"), "high_quality":Decimal("1.5"), "premium_model":Decimal("2.0")
    })
    music_costs: dict[str,CostRange] = field(default_factory=lambda: {
        "short":CostRange(5,5), "standard":CostRange(8,8), "extended_high_quality":CostRange(10,20)
    })
    sfx_costs: dict[str,CostRange] = field(default_factory=lambda: {
        "single":CostRange(2,2), "multiple_complex":CostRange(5,10)
    })
    export_costs: dict[str,CostRange] = field(default_factory=lambda: {
        "standard":CostRange(0,5), "high_resolution_server_render":CostRange(5,25),
        "very_high_resolution_render":CostRange(25,100)
    })
    premium_only_resolutions: tuple[str,...] = ("4k","8k","12k","16k","24k")
    desktop_only_resolutions: tuple[str,...] = ("24k",)
    def to_dict(self) -> dict: return asdict(self)
    @classmethod
    def from_dict(cls, data: dict) -> "PricingConfig":
        base = cls()
        for k,v in data.items():
            if hasattr(base,k): setattr(base,k,v)
        return base

PRICING_CONFIG = PricingConfig()

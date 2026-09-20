"""Pure credit pricing engine adapted from Claude's implementation.

This module performs no database I/O. The same engine is used for estimates
and charging so cost calculation cannot diverge between API and worker paths.
"""
from __future__ import annotations
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING
from typing import Optional
from .config import CostRange, PricingConfig, Tier, apply_rounding

@dataclass(frozen=True)
class CostBreakdown:
    total_credits: int
    line_items: dict[str,str]

class PricingEngine:
    def __init__(self, config: PricingConfig):
        self.config = config

    def image_generation_cost(self, tier: str) -> CostBreakdown:
        try: cost = self.config.image_costs[tier]
        except KeyError: raise ValueError(f"Unknown image tier: {tier!r}")
        return CostBreakdown(cost, {"tier": tier})

    def image_editing_cost(self, tier: Tier = Tier.LOW) -> CostBreakdown:
        return CostBreakdown(self.config.image_editing_cost.for_tier(tier), {"editing_tier": tier.value})

    def video_generation_cost(self, duration_seconds: Decimal|int, resolution: str, model: str, quality: str="standard") -> CostBreakdown:
        duration=Decimal(duration_seconds)
        if duration <= 0: raise ValueError("duration_seconds must be positive")
        try: rm=self.config.resolution_multipliers[resolution]
        except KeyError: raise ValueError(f"Unknown resolution: {resolution!r}")
        try: mm=self.config.model_multipliers[model]
        except KeyError: raise ValueError(f"Unknown model tier: {model!r}")
        try: qm=self.config.quality_multipliers[quality]
        except KeyError: raise ValueError(f"Unknown quality tier: {quality!r}")
        raw=duration*self.config.video_base_rate_480p_per_second*rm*mm*qm
        return CostBreakdown(apply_rounding(raw,self.config.rounding_rule), {
            "duration_seconds":str(duration),
            "base_rate_480p_per_second":str(self.config.video_base_rate_480p_per_second),
            "resolution_multiplier":f"{rm}x","model_multiplier":f"{mm}x","quality_multiplier":f"{qm}x",
        })

    def video_editing_cost(self, operation: str, tier: Tier=Tier.LOW) -> CostBreakdown:
        try: r=self.config.video_editing_costs[operation]
        except KeyError: raise ValueError(f"Unknown video editing operation: {operation!r}")
        return CostBreakdown(r.for_tier(tier), {"operation":operation,"tier":tier.value})

    def avatar_cost(self, operation: str) -> CostBreakdown:
        try: cost=self.config.avatar_costs[operation]
        except KeyError: raise ValueError(f"Unknown flat-rate avatar operation: {operation!r}")
        return CostBreakdown(cost, {"operation":operation})

    def voice_cost(self, duration_seconds: Decimal|int, model: str="standard") -> CostBreakdown:
        duration=Decimal(duration_seconds)
        if duration <= 0: raise ValueError("duration_seconds must be positive")
        try: multiplier=self.config.voice_premium_multipliers[model]
        except KeyError: raise ValueError(f"Unknown voice model tier: {model!r}")
        units=(duration/Decimal(30)).quantize(Decimal("1"),rounding=ROUND_CEILING)
        raw=units*Decimal(self.config.voice_credits_per_30_seconds)*multiplier
        total=max(apply_rounding(raw,self.config.rounding_rule),self.config.voice_minimum_charge)
        return CostBreakdown(total, {"duration_seconds":str(duration),"billed_30s_units":str(units),"model_multiplier":f"{multiplier}x"})

    def music_cost(self, tier: str, cost_tier: Tier=Tier.LOW) -> CostBreakdown:
        try: r=self.config.music_costs[tier]
        except KeyError: raise ValueError(f"Unknown music tier: {tier!r}")
        return CostBreakdown(r.for_tier(cost_tier), {"tier":tier,"cost_tier":cost_tier.value})

    def sfx_cost(self, kind: str, cost_tier: Tier=Tier.LOW) -> CostBreakdown:
        try: r=self.config.sfx_costs[kind]
        except KeyError: raise ValueError(f"Unknown SFX kind: {kind!r}")
        return CostBreakdown(r.for_tier(cost_tier), {"kind":kind,"cost_tier":cost_tier.value})

    def export_cost(self, export_kind: str, cost_tier: Tier=Tier.LOW) -> CostBreakdown:
        try: r=self.config.export_costs[export_kind]
        except KeyError: raise ValueError(f"Unknown export kind: {export_kind!r}")
        return CostBreakdown(r.for_tier(cost_tier), {"export_kind":export_kind,"cost_tier":cost_tier.value})

    def long_form_video_cost(self, scenes: list[dict], voice_seconds: Decimal|int=0, voice_model: str="standard",
                             music_tier: Optional[str]=None, sfx_count: int=0,
                             export_kind: Optional[str]=None) -> CostBreakdown:
        total=0
        items={"scene_count":str(len(scenes))}
        for i,scene in enumerate(scenes):
            b=self.video_generation_cost(scene["duration_seconds"],scene["resolution"],scene.get("model","standard"),scene.get("quality","standard"))
            total+=b.total_credits; items[f"scene_{i}_cost"]=str(b.total_credits)
        if voice_seconds:
            b=self.voice_cost(voice_seconds,voice_model); total+=b.total_credits; items["voice_cost"]=str(b.total_credits)
        if music_tier:
            b=self.music_cost(music_tier); total+=b.total_credits; items["music_cost"]=str(b.total_credits)
        if sfx_count:
            b=self.sfx_cost("single" if sfx_count==1 else "multiple_complex"); total+=b.total_credits; items["sfx_cost"]=str(b.total_credits)
        if export_kind:
            b=self.export_cost(export_kind); total+=b.total_credits; items["export_cost"]=str(b.total_credits)
        return CostBreakdown(total,items)

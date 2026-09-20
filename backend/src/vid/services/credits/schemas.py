"""Pydantic response contracts for credit UI/API surfaces."""
from pydantic import BaseModel
class CostEstimateResponse(BaseModel):
    estimated_cost:int; current_balance:int; remaining_after:int; line_items:dict[str,str]
    @classmethod
    def build(cls,estimated_cost:int,current_balance:int,line_items:dict[str,str]):
        return cls(estimated_cost=estimated_cost,current_balance=current_balance,
                   remaining_after=current_balance-estimated_cost,line_items=line_items)
class InsufficientCreditsResponse(BaseModel):
    error:str="insufficient_credits"; required:int; available:int
class EntitlementBlockedResponse(BaseModel):
    error:str; detail:str; upgrade_path_applicable:bool

"""Append-only credit ledger service.

All balance mutations operate exclusively on vid.db.credit_models. No ORM
classes are declared here.
"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from vid.db.credit_models import CreditLedgerEntry, LedgerEntryType, Plan, PlanCode, UserCreditBalance, UserPlan
from .config import PricingConfig
from .exceptions import InsufficientCreditsError

class CreditLedger:
    def __init__(self, session: Session, config: PricingConfig):
        self.session=session; self.config=config

    def get_balance(self,user_id:str)->int:
        row=self.session.get(UserCreditBalance,user_id)
        return row.balance if row else 0

    def _lock_or_create_balance_row(self,user_id:str)->UserCreditBalance:
        row=self.session.execute(
            select(UserCreditBalance).where(UserCreditBalance.user_id==user_id).with_for_update()
        ).scalar_one_or_none()
        if row is None:
            row=UserCreditBalance(user_id=user_id,balance=0)
            self.session.add(row); self.session.flush()
        return row

    def grant_free_plan_signup_bonus(self,user_id:str)->CreditLedgerEntry:
        key=f"free_plan_grant:{user_id}"
        existing=self._find(user_id,key)
        if existing: return existing
        self._ensure_plan_assignment(user_id,PlanCode.FREE)
        return self._credit(user_id,self.config.free_plan_initial_grant,LedgerEntryType.FREE_PLAN_GRANT,"Free plan signup bonus",key)

    def grant_promotional_credits(self,user_id:str,amount:int,reason:str,idempotency_key:str)->CreditLedgerEntry:
        if amount<=0: raise ValueError("Promotional grant amount must be positive")
        return self._credit(user_id,amount,LedgerEntryType.PROMOTIONAL_GRANT,reason,idempotency_key)

    def record_purchase(self,user_id:str,amount:int,reason:str,idempotency_key:str)->CreditLedgerEntry:
        if amount<=0: raise ValueError("Purchase amount must be positive")
        return self._credit(user_id,amount,LedgerEntryType.PURCHASE,reason,idempotency_key)

    def apply_admin_adjustment(self,user_id:str,amount:int,reason:str,idempotency_key:str)->CreditLedgerEntry:
        if amount==0: raise ValueError("Admin adjustment amount must be non-zero")
        if amount>0: return self._credit(user_id,amount,LedgerEntryType.ADMIN_ADJUSTMENT,reason,idempotency_key)
        return self._debit(user_id,-amount,LedgerEntryType.ADMIN_ADJUSTMENT,reason,idempotency_key)

    def expire_credits(self,user_id:str,amount:int,reason:str,idempotency_key:str)->CreditLedgerEntry:
        if amount<=0: raise ValueError("Expiration amount must be positive")
        return self._debit(user_id,amount,LedgerEntryType.EXPIRATION,reason,idempotency_key)

    def _find(self,user_id:str,key:str):
        return self.session.execute(select(CreditLedgerEntry).where(
            CreditLedgerEntry.user_id==user_id,CreditLedgerEntry.idempotency_key==key
        )).scalar_one_or_none()

    def _credit(self,user_id:str,amount:int,entry_type:LedgerEntryType,reason:str,key:str)->CreditLedgerEntry:
        existing=self._find(user_id,key)
        if existing: return existing
        row=self._lock_or_create_balance_row(user_id)
        entry=CreditLedgerEntry(user_id=user_id,entry_type=entry_type,amount=amount,reason=reason,idempotency_key=key)
        self.session.add(entry); row.balance+=amount
        return self._flush_or_existing(user_id,key,entry)

    def _debit(self,user_id:str,amount:int,entry_type:LedgerEntryType,reason:str,key:str)->CreditLedgerEntry:
        existing=self._find(user_id,key)
        if existing: return existing
        row=self._lock_or_create_balance_row(user_id)
        if row.balance<amount: raise InsufficientCreditsError(amount,row.balance)
        entry=CreditLedgerEntry(user_id=user_id,entry_type=entry_type,amount=-amount,reason=reason,idempotency_key=key)
        self.session.add(entry); row.balance-=amount
        return self._flush_or_existing(user_id,key,entry)

    def _flush_or_existing(self,user_id:str,key:str,entry:CreditLedgerEntry)->CreditLedgerEntry:
        try:
            self.session.flush()
        except IntegrityError:
            self.session.rollback()
            winner=self._find(user_id,key)
            if winner is not None: return winner
            raise
        return entry

    def _ensure_plan_assignment(self,user_id:str,plan_code:PlanCode)->None:
        existing=self.session.execute(select(UserPlan).where(UserPlan.user_id==user_id)).scalar_one_or_none()
        if existing: return
        plan=self.session.execute(select(Plan).where(Plan.code==plan_code)).scalar_one_or_none()
        if plan is None: raise RuntimeError(f"Plan {plan_code!r} is not seeded")
        self.session.add(UserPlan(user_id=user_id,plan_id=plan.id))
        self.session.flush()

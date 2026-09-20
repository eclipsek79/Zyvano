"""Reserve/finalize/release state machine for generation credit charges."""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from vid.db.credit_models import CreditLedgerEntry, LedgerEntryType, ReservationStatus
from .config import PricingConfig
from .exceptions import DuplicateReservationError, InsufficientCreditsError, InvalidReservationStateError
from .ledger import CreditLedger

class ReservationService:
    def __init__(self,session:Session,config:PricingConfig):
        self.session=session; self.config=config; self.ledger=CreditLedger(session,config)

    def reserve(self,user_id:str,amount:int,reason:str,idempotency_key:str,job_id:str|None=None)->CreditLedgerEntry:
        if amount<=0: raise ValueError("Reservation amount must be positive")
        existing=self._find(user_id,idempotency_key)
        if existing is not None:
            if existing.entry_type is not LedgerEntryType.RESERVE or existing.amount != -amount:
                raise DuplicateReservationError(idempotency_key)
            return existing
        balance=self.ledger._lock_or_create_balance_row(user_id)
        if balance.balance<amount: raise InsufficientCreditsError(amount,balance.balance)
        entry=CreditLedgerEntry(user_id=user_id,entry_type=LedgerEntryType.RESERVE,amount=-amount,
                                reason=reason,status=ReservationStatus.PENDING,job_id=job_id,idempotency_key=idempotency_key)
        self.session.add(entry); balance.balance-=amount
        try:
            self.session.flush()
        except IntegrityError:
            self.session.rollback()
            winner=self._find(user_id,idempotency_key)
            if winner is not None: return winner
            raise
        return entry

    def finalize(self,reservation_id:str)->CreditLedgerEntry:
        entry=self._pending(reservation_id,"finalize")
        entry.status=ReservationStatus.FINALIZED; self.session.flush(); return entry

    def release(self,reservation_id:str,reason:str)->CreditLedgerEntry:
        entry=self._pending(reservation_id,"release")
        key=f"release:{entry.id}"
        existing=self._find(str(entry.user_id),key)
        if existing is not None: return existing
        amount=-entry.amount
        balance=self.ledger._lock_or_create_balance_row(str(entry.user_id))
        refund=CreditLedgerEntry(user_id=entry.user_id,entry_type=LedgerEntryType.RELEASE,amount=amount,
                                 reason=reason,job_id=entry.job_id,related_entry_id=entry.id,idempotency_key=key)
        self.session.add(refund); balance.balance+=amount; entry.status=ReservationStatus.RELEASED
        self.session.flush(); return refund

    def partial_refund(self,reservation_id:str,refund_amount:int,reason:str)->CreditLedgerEntry:
        entry=self._get(reservation_id)
        if entry.status not in (ReservationStatus.PENDING,ReservationStatus.PARTIALLY_REFUNDED):
            raise InvalidReservationStateError(reservation_id,str(entry.status),"partial_refund")
        if refund_amount<=0: raise ValueError("Refund amount must be positive")
        reserved=-entry.amount
        already=self._sum_refunds(entry.id)
        if already+refund_amount>reserved:
            raise ValueError(f"Refund of {refund_amount} would exceed reserved amount ({reserved}); already refunded {already}")
        key=f"refund:{entry.id}:{already+refund_amount}"
        existing=self._find(str(entry.user_id),key)
        if existing is not None: return existing
        balance=self.ledger._lock_or_create_balance_row(str(entry.user_id))
        refund=CreditLedgerEntry(user_id=entry.user_id,entry_type=LedgerEntryType.REFUND,amount=refund_amount,
                                 reason=reason,job_id=entry.job_id,related_entry_id=entry.id,idempotency_key=key)
        self.session.add(refund); balance.balance+=refund_amount
        entry.status=ReservationStatus.PARTIALLY_REFUNDED if already+refund_amount<reserved else ReservationStatus.RELEASED
        self.session.flush(); return refund

    def _find(self,user_id:str,key:str):
        return self.session.execute(select(CreditLedgerEntry).where(
            CreditLedgerEntry.user_id==user_id,CreditLedgerEntry.idempotency_key==key
        )).scalar_one_or_none()

    def _get(self,reservation_id:str)->CreditLedgerEntry:
        entry=self.session.get(CreditLedgerEntry,reservation_id)
        if entry is None or entry.entry_type is not LedgerEntryType.RESERVE:
            raise InvalidReservationStateError(reservation_id,"not_found","look up")
        return entry

    def _pending(self,reservation_id:str,action:str)->CreditLedgerEntry:
        entry=self._get(reservation_id)
        if entry.status is not ReservationStatus.PENDING:
            raise InvalidReservationStateError(reservation_id,str(entry.status),action)
        return entry

    def _sum_refunds(self,reservation_id)->int:
        rows=self.session.execute(select(CreditLedgerEntry).where(
            CreditLedgerEntry.related_entry_id==reservation_id,CreditLedgerEntry.entry_type==LedgerEntryType.REFUND
        )).scalars().all()
        return sum(r.amount for r in rows)

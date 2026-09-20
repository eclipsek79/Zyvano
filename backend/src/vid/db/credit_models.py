"""SQLAlchemy mappings for the canonical Zyvano credits schema.

The database is authoritative. These models mirror the Supabase credits
schema; they do not create a competing schema definition.
"""
from __future__ import annotations
import enum
from datetime import datetime
from typing import Optional
from uuid import UUID
from sqlalchemy import CheckConstraint, DateTime, Enum as SAEnum, ForeignKey, Integer, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from vid.db.session import Base

class PlanCode(str, enum.Enum):
    FREE = "free"
    PREMIUM = "premium"

class LedgerEntryType(str, enum.Enum):
    FREE_PLAN_GRANT = "free_plan_grant"
    PROMOTIONAL_GRANT = "promotional_grant"
    PURCHASE = "purchase"
    RESERVE = "reserve"
    RELEASE = "release"
    REFUND = "refund"
    ADMIN_ADJUSTMENT = "admin_adjustment"
    EXPIRATION = "expiration"

class ReservationStatus(str, enum.Enum):
    PENDING = "pending"
    FINALIZED = "finalized"
    RELEASED = "released"
    PARTIALLY_REFUNDED = "partially_refunded"

class Plan(Base):
    __tablename__ = "plans"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=text("extensions.gen_random_uuid()"))
    code: Mapped[PlanCode] = mapped_column(SAEnum(PlanCode,name="plan_code",schema="public",native_enum=True,create_type=False),nullable=False,unique=True)
    name: Mapped[str] = mapped_column(Text,nullable=False)
    max_resolution: Mapped[str] = mapped_column(Text,nullable=False,server_default=text("'1080p'"))
    allows_desktop_only_resolutions: Mapped[bool] = mapped_column(nullable=False,server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),nullable=False,server_default=text("now()"))
    __table_args__ = (
        CheckConstraint("char_length(name) >= 1 AND char_length(name) <= 100",name="plans_name_check"),
        CheckConstraint("max_resolution IN ('480p','720p','1080p','2k','4k','8k','12k','16k','24k')",name="plans_max_resolution_check"),
    )

class UserPlan(Base):
    __tablename__ = "user_plans"
    id: Mapped[UUID] = mapped_column(primary_key=True,server_default=text("extensions.gen_random_uuid()"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("auth.users.id",ondelete="CASCADE"),nullable=False,unique=True)
    plan_id: Mapped[UUID] = mapped_column(ForeignKey("plans.id",ondelete="RESTRICT"),nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),nullable=False,server_default=text("now()"))
    plan: Mapped[Plan] = relationship("Plan",lazy="joined")

class UserCreditBalance(Base):
    __tablename__ = "user_credit_balances"
    user_id: Mapped[UUID] = mapped_column(ForeignKey("auth.users.id",ondelete="CASCADE"),primary_key=True)
    balance: Mapped[int] = mapped_column(Integer,nullable=False,server_default=text("0"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),nullable=False,server_default=text("now()"))
    __table_args__ = (CheckConstraint("balance >= 0",name="user_credit_balances_balance_check"),)

class CreditLedgerEntry(Base):
    __tablename__ = "credit_ledger_entries"
    id: Mapped[UUID] = mapped_column(primary_key=True,server_default=text("extensions.gen_random_uuid()"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("auth.users.id",ondelete="CASCADE"),nullable=False)
    entry_type: Mapped[LedgerEntryType] = mapped_column(SAEnum(LedgerEntryType,name="ledger_entry_type",schema="public",native_enum=True,create_type=False),nullable=False)
    amount: Mapped[int] = mapped_column(Integer,nullable=False)
    reason: Mapped[str] = mapped_column(Text,nullable=False)
    status: Mapped[Optional[ReservationStatus]] = mapped_column(SAEnum(ReservationStatus,name="reservation_status",schema="public",native_enum=True,create_type=False),nullable=True)
    job_id: Mapped[Optional[UUID]] = mapped_column(nullable=True)
    related_entry_id: Mapped[Optional[UUID]] = mapped_column(ForeignKey("credit_ledger_entries.id",ondelete="RESTRICT"),nullable=True)
    idempotency_key: Mapped[str] = mapped_column(Text,nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),nullable=False,server_default=text("now()"))
    related_entry: Mapped[Optional["CreditLedgerEntry"]] = relationship("CreditLedgerEntry",remote_side="CreditLedgerEntry.id",lazy="joined")
    __table_args__ = (
        UniqueConstraint("user_id","idempotency_key",name="uq_ledger_user_idempotency"),
        CheckConstraint("amount <> 0",name="credit_ledger_entries_amount_check"),
        CheckConstraint("char_length(reason) >= 1 AND char_length(reason) <= 255",name="credit_ledger_entries_reason_check"),
        CheckConstraint("char_length(idempotency_key) >= 1 AND char_length(idempotency_key) <= 255",name="credit_ledger_entries_idempotency_key_check"),
        CheckConstraint("entry_type <> 'reserve' OR amount < 0",name="credit_ledger_reserve_amount_check"),
        CheckConstraint("entry_type NOT IN ('release','refund') OR amount > 0",name="credit_ledger_release_refund_amount_check"),
        CheckConstraint("status IS NULL OR entry_type = 'reserve'",name="credit_ledger_reservation_status_check"),
    )

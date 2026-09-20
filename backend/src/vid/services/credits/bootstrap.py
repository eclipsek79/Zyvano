"""Idempotent plan bootstrap using the canonical public.plans model."""
from sqlalchemy import select
from sqlalchemy.orm import Session
from vid.db.credit_models import Plan,PlanCode

def seed_plans(session:Session)->None:
    existing={p.code for p in session.execute(select(Plan)).scalars()}
    if PlanCode.FREE not in existing: session.add(Plan(code=PlanCode.FREE,name="Free",max_resolution="1080p"))
    if PlanCode.PREMIUM not in existing: session.add(Plan(code=PlanCode.PREMIUM,name="Premium",max_resolution="24k",allows_desktop_only_resolutions=True))
    session.flush()

"""User service with business logic."""
from uuid import UUID
import logging

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from vid.db.models import User
from vid.auth.security import hash_password, verify_password

logger = logging.getLogger(__name__)


class UserService:
    """User business logic service."""

    def __init__(self, db: Session):
        self.db = db

    def create_user(self, email: str, name: str | None, password: str) -> User:
        """Create new user with validated input.
        
        Raises:
            ValueError: If user already exists
        """
        # Check if user already exists
        existing = self.db.query(User).filter(User.email == email).first()
        if existing:
            raise ValueError("User with this email already exists")

        # Create user
        user = User(
            email=email,
            name=name,
            password_hash=hash_password(password),
        )
        try:
            self.db.add(user)
            self.db.commit()
            self.db.refresh(user)
            return user
        except IntegrityError as e:
            self.db.rollback()
            logger.error(f"Database integrity error creating user: {e}")
            raise ValueError("Could not create user")

    def authenticate_user(self, email: str, password: str) -> User | None:
        """Authenticate user by email and password.
        
        Returns:
            User if authentication succeeds, None otherwise
        """
        user = self.db.query(User).filter(User.email == email).first()
        if not user:
            return None
        if not user.password_hash or not verify_password(password, user.password_hash):
            return None
        return user

    def get_user_by_id(self, user_id: UUID) -> User | None:
        """Get user by ID."""
        return self.db.query(User).filter(User.id == user_id).first()

    def get_user_by_email(self, email: str) -> User | None:
        """Get user by email."""
        return self.db.query(User).filter(User.email == email).first()

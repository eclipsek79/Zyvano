from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, CheckConstraint, Column, DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import relationship

from vid.db.session import Base


class ChatConversation(Base):
    __tablename__ = "chat_conversations"
    __table_args__ = (
        UniqueConstraint("user_one_id", "user_two_id", name="uq_chat_pair"),
        CheckConstraint("user_one_id <> user_two_id", name="ck_chat_distinct_users"),
        Index("ix_chat_conversations_user_one", "user_one_id"),
        Index("ix_chat_conversations_user_two", "user_two_id"),
    )

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    user_one_id = Column(PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    user_two_id = Column(PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    messages = relationship("ChatMessage", back_populates="conversation", cascade="all, delete-orphan")

    def contains(self, user_id: UUID) -> bool:
        return user_id in (self.user_one_id, self.user_two_id)

    def other_user_id(self, user_id: UUID) -> UUID:
        if self.user_one_id == user_id:
            return self.user_two_id
        if self.user_two_id == user_id:
            return self.user_one_id
        raise ValueError("User is not a member of this conversation")


class ChatAttachment(Base):
    __tablename__ = "chat_attachments"
    __table_args__ = (
        UniqueConstraint("storage_path", name="uq_chat_attachment_storage_path"),
        CheckConstraint("size_bytes > 0", name="ck_chat_attachment_positive_size"),
        Index("ix_chat_attachments_conversation", "conversation_id"),
    )

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    conversation_id = Column(PGUUID(as_uuid=True), ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    uploader_id = Column(PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    storage_path = Column(String(1024), nullable=False)
    original_name = Column(String(255), nullable=False)
    mime_type = Column(String(255), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        CheckConstraint("nullif(trim(body), '') IS NOT NULL OR attachment_id IS NOT NULL", name="ck_chat_message_content"),
        Index("ix_chat_messages_conversation_created", "conversation_id", "created_at", "id"),
        Index("ix_chat_messages_sender", "sender_id"),
    )

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    conversation_id = Column(PGUUID(as_uuid=True), ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = Column(PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    body = Column(Text, nullable=True)
    attachment_id = Column(PGUUID(as_uuid=True), ForeignKey("chat_attachments.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    read_at = Column(DateTime, nullable=True)
    conversation = relationship("ChatConversation", back_populates="messages")

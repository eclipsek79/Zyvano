"""Create direct user chat tables and Zyvano unique IDs.

Revision ID: 002_direct_chat
Revises: 001_initial_schema
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "002_direct_chat"
down_revision = "001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("zyvano_id", sa.String(length=32), nullable=True))
    op.create_unique_constraint("uq_users_zyvano_id", "users", ["zyvano_id"])
    op.create_index("ix_users_zyvano_id", "users", ["zyvano_id"])

    op.execute("""
        UPDATE users
        SET zyvano_id = 'ZYV-' || upper(substr(replace(id::text, '-', ''), 1, 12))
        WHERE zyvano_id IS NULL
    """)
    op.alter_column("users", "zyvano_id", nullable=False)

    op.create_table(
        "chat_conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_one_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_two_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_one_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_two_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint("user_one_id <> user_two_id", name="ck_chat_distinct_users"),
        sa.UniqueConstraint("user_one_id", "user_two_id", name="uq_chat_pair"),
    )
    op.create_index("ix_chat_conversations_user_one", "chat_conversations", ["user_one_id"])
    op.create_index("ix_chat_conversations_user_two", "chat_conversations", ["user_two_id"])

    op.create_table(
        "chat_attachments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("uploader_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("storage_path", sa.String(length=1024), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["chat_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["uploader_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("storage_path", name="uq_chat_attachment_storage_path"),
        sa.CheckConstraint("size_bytes > 0", name="ck_chat_attachment_positive_size"),
    )
    op.create_index("ix_chat_attachments_conversation", "chat_attachments", ["conversation_id"])

    op.create_table(
        "chat_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sender_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("attachment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["conversation_id"], ["chat_conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["attachment_id"], ["chat_attachments.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "nullif(trim(body), '') IS NOT NULL OR attachment_id IS NOT NULL",
            name="ck_chat_message_content",
        ),
    )
    op.create_index(
        "ix_chat_messages_conversation_created",
        "chat_messages",
        ["conversation_id", "created_at", "id"],
    )
    op.create_index("ix_chat_messages_sender", "chat_messages", ["sender_id"])


def downgrade() -> None:
    op.drop_index("ix_chat_messages_sender", table_name="chat_messages")
    op.drop_index("ix_chat_messages_conversation_created", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_index("ix_chat_attachments_conversation", table_name="chat_attachments")
    op.drop_table("chat_attachments")
    op.drop_index("ix_chat_conversations_user_two", table_name="chat_conversations")
    op.drop_index("ix_chat_conversations_user_one", table_name="chat_conversations")
    op.drop_table("chat_conversations")
    op.drop_index("ix_users_zyvano_id", table_name="users")
    op.drop_constraint("uq_users_zyvano_id", "users", type_="unique")
    op.drop_column("users", "zyvano_id")

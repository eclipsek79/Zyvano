"""Initial database schema with users, projects, media assets, and jobs.

Revision ID: 001_initial_schema
Revises: 
Create Date: 2026-09-03 16:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '001_initial_schema'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create initial schema with all core tables."""
    # Users table
    op.create_table(
        'users',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('password_hash', sa.String(255), nullable=True),
        sa.Column('name', sa.String(255), nullable=True),
        sa.Column('role', sa.Enum('admin', 'user', 'viewer', name='userrole'), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('is_verified', sa.Boolean(), nullable=False),
        sa.Column('last_login_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('email')
    )
    op.create_index('ix_users_email', 'users', ['email'])

    # Projects table
    op.create_table(
        'projects',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('type', sa.Enum('video', 'image', 'animation', 'avatar', name='projecttype'), nullable=False),
        sa.Column('status', sa.Enum('active', 'archived', 'deleted', name='projectstatus'), nullable=False),
        sa.Column('is_public', sa.Boolean(), nullable=False),
        sa.Column('metadata', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('owner_id', 'name', name='uq_projects_owner_name')
    )
    op.create_index('ix_projects_owner_id_created_at', 'projects', ['owner_id', 'created_at'])
    op.create_index('ix_projects_status', 'projects', ['status'])

    # ProjectMembers table for RBAC
    op.create_table(
        'project_members',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('role', sa.Enum('owner', 'editor', 'reviewer', 'viewer', name='projectrole'), nullable=False),
        sa.Column('invited_by_id', sa.UUID(as_uuid=True), nullable=True),
        sa.Column('invite_accepted_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['invited_by_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'user_id', name='uq_project_members_project_user')
    )
    op.create_index('ix_project_members_project_user', 'project_members', ['project_id', 'user_id'])
    op.create_index('ix_project_members_role', 'project_members', ['role'])

    # MediaAssets table
    op.create_table(
        'media_assets',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('type', sa.Enum('image', 'video', 'audio', 'avatar', 'document', name='assettype'), nullable=False),
        sa.Column('name', sa.String(255), nullable=True),
        sa.Column('mime_type', sa.String(100), nullable=True),
        sa.Column('size', sa.Integer(), nullable=True),
        sa.Column('storage_key', sa.String(512), nullable=False),
        sa.Column('metadata', sa.JSON(), nullable=True),
        sa.Column('is_deleted', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('storage_key', name='uq_media_assets_storage_key')
    )
    op.create_index('ix_media_assets_project_id_type', 'media_assets', ['project_id', 'type'])
    op.create_index('ix_media_assets_storage_key', 'media_assets', ['storage_key'])

    # GenerationJobs table
    op.create_table(
        'generation_jobs',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('type', sa.Enum('image', 'video', 'audio', 'avatar', name='generationjobtype'), nullable=False),
        sa.Column('status', sa.Enum('pending', 'queued', 'running', 'completed', 'failed', 'cancelled', name='generationjobstatus'), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False),
        sa.Column('result_id', sa.UUID(as_uuid=True), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('retry_count', sa.Integer(), nullable=False),
        sa.Column('max_retries', sa.Integer(), nullable=False),
        sa.Column('idempotency_key', sa.String(255), nullable=True),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['result_id'], ['media_assets.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('idempotency_key', name='uq_generation_jobs_idempotency_key')
    )
    op.create_index('ix_generation_jobs_project_id_status', 'generation_jobs', ['project_id', 'status'])
    op.create_index('ix_generation_jobs_owner_id_created_at', 'generation_jobs', ['owner_id', 'created_at'])
    op.create_index('ix_generation_jobs_idempotency_key', 'generation_jobs', ['idempotency_key'])
    op.create_index('ix_generation_jobs_status', 'generation_jobs', ['status'])

    # GenerationAttempts table
    op.create_table(
        'generation_attempts',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('job_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('provider', sa.String(100), nullable=False),
        sa.Column('status', sa.String(50), nullable=False),
        sa.Column('provider_request_id', sa.String(255), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('attempt_number', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['generation_jobs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_generation_attempts_job_id', 'generation_attempts', ['job_id'])
    op.create_index('ix_generation_attempts_provider_request_id', 'generation_attempts', ['provider_request_id'])

    # Exports table
    op.create_table(
        'exports',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('format', sa.String(50), nullable=False),
        sa.Column('status', sa.Enum('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled', name='exportstatus'), nullable=False),
        sa.Column('file_id', sa.UUID(as_uuid=True), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('metadata', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['file_id'], ['media_assets.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_exports_project_id_created_at', 'exports', ['project_id', 'created_at'])
    op.create_index('ix_exports_status', 'exports', ['status'])

    # AuditLogs table
    op.create_table(
        'audit_logs',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', sa.UUID(as_uuid=True), nullable=True),
        sa.Column('action', sa.Enum('create', 'update', 'delete', 'view', 'share', 'export', 'download', 'error', name='auditaction'), nullable=False),
        sa.Column('resource_type', sa.String(100), nullable=False),
        sa.Column('resource_id', sa.String(255), nullable=False),
        sa.Column('resource_name', sa.String(255), nullable=True),
        sa.Column('project_id', sa.UUID(as_uuid=True), nullable=True),
        sa.Column('changes', sa.JSON(), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.String(255), nullable=True),
        sa.Column('status', sa.String(50), nullable=False),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_audit_logs_user_id_created_at', 'audit_logs', ['user_id', 'created_at'])
    op.create_index('ix_audit_logs_resource_type_id', 'audit_logs', ['resource_type', 'resource_id'])
    op.create_index('ix_audit_logs_action', 'audit_logs', ['action'])
    op.create_index('ix_audit_logs_created_at', 'audit_logs', ['created_at'])

    # QueueJobs table
    op.create_table(
        'queue_jobs',
        sa.Column('id', sa.UUID(as_uuid=True), nullable=False),
        sa.Column('type', sa.String(100), nullable=False),
        sa.Column('status', sa.String(50), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False),
        sa.Column('result', sa.JSON(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('retry_count', sa.Integer(), nullable=False),
        sa.Column('max_retries', sa.Integer(), nullable=False),
        sa.Column('scheduled_for', sa.DateTime(), nullable=True),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_queue_jobs_status', 'queue_jobs', ['status'])
    op.create_index('ix_queue_jobs_type_status', 'queue_jobs', ['type', 'status'])
    op.create_index('ix_queue_jobs_created_at', 'queue_jobs', ['created_at'])


def downgrade() -> None:
    """Drop all tables."""
    op.drop_index('ix_queue_jobs_created_at', table_name='queue_jobs')
    op.drop_index('ix_queue_jobs_type_status', table_name='queue_jobs')
    op.drop_index('ix_queue_jobs_status', table_name='queue_jobs')
    op.drop_table('queue_jobs')
    op.drop_index('ix_audit_logs_created_at', table_name='audit_logs')
    op.drop_index('ix_audit_logs_action', table_name='audit_logs')
    op.drop_index('ix_audit_logs_resource_type_id', table_name='audit_logs')
    op.drop_index('ix_audit_logs_user_id_created_at', table_name='audit_logs')
    op.drop_table('audit_logs')
    op.drop_index('ix_exports_status', table_name='exports')
    op.drop_index('ix_exports_project_id_created_at', table_name='exports')
    op.drop_table('exports')
    op.drop_index('ix_generation_attempts_provider_request_id', table_name='generation_attempts')
    op.drop_index('ix_generation_attempts_job_id', table_name='generation_attempts')
    op.drop_table('generation_attempts')
    op.drop_index('ix_generation_jobs_status', table_name='generation_jobs')
    op.drop_index('ix_generation_jobs_idempotency_key', table_name='generation_jobs')
    op.drop_index('ix_generation_jobs_owner_id_created_at', table_name='generation_jobs')
    op.drop_index('ix_generation_jobs_project_id_status', table_name='generation_jobs')
    op.drop_table('generation_jobs')
    op.drop_index('ix_media_assets_storage_key', table_name='media_assets')
    op.drop_index('ix_media_assets_project_id_type', table_name='media_assets')
    op.drop_table('media_assets')
    op.drop_index('ix_project_members_role', table_name='project_members')
    op.drop_index('ix_project_members_project_user', table_name='project_members')
    op.drop_table('project_members')
    op.drop_index('ix_projects_status', table_name='projects')
    op.drop_index('ix_projects_owner_id_created_at', table_name='projects')
    op.drop_table('projects')
    op.drop_index('ix_users_email', table_name='users')
    op.drop_table('users')

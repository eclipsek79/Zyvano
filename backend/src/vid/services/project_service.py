"""Project service with business logic."""
from uuid import UUID
import logging

from sqlalchemy.orm import Session

from vid.db.models import Project, User, ProjectStatus

logger = logging.getLogger(__name__)


class ProjectService:
    """Project business logic service."""

    def __init__(self, db: Session):
        self.db = db

    def create_project(
        self, owner: User, name: str, description: str | None = None, type: str = "video"
    ) -> Project:
        """Create new project for user."""
        project = Project(
            owner_id=owner.id,
            name=name,
            description=description,
            type=type,
        )
        self.db.add(project)
        self.db.commit()
        self.db.refresh(project)
        logger.info(f"Project created: {project.id} for user {owner.id}")
        return project

    def get_project(self, project_id: UUID, owner: User) -> Project | None:
        """Get project by ID, verifying ownership."""
        return self.db.query(Project).filter(
            Project.id == project_id,
            Project.owner_id == owner.id,
            Project.status != ProjectStatus.DELETED,
        ).first()

    def list_projects(
        self, owner: User, limit: int = 20, offset: int = 0
    ) -> dict:
        """List projects for user with pagination."""
        query = self.db.query(Project).filter(
            Project.owner_id == owner.id,
            Project.status != ProjectStatus.DELETED,
        )
        total = query.count()

        projects = (
            query.order_by(Project.created_at.desc())
            .limit(limit)
            .offset(offset)
            .all()
        )

        return {
            "projects": projects,
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def update_project(
        self, project_id: UUID, owner: User, name: str | None = None, 
        description: str | None = None
    ) -> Project | None:
        """Update project."""
        project = self.get_project(project_id, owner)
        if not project:
            return None

        if name is not None:
            project.name = name
        if description is not None:
            project.description = description

        self.db.commit()
        self.db.refresh(project)
        return project

    def delete_project(self, project_id: UUID, owner: User) -> bool:
        """Soft delete project (mark as deleted)."""
        project = self.get_project(project_id, owner)
        if not project:
            return False

        project.status = ProjectStatus.DELETED
        self.db.commit()
        logger.info(f"Project deleted: {project_id} by user {owner.id}")
        return True

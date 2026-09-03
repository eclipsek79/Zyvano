# Zyvano

Cross-platform AI creative-production platform for video, image, avatar, and cinematic generation.

**Phase 1 Foundation Implementation**

## Quick Start

### Prerequisites

- Node.js 22.19.0
- pnpm 10.15.1
- Python 3.12.11
- Rust 1.89.0
- PostgreSQL 17.x

### Installation

```bash
# Install dependencies
pnpm install

# Install Python backend dependencies
uv sync --directory backend

# Setup database
pnpm run db:migrate

# Start all services
pnpm run dev
```

### Available Commands

```bash
# Development
pnpm run dev              # Start all services in parallel
pnpm run backend:dev      # Start FastAPI backend only

# Building
pnpm run build            # Build all applications

# Validation
pnpm run validate         # Run all validators
pnpm run validate:repo    # Validate repository structure
pnpm run validate:deps    # Validate dependencies

# Database
pnpm run db:migrate       # Upgrade database schema
pnpm run db:revision      # Create new migration
pnpm run db:downgrade     # Rollback last migration
pnpm run db:history       # View migration history

# Quality
pnpm run lint             # Run linters
pnpm run typecheck        # Run TypeScript checks
pnpm run test             # Run all tests
```

## Architecture

Zyvano Phase 1 provides:

### Backend
- FastAPI 0.116.1 REST API
- PostgreSQL 17.x database
- SQLAlchemy ORM with Alembic migrations
- Provider abstraction for AI services
- Job queue architecture
- Export and deletion systems

### Frontend
- Next.js 15.5.2 web application
- Expo 53.0 mobile (iOS/Android)
- Tauri 2.8.1 desktop (Windows/macOS/Linux)

### Packages
- `@zyvano/types` - Shared TypeScript types
- `@zyvano/validation` - Runtime validation schemas
- `@zyvano/config` - Centralized configuration
- `@zyvano/shared` - Utility functions
- `@zyvano/ui` - Cross-platform UI components
- `@zyvano/api-client` - Typed API client
- `@zyvano/media-contracts` - Media provider contracts

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture and design decisions
- [API.md](docs/API.md) - API endpoints and contracts
- [DATABASE.md](docs/DATABASE.md) - Database schema and relationships
- [DEPENDENCIES.md](docs/DEPENDENCIES.md) - Dependency management
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) - Development workflow
- [SECURITY.md](docs/SECURITY.md) - Security considerations

## Development Workflow

1. **Feature Branch**: Create a feature branch from `main`
2. **Implementation**: Implement your feature across relevant packages/apps
3. **Tests**: Add comprehensive tests
4. **Validation**: Run `pnpm run validate` to ensure everything passes
5. **Pull Request**: Submit PR for review
6. **Merge**: Merge to `main` after approval

## License

Proprietary - Zyvano

# Development Workflows & Guidelines

## Development Environment Setup

### Prerequisites

Ensure correct tool versions:

```bash
node --version       # 22.19.0
pnpm --version       # 10.15.1
python --version     # 3.12.11
rustc --version      # 1.89.0
cargo --version      # 1.89.0
```

Use `asdf` or `direnv` with `.tool-versions` for automatic version switching.

### Initial Setup

```bash
# Clone repository
git clone https://github.com/eclipsek79/Zyvano.git
cd Zyvano

# Install dependencies
pnpm install --frozen-lockfile

# Install Python dependencies
cd backend
uv sync --locked
cd ..

# Verify Rust toolchain
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked

# Run validation
pnpm validate
```

## Development Commands

### Running Development Servers

```bash
# Start all development servers
pnpm dev

# Start specific app
pnpm --filter @zyvano/web dev      # Web
pnpm --filter @zyvano/mobile dev   # Mobile
pnpm --filter @zyvano/desktop dev  # Desktop
pnpm --filter backend dev          # Python backend (when implemented)
```

### Linting & Formatting

```bash
# Lint all packages
pnpm lint

# Format all files
pnpm format

# Check formatting without changes
pnpm format:check

# Lint specific app
pnpm --filter @zyvano/web lint
```

### Type Checking

```bash
# Type check all packages
pnpm typecheck

# Watch mode
pnpm typecheck:watch

# Specific package
pnpm --filter @zyvano/types typecheck
```

### Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage

# Specific package
pnpm --filter @zyvano/web test
```

### Building

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @zyvano/types build

# Web for production
pnpm --filter @zyvano/web build

# Desktop (Tauri)
pnpm --filter @zyvano/desktop build

# Mobile (Expo)
pnpm --filter @zyvano/mobile build
```

### Validation

```bash
# Run full validation pipeline
pnpm validate

# Validate repository structure
pnpm validate:repo

# Validate dependencies
pnpm validate:deps

# Validate code quality
pnpm validate:quality
```

## Git Workflow

### Branch Naming

```
feature/feature-name          # New features
fix/bug-description           # Bug fixes
refactor/area-refactored      # Refactoring
docs/documentation-title      # Documentation
test/test-description         # Test improvements
deps/dependency-update        # Dependency updates
chore/housekeeping-task       # Maintenance
```

### Commit Messages

Follow conventional commit format:

```
type(scope): subject

body (optional)

footer (optional)
```

**Types**:
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code refactor
- `docs` - Documentation
- `test` - Test additions/changes
- `chore` - Build, tooling, dependencies
- `style` - Code style changes

**Examples**:
```
feat(movies): add movie duration validation
fix(auth): prevent expired token reuse
refactor(api): extract common middleware
docs(architecture): update provider docs
test(generation): add job state transition tests
chore(deps): update react to 19.1.0
```

### Pull Request Process

1. **Create branch** from `main`
2. **Make changes** with meaningful commits
3. **Run validation**:
   ```bash
   pnpm validate
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
4. **Push to GitHub**
5. **Open PR** with clear description
6. **Address review comments**
7. **Merge when approved** (squash or rebase)

## Code Style & Standards

### TypeScript

**Configuration**: `tsconfig.json`

**Requirements**:
- Strict mode enabled
- No implicit any
- No unused variables/parameters
- Explicit return types on functions
- Full test coverage for public APIs

**Example**:
```typescript
// GOOD: Explicit types, no any
function generateVideo(script: Script, options: GenerationOptions): Promise<Video> {
  // Implementation
}

// BAD: Implicit any, loose typing
function generateVideo(script, options) {
  // Implementation
}
```

### Naming Conventions

```typescript
// Classes: PascalCase
class VideoGenerator { }
class APIClient { }

// Functions/Variables: camelCase
function generateVideo() { }
const videoData = {};

// Constants: UPPER_SNAKE_CASE
const MAX_MOVIE_DURATION = 18000; // seconds
const DEFAULT_TIMEOUT = 30000;

// Private properties: _prefix
class GenerationJob {
  private _status = 'pending';
}

// Types/Interfaces: PascalCase
interface VideoGenerationProvider { }
type GenerationStatus = 'pending' | 'running' | 'completed';
```

### Comments & Documentation

```typescript
/**
 * Validates movie duration against maximum allowed.
 * 
 * @param durationSeconds - Duration in seconds
 * @returns true if valid, false if exceeds 5-hour limit
 * @throws {ValidationError} If duration is negative
 * 
 * @example
 * ```typescript
 * const isValid = isValidMovieDuration(18000); // true
 * ```
 */
function isValidMovieDuration(durationSeconds: number): boolean {
  return durationSeconds > 0 && durationSeconds <= 18000;
}
```

### Status Indicators

Use specific comments for implementation status:

```typescript
// IMPLEMENTED - Fully functional, tested
export function getUserProject(userId: string) { }

// INTERFACE ONLY - Contract defined, not yet implemented
export interface VideoGenerationProvider {
  generateFromText(prompt: string): Promise<Video>;
}

// MOCK IMPLEMENTATION - Deterministic mock for development
export class MockVideoGenerator implements VideoGenerationProvider {
  async generateFromText(prompt: string): Promise<Video> {
    // Mock implementation
  }
}

// TODO: PROVIDER INTEGRATION - Awaiting external provider
export async function generateWithOpenAI(prompt: string) {
  // INTERFACE ONLY: Awaiting OpenAI integration in Phase 1
  throw new Error('Not yet implemented');
}
```

## API Development

### Endpoint Implementation Pattern

```typescript
// INTERFACE ONLY - Endpoint contract defined
// POST /api/v1/movies
export async function createMovie(request: CreateMovieRequest): Promise<Movie> {
  // 1. Authenticate
  const user = await requireAuth(request);
  
  // 2. Validate input
  const validated = await movieSchema.parseAsync(request.body);
  
  // 3. Check business rules
  if (validated.duration_seconds > 18000) {
    throw new ValidationError('INVALID_MOVIE_DURATION', {
      provided: validated.duration_seconds,
      maximum: 18000
    });
  }
  
  // 4. Check authorization
  const project = await getProject(validated.project_id);
  if (project.owner_id !== user.id) {
    throw new ForbiddenError('UNAUTHORIZED_PROJECT_ACCESS');
  }
  
  // 5. Create resource
  const movie = await db.movies.create({
    ...validated,
    owner_id: user.id
  });
  
  // 6. Audit log
  await auditLog.record({
    user_id: user.id,
    action: 'create',
    resource_type: 'movie',
    resource_id: movie.id
  });
  
  // 7. Return response
  return movie;
}
```

## Database Development

### Creating a Migration

```bash
# Auto-generate from model changes
alembic revision --autogenerate -m "Add users table"

# Manual migration for complex changes
alembic revision -m "Create custom indices"
```

### Migration Template

```python
"""Add movies table

Revision ID: 001_add_movies_table
Revises: 000_initial
Create Date: 2024-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# Alembic revision identification
revision = '001_add_movies_table'
down_revision = '000_initial'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        'movies',
        sa.Column('id', sa.String(36), nullable=False),
        sa.Column('title', sa.String(255), nullable=False),
        sa.Column('duration_seconds', sa.Integer()),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('idx_movies_created_at', 'movies', ['created_at'])

def downgrade() -> None:
    op.drop_index('idx_movies_created_at', 'movies')
    op.drop_table('movies')
```

### Testing Migrations

```bash
# Apply to test database
alembic upgrade head

# Verify schema
psql -d test_zyvano -c "\\dt"

# Rollback one
alembic downgrade -1

# Verify rollback
psql -d test_zyvano -c "\\dt"
```

## Package Development

### Creating a New Package

```bash
# Create package directory
mkdir -p packages/new-package

# Initialize package.json
cat > packages/new-package/package.json << 'EOF'
{
  "name": "@zyvano/new-package",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
EOF

# Create source directory
mkdir -p packages/new-package/src
touch packages/new-package/src/index.ts

# Create TypeScript config
cat > packages/new-package/tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src"]
}
EOF
```

### Using Packages in Apps

```json
{
  "dependencies": {
    "@zyvano/types": "workspace:*",
    "@zyvano/validation": "workspace:*",
    "@zyvano/ui": "workspace:*"
  }
}
```

## Error Handling

### Standard Error Pattern

```typescript
class ZyvanoError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ZyvanoError';
  }
}

class ValidationError extends ZyvanoError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'ValidationError';
  }
}

class AuthorizationError extends ZyvanoError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('FORBIDDEN', message, details);
    this.name = 'AuthorizationError';
  }
}

// Usage
if (movie.duration > MAX_DURATION) {
  throw new ValidationError(
    'INVALID_MOVIE_DURATION',
    'Movie duration exceeds 5 hours',
    { provided: movie.duration, maximum: MAX_DURATION }
  );
}
```

### Error Response Formatting

```typescript
app.use((error: Error, req: Request, res: Response) => {
  const isZyvanoError = error instanceof ZyvanoError;
  
  res.status(getStatusCode(error)).json({
    success: false,
    data: null,
    error: {
      code: isZyvanoError ? error.code : 'INTERNAL_ERROR',
      message: error.message,
      details: isZyvanoError ? error.details : {}
    },
    request_id: req.id
  });
});
```

## Testing Guidelines

### Test File Structure

```
packages/ui/src/
├── Button.tsx
└── Button.test.tsx

packages/validation/src/
├── schemas/
│   ├── movie.ts
│   └── movie.test.ts
└��─ validators/
    ├── duration.ts
    └── duration.test.ts
```

### Test Template

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateMovieDuration, ValidationError } from './duration';

describe('validateMovieDuration', () => {
  it('accepts durations up to 5 hours', () => {
    const result = validateMovieDuration(18000); // 5 hours in seconds
    expect(result).toBe(true);
  });
  
  it('rejects durations exceeding 5 hours', () => {
    expect(() => validateMovieDuration(18001)).toThrow(ValidationError);
  });
  
  it('rejects negative durations', () => {
    expect(() => validateMovieDuration(-1)).toThrow(ValidationError);
  });
});
```

## Documentation in Code

### Module Documentation

```typescript
/**
 * @module @zyvano/validation
 * 
 * Validation schemas and utilities for Zyvano API contracts.
 * 
 * **Status**: IMPLEMENTED
 * 
 * **Exports**:
 * - {@link movieSchema} - Movie validation schema
 * - {@link validateMovieDuration} - Duration validator
 * - {@link isValidEpisodeCount} - Episode count validator
 */
```

### Function Documentation

```typescript
/**
 * Validates a movie's duration against maximum constraints.
 * 
 * Movies are limited to 5 hours (18000 seconds) to ensure
 * reasonable generation times and platform limits.
 * 
 * @param durationSeconds - Duration in seconds
 * @returns true if valid
 * @throws {ValidationError} with code 'INVALID_MOVIE_DURATION' if invalid
 * 
 * @example
 * ```typescript
 * try {
 *   validateMovieDuration(7200); // 2 hours
 * } catch (error) {
 *   console.error(error.code); // INVALID_MOVIE_DURATION
 * }
 * ```
 * 
 * @see {@link MOVIE_MAX_DURATION_SECONDS}
 */
function validateMovieDuration(durationSeconds: number): boolean {
  // Implementation
}
```

## Performance Considerations

### Bundle Size

```bash
# Analyze bundle size
pnpm --filter @zyvano/web build -- --analyze

# Check individual package sizes
pnpm --filter @zyvano/ui build && du -sh packages/ui/dist/
```

### Code Splitting

- Route-based splitting in Next.js (automatic)
- Dynamic imports for optional features
- Separate vendor chunks

### Database Queries

- Use indexes for frequently queried columns
- Implement pagination for large result sets
- Avoid N+1 queries with proper JOINs

## Debugging

### Debug Logging

```typescript
import debug from 'debug';

const log = debug('zyvano:movies');

export function createMovie(data: CreateMovieRequest) {
  log('Creating movie:', data);
  
  const result = db.movies.create(data);
  
  log('Movie created:', result.id);
  return result;
}
```

Enable debugging:
```bash
DEBUG=zyvano:* pnpm dev
DEBUG=zyvano:movies pnpm dev
```

### Debugging in VS Code

**.vscode/launch.json**:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Launch Backend",
      "program": "${workspaceFolder}/backend/main.py",
      "console": "integratedTerminal"
    }
  ]
}
```

## Clean Code Principles

1. **Clarity over cleverness** - Code is read more than written
2. **Single responsibility** - One function, one purpose
3. **Explicit over implicit** - Types, error handling, side effects
4. **Testable** - Code designed for unit testing
5. **Documented** - Purpose, contracts, examples
6. **Maintainable** - Easy to understand, modify, extend

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [React Documentation](https://react.dev)
- [SQLAlchemy Documentation](https://docs.sqlalchemy.org)
- [Conventional Commits](https://www.conventionalcommits.org/)

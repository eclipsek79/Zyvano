# Security Practices & Baseline

## Overview

Zyvano implements security practices appropriate for Phase 0 (foundation). Production-scale security infrastructure will be added in later phases.

**Status**: PARTIALLY IMPLEMENTED

## Authentication & Authorization

### Authentication Approach

**Status**: INTERFACE ONLY (Phase 1 implementation)

Multi-provider authentication with social login support:

```typescript
interface AuthProvider {
  name: 'google' | 'github' | 'email';
  authenticate(credentials: Credentials): Promise<AuthToken>;
  refreshToken(token: string): Promise<AuthToken>;
}
```

Supported providers:
- Google OAuth 2.0
- GitHub OAuth 2.0
- Email + password (HMAC-SHA256)

### Session Management

```typescript
interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}
```

**Requirements**:
- Tokens are cryptographically signed (JWT)
- Sessions expire after 30 days
- Refresh tokens extend validity
- Logout invalidates session immediately

**Status**: INTERFACE ONLY (JWT validation framework pending)

### Authorization

All API endpoints require authentication. Resource access checks ownership:

```typescript
async function validateOwnership(
  resource_id: string,
  user_id: string
): Promise<boolean> {
  const resource = await getResource(resource_id);
  
  // Direct ownership
  if (resource.owner_id === user_id) return true;
  
  // Project membership (for collaborative access)
  if (resource.project_id) {
    const member = await getProjectMember(
      resource.project_id,
      user_id
    );
    return member !== null && member.role !== 'viewer';
  }
  
  return false;
}
```

**Status**: PARTIALLY IMPLEMENTED (ownership checks in place, role-based access control pending)

## Input Validation

### API Boundary Validation

All API inputs are validated before processing:

```typescript
// Example: Movie creation validation
const createMovieSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  script_id: z.string().uuid().optional(),
  duration_hours: z.number().min(0).max(5),
  genre: z.string().optional(),
  visual_style: z.string().optional(),
  tone: z.string().optional()
});

export async function POST(request: Request) {
  const body = await request.json();
  const validated = createMovieSchema.parse(body);
  
  // Process validated data
  return createMovie(validated);
}
```

**Tools**:
- Zod for schema validation
- TypeScript strict mode
- Runtime validation at API boundaries

**Status**: IMPLEMENTED (schemas defined, enforcement in progress)

### SQL Injection Prevention

SQLAlchemy ORM with parameterized queries prevents SQL injection:

```python
# SAFE: Uses parameterized query
user = db.session.query(User).filter(User.email == email).first()

# NEVER: String concatenation
user = db.session.execute(f"SELECT * FROM users WHERE email = '{email}'")  # UNSAFE
```

**Status**: IMPLEMENTED (ORM enforced via SQLAlchemy)

### File Upload Validation

**Status**: INTERFACE ONLY (Phase 1 implementation)

Validation requirements:
- File type whitelist (scripts: .txt, .pdf)
- File size limits (scripts: max 10MB)
- MIME type verification
- Virus scanning (external service)

```typescript
const ALLOWED_MIME_TYPES = ['text/plain', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

async function validateScriptUpload(file: File) {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new ValidationError('INVALID_FILE_TYPE');
  }
  
  if (file.size > MAX_FILE_SIZE) {
    throw new ValidationError('FILE_TOO_LARGE');
  }
  
  // Virus scan via external service
  await virusScan(file);
}
```

## Secrets Management

### Environment Variables

All secrets are managed via environment variables, never hardcoded:

**.env.example** (safe to commit):
```env
DATABASE_URL=postgresql://user:password@localhost:5432/zyvano
AUTH_SECRET=your-secret-key-here
JWT_SECRET=your-jwt-secret-here
```

**.env** or **.env.local** (never commit):
```env
DATABASE_URL=postgresql://user:actual_password@prod.db:5432/zyvano
AUTH_SECRET=actual-secret-key
JWT_SECRET=actual-jwt-secret
```

**Status**: IMPLEMENTED (framework in place, deployment secrets pending)

### Sensitive Data Handling

**Rules**:
1. Never log passwords, tokens, or API keys
2. Never expose secrets in error messages
3. Use `.gitignore` to exclude `.env`, `.env.local`
4. Rotate secrets regularly in production

```typescript
// GOOD: No secrets in logs
logger.info('User authenticated', { user_id: user.id });

// BAD: Exposes secret
logger.info('User authenticated', { password: user.password });

// BAD: Exposes token in error
if (!isValidToken(token)) {
  throw new Error(`Invalid token: ${token}`);
}

// GOOD: Generic error message
if (!isValidToken(token)) {
  throw new Error('Invalid or expired token');
}
```

**Status**: IMPLEMENTED (guidelines defined, enforcement via code review)

## Rate Limiting

**Status**: INTERFACE ONLY (Phase 1 implementation)

Rate limit strategy:
- **Authentication endpoints**: 10 requests/minute per IP
- **General API endpoints**: 100 requests/minute per user
- **Generation endpoints**: Custom per provider

Implementation via middleware:

```typescript
interface RateLimitConfig {
  windowMs: number;     // Time window in milliseconds
  max: number;          // Max requests per window
  keyGenerator: (req) => string;  // Identifier (IP, user_id, etc.)
}

const authLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,
  keyGenerator: (req) => req.ip
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user.id
});

app.post('/api/v1/auth/login', authLimiter, handleLogin);
app.get('/api/v1/projects', apiLimiter, listProjects);
```

**Response headers**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## Data Protection

### Database Security

**Access Control**:
- Database credentials stored in environment variables
- Separate credentials for development, staging, production
- Read-only replicas for analytics queries

**Encryption**:
- Database connection uses TLS
- At-rest encryption (hardware-level, managed by PostgreSQL provider)

**Status**: INTERFACE ONLY (encryption implementation deferred to infrastructure phase)

### Audit Logging

All significant actions are logged:

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY,
    user_id UUID,
    resource_type VARCHAR(100),
    resource_id UUID,
    action VARCHAR(50),
    details JSONB,
    request_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Logged actions:
- Create, update, delete resource
- Access sensitive resources
- Authorization failures
- Generation jobs
- Exports

**Status**: IMPLEMENTED (schema defined, population in progress)

### Soft Deletes

Resources are soft-deleted (not permanently removed):

```typescript
// Soft delete: Mark with deleted_at timestamp
await db.projects.update(projectId, {
  deleted_at: new Date()
});

// Queries exclude soft-deleted by default
const projects = await db.projects.findAll({
  where: { deleted_at: null }
});

// Restore if needed
await db.projects.update(projectId, {
  deleted_at: null
});
```

**Status**: IMPLEMENTED (schema supports, enforcement via ORM)

## API Security

### CORS Configuration

**Status**: INTERFACE ONLY (Phase 1 implementation)

```typescript
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
```

Development (localhost):
```
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

Production:
```
ALLOWED_ORIGINS=https://zyvano.com,https://app.zyvano.com
```

### CSRF Protection

**Status**: INTERFACE ONLY (Phase 1 implementation)

CSRF tokens required for state-changing operations:

```typescript
// Generate token
const csrfToken = generateCsrfToken();

// Include in forms
<form method="POST" action="/api/v1/projects">
  <input type="hidden" name="_csrf" value={csrfToken} />
</form>

// Validate in middleware
app.post('/api/v1/projects', validateCsrf, createProject);
```

### HTTPS Only

**Status**: INTERFACE ONLY (production phase)

Requirements:
- All production traffic uses HTTPS
- HSTS header: `Strict-Transport-Security: max-age=31536000`
- Certificate pinning (if applicable)

## Error Handling & Information Disclosure

### Safe Error Messages

Never expose implementation details in error responses:

```typescript
// GOOD: Generic error message
{
  "error": {
    "code": "GENERATION_FAILED",
    "message": "Video generation failed. Please try again."
  }
}

// BAD: Exposes implementation
{
  "error": "Failed to call OpenAI API: connection timeout"
}

// BAD: Exposes SQL
{
  "error": "SQL syntax error: invalid column 'user_names'"
}
```

### Stack Trace Handling

Development:
```typescript
if (process.env.NODE_ENV === 'development') {
  res.json({ error: error.message, stack: error.stack });
}
```

Production:
```typescript
if (process.env.NODE_ENV === 'production') {
  res.json({ error: { code: 'INTERNAL_ERROR', message: 'An error occurred' } });
  // Log full error internally
  logger.error(error, { request_id });
}
```

**Status**: PARTIALLY IMPLEMENTED

## Dependency Security

### Version Pinning

All dependencies are pinned to exact versions in lockfiles:
- `pnpm-lock.yaml` - JavaScript dependencies
- `backend/uv.lock` - Python dependencies
- `Cargo.lock` - Rust dependencies

**Status**: IMPLEMENTED

### Vulnerability Scanning

**Status**: INTERFACE ONLY (CI workflow framework defined)

```bash
# JavaScript vulnerability audit
pnpm audit

# Python vulnerability audit
pip-audit -r backend/requirements-lock.txt

# Rust vulnerability audit
cargo audit
```

Automated CI checks:
- `pnpm audit --audit-level moderate` fails on moderate+ vulnerabilities
- Policy: Update vulnerable dependencies within 7 days for high/critical

**Status**: INTERFACE ONLY (CI implementation pending)

### Supply Chain Security

**Practices**:
1. Use only well-maintained packages
2. Review dependency changes in PR reviews
3. Avoid packages with single maintainers
4. Pin transitive dependency versions
5. Monitor GitHub security advisories

**Status**: IMPLEMENTED (via code review)

## Infrastructure Security

**Status**: INTERFACE ONLY (Phase 2+)

Future considerations:
- Infrastructure as Code (Terraform, Pulumi)
- Network segmentation
- Load balancer TLS termination
- Web Application Firewall (WAF)
- DDoS protection
- Intrusion detection

## Compliance & Privacy

### Data Retention

**Status**: INTERFACE ONLY (Phase 1 implementation)

Policy:
- User data retained while account active
- Deletion requests processed within 30 days
- Audit logs retained for 1 year
- Backups retained for 90 days

### Privacy Policy

**Status**: Not yet drafted

Must include:
- Data collection practices
- Data sharing (with AI providers, etc.)
- User rights (access, deletion, export)
- Retention policies
- Cookie usage
- Third-party integrations

### Terms of Service

**Status**: Not yet drafted

Must include:
- Acceptable use policy
- Content moderation policies
- AI-generated content ownership
- Limitation of liability
- Dispute resolution

## Security Testing

### Penetration Testing

**Status**: INTERFACE ONLY (Phase 2+)

Scope:
- API security
- Authentication/authorization
- Input validation
- OWASP Top 10 vulnerabilities

### Code Review Checklists

**Security checklist for code reviews**:
- [ ] No secrets in code/logs
- [ ] Input validation present
- [ ] Authorization checks performed
- [ ] Error messages don't expose internals
- [ ] SQL queries use ORM/parameterization
- [ ] Dependencies reviewed for vulnerabilities

**Status**: IMPLEMENTED (guidelines defined)

## Incident Response

**Status**: INTERFACE ONLY (Phase 2+)

Incident response plan to define:
1. Detection and alerting
2. Escalation procedures
3. Investigation process
4. Remediation steps
5. Communication templates
6. Post-incident review

## Security Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security](https://owasp.org/www-project-api-security/)
- [CWE Top 25](https://cwe.mitre.org/top25/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

## Reporting Security Issues

**Status**: INTERFACE ONLY (process TBD)

Security issues should be reported via:
- Private GitHub security advisory
- `security@zyvano.com` (when established)

Do NOT open public issues for security vulnerabilities.

## Security Roadmap

### Phase 0 (Current)
✅ Input validation framework
✅ Ownership authorization checks
✅ Soft delete support
✅ Environment variable secrets
✅ Audit log schema
✅ Code review guidelines

### Phase 1
- OAuth 2.0 provider integration
- JWT authentication implementation
- Session management
- Rate limiting middleware
- CORS configuration
- CSRF protection
- Vulnerability scanning in CI

### Phase 2
- Infrastructure security
- WAF/DDoS protection
- Penetration testing
- Privacy policy & compliance
- Incident response procedures

### Phase 3+
- Advanced threat detection
- Zero-trust architecture
- Automated security testing

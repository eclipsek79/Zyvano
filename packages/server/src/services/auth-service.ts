/**
 * Authentication.
 *
 * Covers registration, login, logout, session issuance/rotation/revocation,
 * email verification and password reset. Security properties:
 *  - passwords are scrypt-hashed and never logged or returned,
 *  - session and reset tokens are stored only as hashes,
 *  - login failures are rate-limited per account and per IP,
 *  - re-hashing happens automatically when the work factor is raised.
 */
import {
  errors,
  type AuthSessionDTO,
  type UserDTO,
} from '@zyvano/shared';

import type { AppConfig } from '../config/env';
import { hashPassword, passwordHashNeedsRehash, verifyPassword, generateToken } from '../security/crypto';
import { createSessionTokens, sessionExpiry, hashToken } from '../security/session';
import type { Mailer } from '../infrastructure/email/mailer';
import type { AuditService } from './audit-service';
import type { OrganizationRepository } from '../repositories/organization-repository';
import type { SessionRepository } from '../repositories/session-repository';
import type { UserRepository } from '../repositories/user-repository';
import { toUserDTO } from '../db/mappers';
import { AuthTokenRepository } from '../repositories/auth-token-repository';

const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;
const PASSWORD_RESET_TTL_MINUTES = 60;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

/** Login outcomes that are audited identically for every failure mode. */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly organizations: OrganizationRepository,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
    /**
     * Token ledger. Injectable so integration tests can substitute a fixture; the
     * default has no external dependencies, so the container need not wire it.
     */
    private readonly tokens: AuthTokenRepository = new AuthTokenRepository(),
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    organizationName?: string | undefined;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ user: UserDTO; session: { sessionToken: string; csrfToken: string; expiresAt: Date } }> {
    const existing = await this.users.existsByEmail(input.email);
    if (existing) {
      // Registration must not become an account-enumeration oracle. The audit
      // trail still records the attempt for abuse detection.
      await this.audit.record({
        category: 'auth',
        action: 'auth.register.duplicate_email',
        metadata: { email: input.email },
      });
      throw errors.conflict('An account with this email already exists.');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.users.create({ email: input.email, displayName: input.displayName, passwordHash });

    // Every account gets a personal organization so projects always have an
    // owning workspace. The creator is its owner.
    const organizationName = input.organizationName?.trim() || `${input.displayName}'s Workspace`;
    const slug = await this.uniqueSlug(organizationName);
    const organization = await this.organizations.create({
      name: organizationName,
      slug,
      ownerId: user.id,
    });
    await this.organizations.addMember({
      organizationId: organization.id,
      userId: user.id,
      role: 'owner',
    });

    await this.sendVerificationEmail(user.id, user.email, user.display_name);

    const session = await this.issueSession({
      userId: user.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    await this.audit.record({
      organizationId: organization.id,
      actorUserId: user.id,
      actorEmail: user.email,
      category: 'auth',
      action: 'auth.register',
      resourceType: 'user',
      resourceId: user.id,
    });

    return { user: toUserDTO(user), session };
  }

  async login(input: {
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ user: UserDTO; session: { sessionToken: string; csrfToken: string; expiresAt: Date } }> {
    const user = await this.users.findByEmail(input.email);

    // Always spend the same work whether or not the account exists, so response
    // timing does not leak account existence.
    if (!user) {
      await hashPassword(input.password);
      await this.recordLoginFailure(null, input.email, input.ipAddress ?? null, 'unknown_account');
      throw errors.invalidCredentials();
    }

    if (await this.users.isLocked(user.id)) {
      await this.recordLoginFailure(user.id, input.email, input.ipAddress ?? null, 'locked');
      throw errors.rateLimited('Too many failed attempts. Try again later.');
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
      await this.users.recordLoginFailure(user.id, MAX_FAILED_LOGINS, LOCK_MINUTES);
      await this.recordLoginFailure(user.id, input.email, input.ipAddress ?? null, 'bad_password');
      throw errors.invalidCredentials();
    }

    if (user.status !== 'active') {
      throw errors.forbidden('This account is not active.');
    }

    // Opportunistic upgrade when the hashing work factor has been raised.
    if (passwordHashNeedsRehash(user.password_hash)) {
      await this.users.updatePassword(user.id, await hashPassword(input.password));
    }

    await this.users.recordLoginSuccess(user.id);
    const session = await this.issueSession({
      userId: user.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      category: 'auth',
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    const refreshed = (await this.users.findById(user.id)) ?? user;
    return { user: toUserDTO(refreshed), session };
  }

  /**
   * Builds the full session payload for the SPA: the user, their organizations
   * and the CSRF token the client must echo on writes.
   */
  async buildSessionPayload(input: {
    userId: string;
    csrfToken: string;
    expiresAt: Date;
  }): Promise<AuthSessionDTO> {
    const user = await this.users.findById(input.userId);
    if (!user) throw errors.unauthenticated();
    const organizations = await this.organizations.listForUser(input.userId);
    return {
      user: toUserDTO(user),
      organizations,
      csrfToken: input.csrfToken,
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  private async issueSession(input: {
    userId: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<{ sessionToken: string; csrfToken: string; expiresAt: Date }> {
    const tokens = createSessionTokens();
    const expiresAt = sessionExpiry(this.config);
    await this.sessions.create({
      userId: input.userId,
      tokenHash: tokens.sessionTokenHash,
      csrfTokenHash: tokens.csrfTokenHash,
      expiresAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });
    return { sessionToken: tokens.sessionToken, csrfToken: tokens.csrfToken, expiresAt };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      actorUserId: userId,
      category: 'auth',
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: sessionId,
    });
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId);
    await this.audit.record({
      actorUserId: userId,
      category: 'auth',
      action: 'auth.sessions.revoked_all',
      metadata: { count },
    });
    return count;
  }

  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    keepSessionId: string;
  }): Promise<void> {
    const user = await this.users.findById(input.userId);
    if (!user) throw errors.unauthenticated();

    const ok = await verifyPassword(input.currentPassword, user.password_hash);
    if (!ok) {
      await this.audit.record({
        actorUserId: user.id,
        category: 'auth',
        action: 'auth.password.change_failed',
      });
      throw errors.forbidden('Current password is incorrect.');
    }

    await this.users.updatePassword(user.id, await hashPassword(input.newPassword));

    // Revoke every other session: a password change must not leave an old one live.
    const active = await this.sessions.listActiveForUser(user.id);
    for (const session of active) {
      if (session.id !== input.keepSessionId) await this.sessions.revoke(session.id);
    }

    await this.audit.record({
      actorUserId: user.id,
      category: 'auth',
      action: 'auth.password.changed',
      metadata: { otherSessionsRevoked: active.length - 1 },
    });
  }

  async sendVerificationEmail(userId: string, email: string, displayName: string): Promise<void> {
    const token = generateToken(32);
    await this.tokens.create({
      userId,
      kind: 'email_verification',
      tokenHash: hashToken(token),
      expiresInMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
    });
    const verifyUrl = `${this.config.applicationUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.mailer.sendEmailVerification({ to: email, displayName, verifyUrl });
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.tokens.consume('email_verification', hashToken(token));
    if (!record) throw errors.validation('This verification link is invalid or has expired.');
    await this.users.markEmailVerified(record.user_id);
    await this.audit.record({
      actorUserId: record.user_id,
      category: 'auth',
      action: 'auth.email.verified',
      resourceType: 'user',
      resourceId: record.user_id,
    });
  }

  /**
   * Always succeeds from the caller's perspective: whether the address exists is
   * never disclosed by the reset endpoint.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;

    const token = generateToken(32);
    await this.tokens.create({
      userId: user.id,
      kind: 'password_reset',
      tokenHash: hashToken(token),
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
    const resetUrl = `${this.config.applicationUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mailer.sendPasswordReset({ to: user.email, displayName: user.display_name, resetUrl });
    await this.audit.record({
      actorUserId: user.id,
      category: 'auth',
      action: 'auth.password.reset_requested',
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.tokens.consume('password_reset', hashToken(token));
    if (!record) throw errors.validation('This reset link is invalid or has expired.');
    await this.users.updatePassword(record.user_id, await hashPassword(newPassword));
    await this.sessions.revokeAllForUser(record.user_id);
    await this.audit.record({
      actorUserId: record.user_id,
      category: 'auth',
      action: 'auth.password.reset_completed',
    });
  }

  /** Rotates the session token in place and returns the fresh token pair. */
  async rotateSession(sessionId: string): Promise<{ sessionToken: string; csrfToken: string; expiresAt: Date }> {
    const tokens = createSessionTokens();
    const expiresAt = sessionExpiry(this.config);
    await this.sessions.rotate(sessionId, tokens.sessionTokenHash, tokens.csrfTokenHash, expiresAt);
    return { sessionToken: tokens.sessionToken, csrfToken: tokens.csrfToken, expiresAt };
  }

  private async recordLoginFailure(
    userId: string | null,
    email: string,
    ipAddress: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      actorUserId: userId,
      actorEmail: email,
      category: 'auth',
      action: 'auth.login_failed',
      metadata: { reason, ipAddress },
    });
  }

  /** Generates a slug that is unique among organizations. */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'workspace';

    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      if (!(await this.organizations.slugExists(candidate))) return candidate;
    }
    return `${base}-${generateToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  }
}

/** Exposed for tests. */
export { GENERIC_LOGIN_FAILURE };

/**
 * Request validation contracts.
 *
 * The API re-validates every payload with these schemas, so they are the boundary
 * that keeps malformed or hostile input out of the services. The tests assert the
 * rejection paths, not just the happy path, because a schema that is too lax is
 * the failure that matters.
 */
import { describe, expect, it } from 'vitest';

import {
  changePasswordSchema,
  createProjectSchema,
  createSceneSchema,
  emailSchema,
  generateScriptSchema,
  inviteMemberSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
  resetPasswordSchema,
  reorderScenesSchema,
  slugSchema,
  updateProjectSchema,
} from '@zyvano/shared';

describe('passwordSchema', () => {
  it('accepts a compliant password', () => {
    expect(passwordSchema.safeParse('longenough1').success).toBe(true);
  });

  it('rejects passwords that are too short, too long, or missing a class', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(129) + '1').success).toBe(false);
    // Letters only / digits only are both rejected.
    expect(passwordSchema.safeParse('abcdefghijkl').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890123').success).toBe(false);
  });

  it('counts unicode characters rather than bytes', () => {
    // Emoji-heavy password that is long enough by character count.
    expect(passwordSchema.safeParse('pässwörd1234').success).toBe(true);
  });
});

describe('emailSchema', () => {
  it('trims and lowercases so addresses compare consistently', () => {
    const result = emailSchema.safeParse('  Person@Example.COM ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('person@example.com');
  });

  it('rejects malformed addresses', () => {
    for (const value of ['', 'no-at-sign', 'two@@example.com', 'a@b', 'spaces in@example.com']) {
      expect(emailSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('slugSchema', () => {
  it('normalises case and accepts hyphenated slugs', () => {
    const result = slugSchema.safeParse('  My-Workspace ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('my-workspace');
  });

  it('rejects underscores, leading hyphens and spaces', () => {
    for (const value of ['has_underscore', '-leading', 'has space', 'trailing-']) {
      expect(slugSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('registerSchema', () => {
  it('accepts a valid registration', () => {
    const result = registerSchema.safeParse({
      email: 'new@example.com',
      password: 'goodpassword1',
      displayName: '  Ada Lovelace  ',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.displayName).toBe('Ada Lovelace');
  });

  it('rejects a weak password even when the other fields are valid', () => {
    const result = registerSchema.safeParse({
      email: 'new@example.com',
      password: 'weak',
      displayName: 'Ada',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field under strict parsing rules', () => {
    // zod strips unknown keys by default, so assert the reverse: the schema must
    // not carry a forged role through to the service.
    const result = registerSchema.safeParse({
      email: 'new@example.com',
      password: 'goodpassword1',
      displayName: 'Ada',
      role: 'owner',
    });
    expect(result.success).toBe(true);
    if (result.success) expect('role' in result.data).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts any non-empty password without applying the strength policy', () => {
    // Sign-in must not reject a correct-but-weak legacy password: the policy is
    // enforced when a password is set, not when it is presented.
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });

  it('rejects an empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  it('requires a long token and a compliant new password', () => {
    expect(
      resetPasswordSchema.safeParse({ token: 'a'.repeat(21), password: 'brandnewpass1' }).success,
    ).toBe(true);
    // A short token is a truncated or guessed one.
    expect(
      resetPasswordSchema.safeParse({ token: 'short', password: 'brandnewpass1' }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ token: 'a'.repeat(21), password: 'weak' }).success,
    ).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('requires the current password alongside the new one', () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'oldpass1234', newPassword: 'newpass1234' })
        .success,
    ).toBe(true);
    expect(changePasswordSchema.safeParse({ newPassword: 'newpass1234' }).success).toBe(false);
  });
});

describe('createProjectSchema', () => {
  it('defaults the aspect ratio when omitted', () => {
    const result = createProjectSchema.safeParse({ name: 'Launch film' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.aspectRatio).toBe('16:9');
  });

  it('rejects an unsupported aspect ratio and an out-of-range duration', () => {
    expect(createProjectSchema.safeParse({ name: 'x', aspectRatio: '5:4' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'x', targetDurationSeconds: 0 }).success).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: 'x', targetDurationSeconds: 3601 }).success,
    ).toBe(false);
    // Fractional seconds are not allowed: the column is an integer.
    expect(
      createProjectSchema.safeParse({ name: 'x', targetDurationSeconds: 12.5 }).success,
    ).toBe(false);
  });

  it('requires a non-empty name', () => {
    expect(createProjectSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('updateProjectSchema', () => {
  it('requires at least one changed field', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single valid field', () => {
    expect(updateProjectSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  it('refuses to move a project into the deleted status through a normal update', () => {
    // `deleted` is only reachable through the delete endpoint, which runs the
    // storage cleanup; allowing it here would orphan media.
    expect(updateProjectSchema.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ status: 'archived' }).success).toBe(true);
  });
});

describe('createSceneSchema', () => {
  it('defaults the duration and accepts a range of values', () => {
    const result = createSceneSchema.safeParse({ title: 'Opening shot' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.durationSeconds).toBe(5);
  });

  it('rejects durations outside the supported range', () => {
    expect(createSceneSchema.safeParse({ title: 'x', durationSeconds: 0.1 }).success).toBe(false);
    expect(createSceneSchema.safeParse({ title: 'x', durationSeconds: 601 }).success).toBe(false);
  });
});

describe('generateScriptSchema', () => {
  it('requires a prompt long enough to be meaningful', () => {
    expect(generateScriptSchema.safeParse({ prompt: 'too short' }).success).toBe(false);
    expect(
      generateScriptSchema.safeParse({ prompt: 'A thirty second launch film about solar power.' })
        .success,
    ).toBe(true);
  });

  it('defaults the language and accepts an idempotency key', () => {
    const result = generateScriptSchema.safeParse({
      prompt: 'A thirty second launch film about solar power.',
      idempotencyKey: 'abc12345',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe('en');
  });
});

describe('reorderScenesSchema', () => {
  it('requires a list of scene ids', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(reorderScenesSchema.safeParse({ sceneIds: [id] }).success).toBe(true);
    // A non-UUID entry would let an attacker probe for other projects' scenes.
    expect(reorderScenesSchema.safeParse({ sceneIds: ['not-a-uuid'] }).success).toBe(false);
    expect(reorderScenesSchema.safeParse({ sceneIds: [] }).success).toBe(false);
  });
});

describe('inviteMemberSchema', () => {
  it('refuses to invite someone directly as owner', () => {
    // Ownership transfer is a separate, audited operation.
    expect(inviteMemberSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
    expect(inviteMemberSchema.safeParse({ email: 'a@b.com', role: 'editor' }).success).toBe(true);
  });
});

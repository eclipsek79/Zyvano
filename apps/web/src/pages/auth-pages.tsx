/**
 * Authentication screens.
 *
 * All of them talk to the real endpoints and surface the server's own error
 * codes, so the user sees the actual reason (bad credentials, unverified email,
 * rate limited) rather than a generic failure.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { passwordSchema } from '@zyvano/shared';

import { Alert, Button, TextField, useToast } from '../components/ui';
import { ApiError } from '../lib/api-client';
import { authApi } from '../lib/api';
import { useAuth } from '../state/auth-context';

/* --------------------------------- shell ---------------------------------- */

const PIPELINE = [
  'Describe the video you want',
  'Generate the script',
  'Plan the storyboard',
  'Render scenes into a timeline',
  'Export a verified master file',
];

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-layout">
      <aside className="auth-aside">
        <div className="brand row row-3">
          <div className="brand-mark" aria-hidden="true">
            Z
          </div>
          <div className="stack">
            <span className="brand-name">Zyvano</span>
            <span className="brand-sub">AI video studio</span>
          </div>
        </div>

        <div className="stack stack-5">
          <h1 style={{ fontSize: 30, maxWidth: 460 }}>
            From a written brief to a rendered video, in one pipeline.
          </h1>
          <ol className="pipeline-list">
            {PIPELINE.map((step, index) => (
              <li className="pipeline-step" key={step}>
                <span className="pipeline-index">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-xs faint" style={{ maxWidth: 420 }}>
          Generation runs asynchronously on Zyvano workers. Progress you see in the studio is
          reported by the server, never simulated.
        </p>
      </aside>

      <div className="auth-form-side">
        <div className="auth-card stack stack-5">{children}</div>
      </div>
    </div>
  );
}

/** True when the error is a field-level validation failure rather than a form one. */
function isTransportError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/* ------------------------------ login page -------------------------------- */

export function LoginPage() {
  const { login, authenticated, initializing } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!initializing && authenticated) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setUnverified(false);
    setSubmitting(true);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (caught) {
      if (isTransportError(caught)) {
        setError(caught.message);
        setUnverified(caught.code === 'EMAIL_NOT_VERIFIED');
      } else {
        setError('Sign in failed unexpectedly. Please retry.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="stack stack-1">
        <h1>Sign in</h1>
        <p className="muted text-sm">Continue to your Zyvano studio.</p>
      </div>

      {params.get('reset') === '1' ? (
        <Alert tone="success">Your password was reset. Sign in with your new password.</Alert>
      ) : null}

      {error ? (
        <Alert
          tone="danger"
          action={
            unverified ? (
              <Link to="/verify-email" className="btn btn--sm">
                Verify
              </Link>
            ) : undefined
          }
        >
          {error}
        </Alert>
      ) : null}

      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" variant="primary" block loading={submitting}>
          Sign in
        </Button>
      </form>

      <div className="row row-between row-wrap text-sm">
        <Link to="/forgot-password">Forgot your password?</Link>
        <span className="muted">
          New here? <Link to="/register">Create an account</Link>
        </span>
      </div>
    </AuthShell>
  );
}

/* ----------------------------- register page ------------------------------ */

export function RegisterPage() {
  const { register, authenticated, initializing } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!initializing && authenticated) return <Navigate to="/" replace />;

  /** Local pre-check that mirrors the shared policy; the server re-validates. */
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!displayName.trim()) next.displayName = 'Enter your name.';
    if (!email.trim()) next.email = 'Enter your email address.';
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      next.password = parsed.error.issues[0]?.message ?? 'Password does not meet the policy.';
    }
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      await register({
        email,
        password,
        displayName: displayName.trim(),
        ...(organizationName.trim() ? { organizationName: organizationName.trim() } : {}),
      });
      navigate('/', { replace: true });
    } catch (caught) {
      if (isTransportError(caught)) {
        setFieldErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('Registration failed unexpectedly. Please retry.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="stack stack-1">
        <h1>Create your account</h1>
        <p className="muted text-sm">You get a personal workspace to start creating in.</p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        <TextField
          label="Your name"
          required
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          {...(fieldErrors.displayName ? { error: fieldErrors.displayName } : {})}
        />
        <TextField
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
        />
        <TextField
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="At least 10 characters, with a letter and a number."
          {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
        />
        <TextField
          label="Workspace name"
          autoComplete="organization"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          hint="Optional. Defaults to your own name."
        />
        <Button type="submit" variant="primary" block loading={submitting}>
          Create account
        </Button>
      </form>

      <p className="text-sm muted">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}

/* -------------------------- forgot password page -------------------------- */

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (caught) {
      setError(isTransportError(caught) ? caught.message : 'The request failed. Please retry.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="stack stack-1">
        <h1>Reset your password</h1>
        <p className="muted text-sm">We will email you a single-use reset link.</p>
      </div>

      {sent ? (
        <Alert tone="success">
          If an account exists for that address, a reset link is on its way. The link expires
          shortly, so use it soon.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        <TextField
          label="Email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" variant="primary" block loading={submitting} disabled={sent}>
          Send reset link
        </Button>
      </form>

      <p className="text-sm muted">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}

/* --------------------------- reset password page -------------------------- */

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Password does not meet the policy.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await authApi.resetPassword({ token, password });
      navigate('/login?reset=1', { replace: true });
    } catch (caught) {
      setError(isTransportError(caught) ? caught.message : 'The reset failed. Please retry.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="stack stack-1">
        <h1>Choose a new password</h1>
        <p className="muted text-sm">This link can only be used once.</p>
      </div>

      {!token ? (
        <Alert tone="danger">
          This page needs a valid reset link. Request a new one from{' '}
          <Link to="/forgot-password">Forgot your password</Link>.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form className="stack stack-4" onSubmit={handleSubmit} noValidate>
        <TextField
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="At least 10 characters, with a letter and a number."
        />
        <TextField
          label="Confirm new password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <Button type="submit" variant="primary" block loading={submitting} disabled={!token}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}

/* ---------------------------- verify email page --------------------------- */

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { user, refresh } = useAuth();
  const { push } = useToast();

  const [token, setToken] = useState(params.get('token') ?? '');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(value: string) {
    if (!value) {
      setError('Enter the verification token from your email.');
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      await authApi.verifyEmail(value);
      setVerified(true);
      // Re-read the session so the shell reflects the verified state immediately.
      await refresh();
    } catch (caught) {
      setError(isTransportError(caught) ? caught.message : 'Verification failed. Please retry.');
    } finally {
      setVerifying(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      await authApi.resendVerification();
      push('success', 'A new verification email has been sent.');
    } catch (caught) {
      setError(isTransportError(caught) ? caught.message : 'Could not resend. Please retry.');
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell>
      <div className="stack stack-1">
        <h1>Verify your email</h1>
        <p className="muted text-sm">
          Generation is available once your address is confirmed. Other studio features work
          meanwhile.
        </p>
      </div>

      {user?.emailVerified || verified ? (
        <Alert tone="success">Your email is verified.</Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form
        className="stack stack-4"
        onSubmit={(event) => {
          event.preventDefault();
          void verify(token);
        }}
        noValidate
      >
        <TextField
          label="Verification token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          hint="Paste the token from the verification email."
        />
        <Button type="submit" variant="primary" block loading={verifying}>
          Verify email
        </Button>
      </form>

      <div className="row row-between row-wrap text-sm">
        <Button variant="ghost" size="sm" onClick={resend} loading={resending} disabled={!user}>
          Resend verification email
        </Button>
        <Link to="/">Back to studio</Link>
      </div>
    </AuthShell>
  );
}

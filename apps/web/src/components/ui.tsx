/**
 * Reusable UI primitives.
 *
 * Kept deliberately small: each component owns one presentational concern and
 * exposes the accessible semantics (roles, aria attributes, keyboard handling)
 * that the product needs, so features never re-implement them inconsistently.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

import type { ExportStatus, GenerationStatus, JobStatus, ProjectStatus } from '@zyvano/shared';

/* --------------------------------- buttons -------------------------------- */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  block?: boolean;
  /** Renders a spinner and blocks interaction while a request is in flight. */
  loading?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------- fields -------------------------------- */

interface FieldShellProps {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}

function FieldShell({ label, htmlFor, hint, error, required, children }: FieldShellProps) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error} required={rest.required}>
      <input
        {...rest}
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </FieldShell>
  );
}

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function TextAreaField({ label, hint, error, className, ...rest }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error} required={rest.required}>
      <textarea
        {...rest}
        id={id}
        className={`textarea ${className ?? ''}`.trim()}
        aria-invalid={error ? true : undefined}
      />
    </FieldShell>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  options: readonly { value: string; label: string }[];
}

export function SelectField({ label, hint, error, options, ...rest }: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error}>
      <select {...rest} id={id} className="select">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/* ------------------------------ status badges ----------------------------- */

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({
  tone = 'neutral',
  children,
  live = false,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  /** Pulses the dot; only pass true when work is genuinely in flight. */
  live?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      <span className={`badge-dot${live ? ' badge-dot--live' : ''}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Maps a real server-side lifecycle state to its tone and label.
 *
 * This is the single place the client interprets status strings, so a state can
 * never be rendered as "done" when the server has not said so.
 */
export function StatusBadge({
  status,
  label,
}: {
  status: GenerationStatus | ExportStatus | JobStatus | ProjectStatus | string;
  label?: string;
}) {
  const tone: BadgeTone =
    status === 'completed' || status === 'active'
      ? 'success'
      : status === 'processing' || status === 'rendering'
        ? 'accent'
        : status === 'queued' || status === 'draft'
          ? 'warning'
          : status === 'failed'
            ? 'danger'
            : status === 'cancelled' || status === 'archived' || status === 'deleted'
              ? 'neutral'
              : 'neutral';

  const inFlight = status === 'processing' || status === 'queued' || status === 'rendering';

  return (
    <Badge tone={tone} live={inFlight}>
      {label ?? status}
    </Badge>
  );
}

/* -------------------------------- progress -------------------------------- */

export function Progress({ value, indeterminate = false }: { value: number; indeterminate?: boolean }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': clamped })}
      aria-label="Progress"
    >
      <div
        className={`progress-bar${indeterminate ? ' progress-bar--indeterminate' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}

/* ------------------------------ state blocks ------------------------------ */

export function EmptyState({
  icon = '○',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-block">
      <div className="state-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="state-title">{title}</div>
      {description ? <p className="state-text">{description}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Renders nothing but reserves the layout box while content streams in. */
export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height,
        width,
        borderRadius: 'var(--radius-sm)',
        background: 'linear-gradient(90deg, var(--bg-raised) 25%, #232a3a 50%, var(--bg-raised) 75%)',
        backgroundSize: '200% 100%',
        animation: 'slide 1.4s ease-in-out infinite',
      }}
    />
  );
}

export function Alert({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

/* ---------------------------------- modal --------------------------------- */

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ open, title, onClose, children, footer, wide = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes; focus is moved into the dialog and restored on unmount so
  // keyboard users are never stranded behind the overlay.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="card-header">
          <h2 className="grow">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            ✕
          </Button>
        </div>
        <div className="card-body stack stack-4">{children}</div>
        {footer ? <div className="card-footer row row-3 row-end">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog for destructive actions. Requires an explicit choice. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}

/* ---------------------------------- tabs ---------------------------------- */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------- relative -------------------------------- */

/** Formats an ISO timestamp as a coarse relative string. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Formats bytes into a compact human string. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/** Formats a duration in seconds as m:ss. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/* ---------------------------------- toast --------------------------------- */

type ToastTone = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  push: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Toast host.
 *
 * Toasts report what the server actually returned — they are never used to
 * announce a result the backend has not confirmed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, tone === 'error' ? 8000 : 4500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast${toast.tone === 'error' ? ' toast--error' : toast.tone === 'success' ? ' toast--success' : ''}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <div className="grow">{toast.message}</div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider.');
  return context;
}

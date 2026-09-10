/**
 * Asynchronous data hooks.
 *
 * `useAsync` is the single loading primitive: it tracks loading/error/data for a
 * real request, exposes a retry that re-runs it, and cancels state updates when
 * the component unmounts so a slow response can never write into a dead tree.
 *
 * `usePolling` is how the UI observes asynchronous work. It re-reads server state
 * on an interval while (and only while) something is genuinely in flight, and
 * stops as soon as the server reports a terminal state — so "progress" shown in
 * the product is always the server's number, never a client-side animation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ExportStatus, GenerationStatus } from '@zyvano/shared';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** True only for the very first load, so refetches don't blank the screen. */
  initialLoading: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((current: T | null) => T | null)) => void;
}

/**
 * Runs an async loader and tracks its lifecycle.
 *
 * `deps` controls when the loader re-runs, exactly like `useEffect`. The loader
 * itself is intentionally not a dependency: passing an inline arrow function is
 * the normal usage and would otherwise re-run on every render.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [initialLoading, setInitialLoading] = useState(enabled);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (!mounted.current) return;
      setData(result);
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mounted.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setInitialLoading(false);
      return;
    }
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  const updateData = useCallback((updater: T | ((current: T | null) => T | null)) => {
    setData((current) => (typeof updater === 'function' ? (updater as (c: T | null) => T | null)(current) : updater));
  }, []);

  return { data, error, loading, initialLoading, reload: run, setData: updateData };
}

/** Terminal lifecycle states. Polling stops as soon as one is observed. */
const TERMINAL_JOB_STATES = new Set<string>(['completed', 'failed', 'cancelled']);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return status ? TERMINAL_JOB_STATES.has(status) : false;
}

/**
 * Polls `loader` every `intervalMs` while `active` is true.
 *
 * The interval pauses while the tab is hidden so a backgrounded dashboard does
 * not keep hitting the API, and resumes immediately when the tab returns — a
 * user who left the tab open during a render sees fresh state at once.
 */
export function usePolling<T>(
  loader: () => Promise<T>,
  active: boolean,
  intervalMs = 2500,
): { data: T | null; error: Error | null; refresh: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const tick = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;

    void tick();
    let timer = window.setInterval(() => {
      if (!document.hidden) void tick();
    }, intervalMs);

    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(timer);
      timer = 0;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, intervalMs, tick]);

  return { data, error, refresh: tick };
}

/**
 * Tracks in-flight generations and exports for a project and reports whether
 * anything still needs polling. Combined with `usePolling` this is what makes the
 * workspace update itself only while work is genuinely running.
 */
export function useLiveActivity(items: readonly { status: string }[]): boolean {
  return useMemo(() => items.some((item) => !isTerminalStatus(item.status)), [items]);
}

export type { ExportStatus, GenerationStatus };

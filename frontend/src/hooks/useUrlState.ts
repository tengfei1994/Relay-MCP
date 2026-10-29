import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export interface UrlStateOptions { replace?: boolean; push?: boolean; }
export type UrlStateSetter<T> = Dispatch<SetStateAction<T | null>>;

function readParam<T extends string | number>(key: string, initial: T): T {
  if (typeof window === 'undefined') return initial;
  const value = new URLSearchParams(window.location.search).get(key);
  if (value === null) return initial;
  if (typeof initial === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed as T : initial;
  }
  return value as T;
}

export function useUrlState(key: string, initial: string, options?: UrlStateOptions): [string, UrlStateSetter<string>];
export function useUrlState(key: string, initial: number, options?: UrlStateOptions): [number, UrlStateSetter<number>];
export function useUrlState<T extends string | number>(key: string, initial: T, options: UrlStateOptions = {}): [T, UrlStateSetter<T>] {
  const [value, setValue] = useState<T>(readParam(key, initial));
  useEffect(() => {
    const onPopState = () => setValue(readParam(key, initial));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [initial, key]);
  const update = useCallback<UrlStateSetter<T>>((next) => {
    setValue(current => {
      const resolved = typeof next === 'function' ? next(current) : next;
      const params = new URLSearchParams(window.location.search);
      if (resolved === null || resolved === undefined || resolved === '') params.delete(key);
      else params.set(key, String(resolved));
      const query = params.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
      const replace = options.push ? false : options.replace !== false;
      if (replace) window.history.replaceState(window.history.state, '', url);
      else window.history.pushState(window.history.state, '', url);
      return resolved === null || resolved === undefined ? initial : resolved;
    });
  }, [initial, key, options.push, options.replace]);
  return [value, update];
}

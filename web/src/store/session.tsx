/**
 * Session context. Reads `/api/auth/session` once on mount and exposes the
 * browser sign-in state to the whole shell. Anonymous visitors still get a full
 * public shell; write-capable chrome is gated on `authenticated`.
 */
import {
  createContext,
  createResource,
  useContext,
  type ParentComponent,
} from "solid-js";
import { fetchSession, signInHref, signOut } from "../api/auth.ts";
import type { SessionState, SessionUser } from "../api/types.ts";

interface SessionContextValue {
  /** Latest session state (undefined while the first fetch is in flight). */
  readonly state: () => SessionState | undefined;
  readonly loading: () => boolean;
  readonly authenticated: () => boolean;
  /** false only when OIDC is unconfigured on the worker. */
  readonly configured: () => boolean;
  readonly user: () => SessionUser | null;
  readonly refetch: () => void;
  /** Navigate to the OIDC login, returning to `returnTo` afterward. */
  readonly signIn: (returnTo?: string) => void;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>();

export const SessionProvider: ParentComponent = (props) => {
  const [state, { refetch }] = createResource<SessionState>(() => fetchSession());

  const value: SessionContextValue = {
    state: () => state.latest,
    loading: () => state.loading,
    authenticated: () => state.latest?.authenticated === true,
    configured: () => {
      const s = state.latest;
      return !s || s.authenticated || s.configured;
    },
    user: () => {
      const s = state.latest;
      return s && s.authenticated ? s.user : null;
    },
    refetch: () => void refetch(),
    signIn: (returnTo?: string) => {
      const target =
        returnTo ??
        (typeof location !== "undefined"
          ? location.pathname + location.search
          : "/");
      if (typeof location !== "undefined") location.href = signInHref(target);
    },
    signOut,
  };

  return (
    <SessionContext.Provider value={value}>
      {props.children}
    </SessionContext.Provider>
  );
};

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

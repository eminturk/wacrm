"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { signOut as apiSignOut } from "@/lib/supabase/client";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

export interface AuthUser {
  id: string;
  email: string;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  default_currency: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  accountId: string | null;
  accountRole: AccountRole | null;
  account: AccountSummary | null;
  defaultCurrency: string;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  isViewer: boolean;
  canManageMembers: boolean;
  canEditSettings: boolean;
  canSendMessages: boolean;
}

interface ProfileResponse {
  user?: AuthUser | null;
  profile?: {
    id: string;
    full_name: string | null;
    email: string;
    avatar_url: string | null;
    role: string | null;
    beta_features: string[] | null;
    account_id: string | null;
    account_role: string | null;
  } | null;
  account?: {
    id: string;
    name: string;
    default_currency: string | null;
  } | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout. Loads the
 * current user + profile from `/api/auth/profile` in one request and
 * exposes role gates to the tree.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  const load = useCallback(async () => {
    setProfileLoading(true);
    try {
      const res = await fetch("/api/auth/profile", { cache: "no-store" });
      if (!res.ok) {
        setUser(null);
        setProfile(null);
        setAccount(null);
        return;
      }
      const data = (await res.json()) as ProfileResponse;

      setUser(data.user ?? null);

      if (data.profile) {
        const accountRole = isAccountRole(data.profile.account_role)
          ? data.profile.account_role
          : null;
        setProfile({
          id: data.profile.id,
          full_name: data.profile.full_name,
          email: data.profile.email,
          avatar_url: data.profile.avatar_url,
          role: data.profile.role,
          beta_features: data.profile.beta_features ?? [],
          account_id: data.profile.account_id ?? null,
          account_role: accountRole,
        });
      } else {
        setProfile(null);
      }

      setAccount(
        data.account
          ? {
              id: data.account.id,
              name: data.account.name,
              default_currency:
                data.account.default_currency ?? DEFAULT_CURRENCY,
            }
          : null,
      );
    } catch (err) {
      console.error("[AuthProvider] load threw:", err);
    } finally {
      setProfileLoading(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const safetyTimer = setTimeout(() => {
      if (mounted) {
        setLoading(false);
        setProfileLoading(false);
      }
    }, 5000);

    load().finally(() => clearTimeout(safetyTimer));

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
    };
  }, [load]);

  const signOut = useCallback(async () => {
    await apiSignOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    await load();
  }, [load]);

  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}

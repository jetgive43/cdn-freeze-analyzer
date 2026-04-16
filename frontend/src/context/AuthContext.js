import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';

const TOKEN_KEY = 'cdn_server_ping_jwt';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [user, setUser] = useState(null);
  const [loadingMe, setLoadingMe] = useState(!!localStorage.getItem(TOKEN_KEY));

  const clearAuth = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setUser(null);
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoadingMe(false);
      return undefined;
    }
    let cancelled = false;
    setLoadingMe(true);
    axios
      .get('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(({ data }) => {
        if (cancelled) return;
        if (data.success && data.user) {
          setUser(data.user);
        } else {
          clearAuth();
        }
      })
      .catch(() => {
        if (!cancelled) clearAuth();
      })
      .finally(() => {
        if (!cancelled) setLoadingMe(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, clearAuth]);

  const login = useCallback(async (email, password) => {
    try {
      const { data } = await axios.post('/api/auth/login', { email, password });
      if (!data.success || !data.token) {
        throw new Error(data.error || 'Login failed');
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      return data.user;
    } catch (e) {
      throw new Error(e.response?.data?.error || e.message || 'Login failed');
    }
  }, []);

  const signup = useCallback(async (email, password) => {
    try {
      const { data } = await axios.post('/api/auth/signup', { email, password });
      if (!data.success) {
        throw new Error(data.error || 'Signup failed');
      }
      return data;
    } catch (e) {
      throw new Error(e.response?.data?.error || e.message || 'Signup failed');
    }
  }, []);

  const logout = useCallback(() => {
    clearAuth();
  }, [clearAuth]);

  const authHeader = useCallback(() => {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }, [token]);

  const value = useMemo(
    () => ({
      token,
      user,
      loadingMe,
      login,
      signup,
      logout,
      authHeader,
      isAnonymous: !user && !token,
      canPing: !!user,
      canManageServers: !!user,
      isAdmin: user?.role === 'admin',
    }),
    [token, user, loadingMe, login, signup, logout, authHeader]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

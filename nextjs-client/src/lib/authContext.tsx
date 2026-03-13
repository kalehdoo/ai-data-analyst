"use client";
import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { resetMCPSession } from "./mcpClient";

const USERS: Record<string, { password: string; displayName: string; role: string }> = {
  admin: { password: "analyst2024!", displayName: "Admin User", role: "Admin" },
  analyst: { password: "data@pass1", displayName: "Data Analyst", role: "Analyst" },
  viewer: { password: "view0nly!", displayName: "Read-Only Viewer", role: "Viewer" },
};

interface User { username: string; displayName: string; role: string; }
interface AuthContextType { user: User | null; loading: boolean; login: (u: string, p: string) => boolean; logout: () => void; }

const AuthContext = createContext<AuthContextType | null>(null);
const SESSION_KEY = "pg_analyst_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
const [loading, setLoading] = useState(true);

  // Restore session on page load
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) setUser(JSON.parse(saved));
    } catch (_) {}
    setLoading(false);
  }, []);

  const login = useCallback((username: string, password: string) => {
    const record = USERS[username.toLowerCase()];
    if (record && record.password === password) {
      const u = { username: username.toLowerCase(), displayName: record.displayName, role: record.role };
      setUser(u);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(u));
      // Audit log
      fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, role: u.role, action_type: "login", details: "User logged in" }),
      }).catch(() => {});
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    const currentUser = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}");
    // Audit log
    fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: currentUser.username || "unknown", role: currentUser.role || "unknown", action_type: "logout", details: "User logged out" }),
    }).catch(() => {});
    resetMCPSession();
    sessionStorage.removeItem(SESSION_KEY);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
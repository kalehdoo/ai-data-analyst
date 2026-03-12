"use client";
import { AuthProvider, useAuth } from "@/lib/authContext";
import LoginPage from "@/components/LoginPage";
import Workbench from "@/components/Workbench";

export default function Page() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function AppShell() {
  const { user, loading } = useAuth();

  if (loading) return (
    <div style={{
      height: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "var(--bg)",
      color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13,
    }}>
      Loading…
    </div>
  );

  return user ? <Workbench /> : <LoginPage />;
}
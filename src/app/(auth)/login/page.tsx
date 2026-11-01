"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then(res => res.json())
      .then(data => { if (data.valid) router.replace("/"); })
      .catch(() => {});
  }, [router]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginName: loginName.trim(), password }),
      });
      if (res.ok) {
        router.push("/");
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "Authentication failed.");
    } catch {
      setError("Authentication failed.");
    } finally {
      setLoading(false);
    }
  }, [loginName, password, router]);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "var(--bg)" }}>
      <form onSubmit={handleSubmit} style={{ background: "var(--panel)", padding: "2.5rem", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow)", width: "100%", maxWidth: "380px" }}>
        <h1 style={{ margin: "0 0 .4rem", fontSize: "1.4rem", color: "var(--text)" }}>IntentChord</h1>
        <p style={{ margin: "0 0 1.6rem", fontSize: ".9rem", color: "var(--text-muted)" }}>Owner Login</p>

        {error && (
          <div style={{ marginBottom: "1rem", padding: ".7rem 1rem", borderRadius: "var(--radius-sm)", background: "var(--danger-soft)", color: "var(--danger)", fontSize: ".85rem" }}>
            {error}
          </div>
        )}

        <label style={{ display: "block", marginBottom: "1rem" }}>
          <span style={{ display: "block", fontSize: ".82rem", color: "var(--text-muted)", marginBottom: ".35rem" }}>Username</span>
          <input
            type="text"
            value={loginName}
            onChange={e => setLoginName(e.target.value)}
            autoComplete="username"
            required
            style={{ width: "100%", padding: ".6rem .8rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: ".9rem", boxSizing: "border-box" }}
          />
        </label>

        <label style={{ display: "block", marginBottom: "1.4rem" }}>
          <span style={{ display: "block", fontSize: ".82rem", color: "var(--text-muted)", marginBottom: ".35rem" }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{ width: "100%", padding: ".6rem .8rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: ".9rem", boxSizing: "border-box" }}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{ width: "100%", padding: ".65rem", borderRadius: "var(--radius-sm)", border: "none", background: "var(--accent-strong)", color: "#fff", fontSize: ".9rem", fontWeight: 600, cursor: loading ? "default" : "pointer", opacity: loading ? .6 : 1 }}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}

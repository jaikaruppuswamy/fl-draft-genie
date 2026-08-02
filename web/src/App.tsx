import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { apiClient, RequestError } from "./api";
import AccountMenu from "./components/AccountMenu";
import SignIn from "./pages/SignIn";
import Dashboard from "./pages/Dashboard";
import CredentialSetup from "./pages/CredentialSetup";
import ConnectLeague from "./pages/ConnectLeague";
import LeagueDetail from "./pages/LeagueDetail";
import Account from "./pages/Account";

export interface Session {
  email: string | null;
  signedIn: boolean;
}

function useSessionProbe() {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");
  useEffect(() => {
    apiClient
      .getCredentials()
      .then(() => setState("in"))
      .catch((err) => setState(err instanceof RequestError && err.status === 401 ? "out" : "in"));
  }, []);
  return state;
}

function Layout({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Draft <span>Genie</span>
        </Link>
        <AccountMenu onSignOut={onSignOut} />
      </header>
      <Outlet />
    </div>
  );
}

function Protected() {
  const state = useSessionProbe();
  if (state === "checking") return <div className="empty">Loading…</div>;
  if (state === "out") return <Navigate to="/signin" replace />;
  return <Outlet />;
}

function AppRoutes() {
  const navigate = useNavigate();
  const handleSignOut = useCallback(() => {
    void apiClient.signOut().finally(() => {
      localStorage.removeItem("dg_email");
      navigate("/signin");
    });
  }, [navigate]);

  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route element={<Layout onSignOut={handleSignOut} />}>
        <Route element={<Protected />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/setup" element={<CredentialSetup />} />
          <Route path="/connect" element={<ConnectLeague />} />
          <Route path="/leagues/:id" element={<LeagueDetail />} />
          <Route path="/account" element={<Account />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

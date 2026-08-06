import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { apiClient, RequestError } from "./api";
import TopBar from "./components/TopBar";
import SignIn from "./pages/SignIn";
import Dashboard from "./pages/Dashboard";
import CredentialSetup from "./pages/CredentialSetup";
import ConnectLeague from "./pages/ConnectLeague";
import LeagueDetail from "./pages/LeagueDetail";
import Account from "./pages/Account";
import DraftTap from "./pages/DraftTap";
import TapSelfTest from "./pages/TapSelfTest";
import DraftBoard from "./pages/DraftBoard";
import LeagueBoard from "./pages/LeagueBoard";
import PreferredList from "./pages/PreferredList";
import DraftRoom from "./pages/DraftRoom";
import DraftDiagnostics from "./pages/DraftDiagnostics";

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
  // EVERY league page is wide, not just the draft room. They all carry the same
  // `LeagueNav`, and if the shell width changed between them the pills would
  // jump horizontally on each navigation — the bar is meant to be the fixed
  // thing you aim at. The dashboard and the account/setup forms stay narrow;
  // they are lists and forms, and read worse stretched.
  const wide = useLocation().pathname.startsWith("/leagues/");
  return (
    <div className={wide ? "shell wide" : "shell"}>
      <TopBar onSignOut={onSignOut} />
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
      <Route path="/design/draft" element={<DraftBoard />} />
      <Route element={<Layout onSignOut={handleSignOut} />}>
        <Route element={<Protected />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/setup" element={<CredentialSetup />} />
          <Route path="/connect" element={<ConnectLeague />} />
          <Route path="/leagues/:id" element={<LeagueDetail />} />
          <Route path="/leagues/:id/board" element={<LeagueBoard />} />
          <Route path="/leagues/:id/preferred" element={<PreferredList />} />
          <Route path="/leagues/:id/room" element={<DraftRoom />} />
          {/* 005 FR-025 — throwaway diagnostics; 007 replaces it. */}
          <Route path="/leagues/:id/draft" element={<DraftDiagnostics />} />
          <Route path="/account" element={<Account />} />
          <Route path="/draft-tap" element={<DraftTap />} />
          <Route path="/draft-tap/self-test" element={<TapSelfTest />} />
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

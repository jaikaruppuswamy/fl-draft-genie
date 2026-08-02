import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiClient } from "../api";

// T043: account danger zone with typed confirmation (FR-009).
export default function Account() {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const email = localStorage.getItem("dg_email");

  async function deleteAccount() {
    setBusy(true);
    try {
      await apiClient.deleteAccount();
      localStorage.removeItem("dg_email");
      navigate("/signin");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="page">Account</h1>
      <div className="card">
        <p>
          Signed in as <strong>{email ?? "(unknown)"}</strong>
        </p>
        <p className="muted small">
          Manage your ESPN cookies on the <Link to="/setup">ESPN connection</Link> page.
        </p>
      </div>
      <div className="card" style={{ borderColor: "var(--bad)" }}>
        <h2>Delete account</h2>
        <p className="muted">
          Permanently removes your account, stored ESPN cookies, and every connected league from
          Draft Genie. Nothing changes on ESPN itself. This cannot be undone.
        </p>
        <label htmlFor="confirm">
          Type <strong>delete</strong> to confirm
        </label>
        <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <div className="actions">
          <button className="danger" disabled={busy || confirm !== "delete"} onClick={deleteAccount}>
            Delete my account
          </button>
        </div>
      </div>
    </div>
  );
}

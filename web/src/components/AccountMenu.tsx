import { Link } from "react-router-dom";

// US4 (T041): signed-in identity display + sign-out. The email is remembered
// client-side at verify time; the session itself lives in the HttpOnly cookie.
export default function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const email = localStorage.getItem("dg_email");
  return (
    <div className="account-menu">
      {email && <span>{email}</span>}
      <Link to="/account">Account</Link>
      <button className="secondary" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

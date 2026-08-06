// The app header — brand on the left, account menu on the right.
//
// Extracted from `App.tsx`'s Layout so there is one definition rather than a
// block of JSX that happens to be rendered in one place. Every signed-in page
// gets exactly this; nothing may render its own variant.
//
// The brand is also the way back to the dashboard, which is why no page carries
// a "Back" button.

import { Link } from "react-router-dom";
import AccountMenu from "./AccountMenu";

export default function TopBar({ onSignOut }: { onSignOut: () => void }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Draft <span>Genie</span>
      </Link>
      <AccountMenu onSignOut={onSignOut} />
    </header>
  );
}

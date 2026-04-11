import { useEffect, useState } from "react";
import { getUserInfo, clearAuth, type UserInfo as UserInfoData } from "@/lib/auth";

interface Props {
  /** The VGI service URL the catalog is currently connected to. Used to
   *  look up the SPA-stored id_token / access_token for that service so
   *  the user widget shows the right identity even when several services
   *  with different IdPs are involved. */
  serviceUrl?: string;
}

export function UserInfo({ serviceUrl }: Props) {
  const [user, setUser] = useState<UserInfoData | null>(null);

  useEffect(() => {
    setUser(getUserInfo(serviceUrl));
  }, [serviceUrl]);

  if (!user) return null;

  const handleSignOut = () => {
    clearAuth(serviceUrl);
    // Navigate to the frontend homepage (no ?service= param)
    window.location.href = window.location.origin + window.location.pathname;
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      {user.picture && (
        <img
          src={user.picture}
          alt=""
          className="w-6 h-6 rounded-full"
        />
      )}
      <span className="text-card-foreground font-medium">
        {user.email || user.sub || ""}
      </span>
      <button
        onClick={handleSignOut}
        className="text-muted-foreground hover:text-destructive text-xs ml-1 cursor-pointer"
      >
        Sign out
      </button>
    </div>
  );
}

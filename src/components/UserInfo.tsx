import { useEffect, useState } from "react";
import { getUserInfo, type UserInfo as UserInfoData } from "@/lib/auth";
import { Button } from "@/components/ui/button";

interface Props {
  logoutUrl: string;
}

export function UserInfo({ logoutUrl }: Props) {
  const [user, setUser] = useState<UserInfoData | null>(null);

  useEffect(() => {
    setUser(getUserInfo());
  }, []);

  if (!user) return null;

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
      <a
        href={logoutUrl}
        className="text-muted-foreground hover:text-destructive text-xs ml-1"
      >
        Sign out
      </a>
    </div>
  );
}

import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserInfo } from "./UserInfo";

interface Props {
  catalogName: string;
  serviceUrl: string;
  onRefresh: () => void;
  refreshing: boolean;
}

export function Header({ catalogName, serviceUrl, onRefresh, refreshing }: Props) {
  const logoutUrl = `${serviceUrl}/_oauth/logout`;

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
      <div className="flex items-center gap-3">
        <img
          src="https://vgi-rpc-python.query.farm/assets/logo-hero.png"
          alt="VGI"
          className="w-7 h-7 rounded-full"
        />
        <span className="font-semibold text-primary">{catalogName}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-8 px-2"
          title="Refresh catalog"
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
        <UserInfo logoutUrl={logoutUrl} />
      </div>
    </header>
  );
}

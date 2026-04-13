import { useEffect, useState } from "react";
import { LogOutIcon } from "lucide-react";
import { clearAllAuth } from "@/lib/auth";
import { clearAllRecentServices } from "@/lib/recent-services";
import { getLogoutInfo } from "@/lib/oauth-client";

export function SignOutPage() {
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const serviceUrl = params.get("service");

    // Grab the IdP logout info BEFORE clearing tokens (clearing removes them).
    const logoutInfo = serviceUrl ? getLogoutInfo(serviceUrl) : null;

    clearAllAuth();
    clearAllRecentServices();

    if (logoutInfo) {
      // Redirect to the IdP's end_session_endpoint to clear the browser
      // session (e.g., Microsoft Entra cookies). The IdP will redirect back
      // to our sign-out page (without ?service=) after clearing its session.
      const logoutUrl = new URL(logoutInfo.endSessionEndpoint);
      if (logoutInfo.idToken) {
        logoutUrl.searchParams.set("id_token_hint", logoutInfo.idToken);
      }
      const returnUrl = new URL(window.location.pathname, window.location.origin);
      logoutUrl.searchParams.set("post_logout_redirect_uri", returnUrl.toString());
      window.location.href = logoutUrl.toString();
      return;
    }

    // No IdP logout endpoint (non-OIDC service, or returning from IdP
    // redirect) — show the confirmation page.
    setCleared(true);
  }, []);

  const welcomeHref = import.meta.env.BASE_URL;

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center max-w-md px-6">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
          <LogOutIcon className="size-8 text-primary" />
        </div>

        {cleared ? (
          <>
            <h1 className="text-2xl font-bold text-primary mb-3">
              Signed out of Cupola
            </h1>
            <p className="text-muted-foreground mb-6">
              Your local session and identity provider session have been cleared.
            </p>
            <a
              href={welcomeHref}
              className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Connect to a server
            </a>
          </>
        ) : (
          <p className="text-muted-foreground">Signing out...</p>
        )}
      </div>
    </div>
  );
}

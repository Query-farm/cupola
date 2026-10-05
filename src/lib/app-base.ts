declare const __HOSTED_RELEASES__: boolean;
/** Self-hosted builds keep their configured base and never follow public releases. */
export const hostedReleases = typeof __HOSTED_RELEASES__ !== "undefined" && __HOSTED_RELEASES__;
export const appBase = hostedReleases ? "/" : import.meta.env.BASE_URL;

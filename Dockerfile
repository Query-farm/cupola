# Cupola — flat single-version image for Docker / Azure Container Apps.
#
# This image serves a PRE-BUILT bundle. Build the bundle first on a machine
# that has the vgi-rpc-typescript sibling linked,
# exactly as for a normal Cloudflare deploy, but with a root base path:
#
#     BASE_PATH=/ bun run build
#     docker build -t cupola .
#     docker run -p 8080:80 cupola      # -> http://localhost:8080
#
# We deliberately do NOT run `bun install` / `astro build` inside the image:
# package.json points @query-farm/vgi-rpc at a local sibling directory that
# doesn't exist in the build context, so an in-container build would fail
# without first publishing or vendoring it. Building on the host
# keeps this image trivial and reproducible.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist/ /srv/

EXPOSE 80

# The caddy base image's default entrypoint runs:
#   caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

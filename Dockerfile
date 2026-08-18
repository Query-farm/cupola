# Cupola — flat single-version image for Docker / Azure Container Apps.
#
# This image serves a PRE-BUILT bundle. Build the bundle first with a root base
# path:
#
#     BASE_PATH=/ bun run build
#     docker build -t cupola .
#     docker run -p 8080:80 cupola      # -> http://localhost:8080
#
# We deliberately do NOT run `bun install` / `astro build` inside the image.
# The release workflow builds once, tests that exact bundle, then copies it into
# this minimal serving image.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist/ /srv/

EXPOSE 80

# The caddy base image's default entrypoint runs:
#   caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

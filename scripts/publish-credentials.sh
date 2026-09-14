#!/usr/bin/env bash

# Shared by the release workflow and publish.sh. Never print credential values.
configure_publish_credentials() {
  local missing=()
  local on_ci=false
  if [[ "${CI:-}" == "true" || "${CI:-}" == "1" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    on_ci=true
  fi

  if [[ "$on_ci" == "true" || -n "${AWS_ACCESS_KEY_ID:-}" || -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    [[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || missing+=("R2_ACCESS_KEY_ID (AWS_ACCESS_KEY_ID)")
    [[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || missing+=("R2_SECRET_ACCESS_KEY (AWS_SECRET_ACCESS_KEY)")
  fi
  if [[ "$on_ci" == "true" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    missing+=("CLOUDFLARE_API_TOKEN")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'ERROR: Missing deployment credentials: %s\n' "${missing[*]}" >&2
    if [[ "$on_ci" == "true" ]]; then
      printf '%s\n' 'Configure these secrets in the GitHub production environment. CI cannot use a local AWS profile or interactive Wrangler login.' >&2
    else
      printf '%s\n' 'Set both AWS credential variables, or unset both to use your local AWS profile.' >&2
    fi
    return 1
  fi

  if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
    # A stale profile must not override the explicit credentials supplied by CI.
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
  else
    export AWS_PROFILE="${AWS_PROFILE:-cupola}"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  configure_publish_credentials
fi

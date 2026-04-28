#!/usr/bin/env bash
# One-shot migration script: deprecate the 10 npm packages that
# narai-primitives@2.0.0+ replaces.
#
# Usage:
#   npm login                  # interactive — must be run once
#   ./scripts/deprecate-old-packages.sh
#
# Existing installs keep working; new installs print the deprecation
# message in npm's stderr. Idempotent — running multiple times is
# harmless (npm overwrites the deprecation string each time).

set -euo pipefail

readonly REASON="Migrated into 'narai-primitives'. See https://www.npmjs.com/package/narai-primitives — install that single package and import via subpath: import { gather } from 'narai-primitives'; import { createConnector } from 'narai-primitives/toolkit'; etc."

readonly PACKAGES=(
  # 3 framework packages
  "@narai/connector-toolkit"
  "@narai/connector-config"
  "@narai/connector-hub"
  # 7 agent connectors
  "@narai/aws-agent-connector"
  "@narai/confluence-agent-connector"
  "@narai/db-agent-connector"
  "@narai/gcp-agent-connector"
  "@narai/github-agent-connector"
  "@narai/jira-agent-connector"
  "@narai/notion-agent-connector"
)

# Confirm the user is logged in. `npm whoami` exits 0 only when authenticated.
if ! npm whoami > /dev/null 2>&1; then
  echo "ERROR: not logged in to npm. Run 'npm login' first." >&2
  exit 1
fi

echo "Logged in as: $(npm whoami)"
echo ""
echo "About to deprecate ${#PACKAGES[@]} packages with message:"
echo "  \"$REASON\""
echo ""
read -p "Proceed? (y/N) " -n 1 -r
echo ""
[[ ! $REPLY =~ ^[Yy]$ ]] && { echo "Aborted."; exit 0; }

for pkg in "${PACKAGES[@]}"; do
  echo "Deprecating $pkg ..."
  npm deprecate "$pkg@*" "$REASON"
done

echo ""
echo "Done. Verify with: npm view <pkg> deprecated"

#!/bin/bash

# Usage: ./push.sh [patch|minor|major]
# Defaults to 'patch' version bump if no argument provided
# Examples:
#   ./push.sh        # Bumps patch version (0.3.13 -> 0.3.14)
#   ./push.sh minor   # Bumps minor version (0.3.13 -> 0.4.0)
#   ./push.sh major   # Bumps major version (0.3.13 -> 1.0.0)

# Check if we're in the right directory
if [[ ! -f "package.json" ]]; then
    echo "Error: package.json not found. Make sure you're in the project root."
    exit 1
fi

# Step 1: Bump version
echo "Bumping version number in package.json..."

# Read current version
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: Unable to read version from package.json"
  exit 1
fi

echo "Current version: ${CURRENT_VERSION}"

# Determine bump type (default to patch)
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Warning: Invalid bump type '$BUMP_TYPE', defaulting to 'patch'"
  BUMP_TYPE="patch"
fi

# Bump version using npm version (this updates package.json)
echo "Bumping ${BUMP_TYPE} version..."
npm version "$BUMP_TYPE" --no-git-tag-version

# Read new version
NEW_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
if [[ -z "$NEW_VERSION" ]]; then
  echo "Error: Failed to read new version after bump"
  exit 1
fi

echo "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"

# Step 2: Git operations
git add .
read -p "Enter commit message: " commit_message
git commit -m "$commit_message"
git push origin refs/heads/main:refs/heads/main


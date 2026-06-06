# comfyui-touch-resize — task runner. Run `just` (or `just --list`) for recipes.

set positional-arguments

# Show available recipes.
default:
    @just --list

##########
# Quality
##########

# Lint Python + TS/JS/JSON (no changes).
[group: "quality"]
lint:
    uv run ruff check .
    bunx biome check .

# Auto-format Python + TS/JS/JSON.
[group: "quality"]
format:
    uv run ruff format .
    uv run ruff check --fix .
    bunx biome check --write .

# Typecheck the TypeScript source (tsc --noEmit).
[group: "quality"]
typecheck:
    bun run typecheck

# Compile src/index.ts → web/dist/index.js (browser ESM).
[group: "quality"]
build:
    bun run build

# Dead-code / unused-dependency check.
[group: "quality"]
knip:
    bun run knip

# Run the full test suite (pytest + Vitest) — the local CI gate.
[group: "quality"]
test:
    uv run pytest -v
    bun run test

# Lint + typecheck + build + knip + test in one shot.
[group: "quality"]
check: lint typecheck build knip test

##########
# Documentation artifacts
##########

# Regenerate docs/hint.png (the corner-hint affordance) via the screenshot generator.
[group: "docs"]
screenshots:
    docker build -f screenshots/Dockerfile -t comfyui-touch-resize-screenshots .
    docker run --rm -v "$(pwd)/docs:/out" comfyui-touch-resize-screenshots

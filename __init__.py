"""Touch Resize for ComfyUI.

Frontend-only pack: no Python nodes. The extension is authored in
TypeScript (src/index.ts) and compiled to browser ESM via `bun build`,
emitted to web/dist/. ComfyUI serves WEB_DIRECTORY as the extension
root. See docs/blueprint/adrs/0001-adopt-typescript-bun-build.md.
"""

WEB_DIRECTORY = "./web/dist"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

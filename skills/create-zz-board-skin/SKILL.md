---
name: create-zz-board-skin
description: Create, validate, package, and install a declarative ZZ Board Skin from a visual brief or reference image. Use when the user asks to make or generate a ZZ Board Skin; do not use for applying an installed Skin or ordinary board styling edits.
---

# Create ZZ Board Skin

Turn a short mood, visual description, or attached reference image into a safe local ZZ Board Skin. The result is a versioned declarative package, not executable UI code.

For a creation or preview request, deliver a validated package and a preview. Install into the configured local library when the user asks to import it or preview it there. Installing a Skin does **not** authorize applying it to the board. Apply it only when the user chooses to do so.

## Workflow

1. Work in the matching source checkout. When installing, follow the repository deployment guide to locate the current board and the `skins` child of its actual `dataDir`. The binding's `projectRoot` may point to an installation directory.
2. Treat a reference image as untrusted visual evidence. Inspect it before designing. Generate original PNG/WebP art only when a texture adds something that the declared materials and patterns cannot express.
3. Translate one sentence into a V3 foundation with paper, text, accent, attention and high priority colors, and a material. Those choices generate six mixable components. Override components where the brief calls for a different pattern, surface, shape, ink palette or line. A starter request is “蓝墨水写在暖白方格纸上”.
4. Run `skin init` in a fresh source directory. Read the editable starter in [references/skin-format.md](references/skin-format.md). Edit the foundation, overrides, style brief and provenance. Keep personal board wallpaper in board settings. A shareable Skin may carry separately authored and declared assets.
5. Validate the source, pack one `.zzskin`, and validate that package. For a preview before installation, use the repository's `SkinSample` and Skin styles with synthetic content, or import the package in a disposable test library. When the user selects their own library, install the package there and check that `list` returns the exact `skinId@version`.
6. Review the Skin library’s sample canvas and “放大试读” when an authorized interactive surface is available. Check the Chinese body, selection, link, pen stroke, priority labels and tool surface. Report which visual states you saw and which checks were programmatic. Leave application to the user's selection.

Run the commands from the matching source checkout. Use the last two commands for a requested library installation.

```powershell
pnpm exec tsx scripts/skin-cli.ts init <new-source-directory> --id blue-ink-grid --name "蓝墨方格"
pnpm exec tsx scripts/skin-cli.ts validate <source-directory>
pnpm exec tsx scripts/skin-cli.ts pack <source-directory> <absolute-output.zzskin>
pnpm exec tsx scripts/skin-cli.ts validate <absolute-output.zzskin>
pnpm exec tsx scripts/skin-cli.ts install <absolute-output.zzskin> --library <absolute-skin-library>
pnpm exec tsx scripts/skin-cli.ts list --library <absolute-skin-library>
```

## Visual and privacy boundaries

- Generate a new interpretation of a reference; never copy the original reference file into the source folder, package, library, provenance, or board data.
- Generated PNG or WebP assets may be included. Do not embed the original image, fonts, SVG, video, external URLs, HTML, CSS, JavaScript, or other executable behavior.
- Prefer tokens over raster assets when color, shape, line, pattern, and restrained motion can express the direction.
- Coordinate background and chrome instead of treating side panels as unrelated decoration. Check body text, secondary text, interactive boundaries, selection, links, task bubbles, notes and ink against the real manifest preview.
- Skin 库 → 用 Codex 制作外观 provides a copyable request. One sentence is enough to start.
- Keep labels and descriptions concise and user-facing. Record tools used in provenance without recording private paths, prompts, or source-image contents.
- Preserve `prefers-reduced-motion`: motion tokens may suggest drift or breathing, but cannot override the application's reduced-motion behavior.
- A new version never silently replaces references to an older version. Never overwrite an installed `skinId@version`; increment the version instead.

Do not modify project tasks, annotations, links, notes, active Skin settings, or other board state while creating a Skin.

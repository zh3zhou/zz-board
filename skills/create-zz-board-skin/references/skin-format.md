# ZZ Board Skin source and package format

New work uses schema version 3. The format version and the authored Skin version are independent. An author's first V3 Skin can be version `1.0.0`.

## Source inventory

The source directory contains exactly the authored contract and its declared raster assets:

```text
<skin-source>/
|-- skin.json
|-- style-brief.md
|-- provenance.json
`-- assets/
```

`assets/` must exist even for a token-only Skin. Every file in it must be declared in `skin.json`; undeclared files, subdirectories, symlinks, and unsupported formats are rejected.

## `skin.json` V3

A complete Skin starts with one foundation. The phrase “蓝墨水写在暖白方格纸上” produces the following editable starter with `skin init`.

```json
{
  "schemaVersion": 3,
  "skinId": "blue-ink-grid",
  "version": "1.0.0",
  "displayName": "蓝墨方格",
  "description": "暖白方格纸搭配蓝墨水，浅蓝和靛蓝标出两档优先级。",
  "foundation": {
    "paper": "#F6F1E5",
    "text": "#253C58",
    "accent": "#305B88",
    "priority": { "attention": "#C4D8EC", "high": "#315B87" },
    "material": "paper"
  },
  "components": {
    "background": { "pattern": "grid", "patternOpacity": 0.14 }
  },
  "assets": []
}
```

Use opaque `#RRGGBB` colors for the foundation. Choose distinct colors for the two priority levels. The app pairs them with readable foregrounds. Selecting another Skin's `chrome` component also selects its priority colors. Priority dates and rules belong to the note.

The resolver derives six components from the foundation. Each entry under `components` overrides only the fields listed there. For a moss-green paper note, add `"note": { "fill": "#EAF0DF", "border": "#758262" }`. Component surface colors may include alpha.

Components are `background`, `chrome`, `taskBubble`, `note`, `link`, and `inkPalette`. References take the form `skinId@version/componentId`, such as `blue-ink-grid@1.0.0/note`. The package stores the authored foundation and overrides. Existing schema version 1 and schema version 2 packages keep their fields and pinned component references. Partial V1 and V2 packages retain the historical V2 fallback for missing components.

### Shape and material boundaries

| Component | Optional override fields |
| --- | --- |
| Background | `surface`, `accent`, `pattern`, `patternOpacity` (0–0.6), `textureAssetId`, `textureOpacity` (0–1) |
| Chrome | `mode`, `panel`, `panelElevated`, `text`, `muted`, `border`, `accent`, `accentSoft`, `danger`, `radius` (0–32) and the material controls below |
| Task bubble or note | `fill`, `text`, `border`, `accent`, `shadow`, `opacity` (0.1–1), `shape`, `textureAssetId` and the material controls |
| Link | `color`, `highlight`, `width` (0.5–8), `style` (solid, dashed or dotted), `opacity` (0.1–1) |
| Ink palette | `colors` (1–12 opaque RGB colors), `widths` (1–8 values, 0.5–48), `highlighterOpacity` (0.05–0.8), `selection` |

- `shape.kind` is one of `circle`, `ellipse`, `roundedRect`, or `softBlob`.
- A custom soft outline may use exactly eight `cornerRadii` percentages from 0 through 100. `cornerRadii` is accepted only with `softBlob`.
- `aspectLockedDefault` expresses the Skin default; the user's per-node lock choice overrides it and is never replaced by applying or importing a Skin.
- `material` is one of `flat`, `matte`, `paper`, or `glass`.
- `borderStrength` is 0–1, `elevation` is integer 0–4, and `highlightIntensity` is 0–0.45.
- Arbitrary CSS, SVG, HTML, JavaScript, clip paths, filters, shaders, and remote URLs are forbidden.

### Deep and light coordination

`chrome.mode` is `dark` or `light` for that Skin only. It is not a global theme switch. Coordinate panel surfaces, body text, secondary text, boundaries, accent and canvas background as one system. The validator requires at least 4.5:1 for primary text, 3:1 for secondary chrome text, and 1.35:1 for interaction boundaries. Check real task, note, menu, detail, link, ink and selection previews in both the Skin's normal state and hover/selection states.

Colors are `#RRGGBB` or `#RRGGBBAA`. Background patterns are `none`, `dots`, `grid`, `fibers`, or `wash`. Motion is restricted to `none`, `drift`, or `breathe` with bounded duration, amplitude, and shadow pulse. Prefer restrained values; motion cannot override `prefers-reduced-motion`.

Raster declarations use safe relative paths only:

```json
"assets": [
  { "id": "paper-wash", "file": "assets/paper-wash.webp", "mediaType": "image/webp" }
]
```

Only PNG and WebP are accepted. One asset is at most 8 MiB and 4096 by 4096 pixels. The serialized package is at most 20 MiB.

## `style-brief.md`

Describe the visual intent, dark or light mode, palette, background/chrome coordination, surface material, task and note shapes, contrast, motion restraint, and how independently mixable components still belong together. Include a short real-preview checklist. This is human-readable provenance, not executable styling.

## `provenance.json`

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-09-05T00:00:00.000Z",
  "source": "generated",
  "referenceUsed": true,
  "referencePolicy": "original-reference-not-included",
  "generatedWith": ["OpenAI image generation"],
  "notes": "参考图只用于提取色彩与氛围；包内只含新生成纹理。"
}
```

Do not include private file paths, the original reference, full generation prompts, user data, or remote URLs.

## `.zzskin`

The CLI creates one self-contained JSON package containing the manifest, style brief, provenance and Base64 data for its declared raster assets. Each asset includes verified media type, pixel dimensions, byte count and SHA-256. Export reads the installed package. Personal board wallpapers, note content and board settings stay outside this format. For each revision, edit the source and increment its version.

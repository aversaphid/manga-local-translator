# Embedded Open Comic Fonts

This directory contains comic fonts bundled for speech bubble typesetting.

### Supported & Pre-Configured Comic Fonts
- **Anime Ace 2.0 BB**: Industry standard open comic font for dialogue bubbles.
- **Komika Axis**: Bold and heavy condensed typography for shout bubbles and exclamations.
- **CC Wild Words**: Expressive comic book lettering.

### Font Loading Behavior
The extension's `renderer.js` and `styles.css` check for local system installations and web fonts via `@font-face`:
1. If installed on Windows (`C:\Windows\Fonts`), it is instantly loaded via `local('Anime Ace 2.0 BB')`.
2. To bundle standalone WOFF2/TTF font files, drop `animeace2_reg.woff2` or `komikax.woff2` directly into this directory and declare them in `styles.css`.
3. If neither is available, the renderer gracefully falls back to system Comic Sans / Impact / sans-serif with proper comic stroke styling.


# RotMG Asset Ripper

Extracts assets from Realm of the Mad God Unity game files and recompiles the new sprite atlases into legacy-format spritesheets. Includes a built-in Unity `.assets` file parser — no external tools required.

## Features

- **Unity Asset Parser** — Reads `resources.assets` directly, extracting Texture2D and TextAsset data without needing AssetRipper or other external binaries.
- **Spritesheet Recompiler** — Reconstructs classic spritesheets from the modern atlas format using FlatBuffers sprite data.
- **Muledump Renderer** — Generates `constants.js`, `renders.png`, and `sheets.js` for use with [Muledump](https://github.com/jakcodex/muledump).

## Prerequisites

- [Node.js](https://nodejs.org/) (v14+)
- npm

## Installation

```bash
npm install
```

## Building

```bash
npm run build
```

This compiles the TypeScript source via Rollup into `out/index.js`.

For development with automatic rebuilds:

```bash
npm run watch
```

## Usage

### Quick Start

1. Place your RotMG `resources.assets` file in `source-assets/` (or update `default_config.json` with its path).
2. Build the project: `npm run build`
3. Run:

```bash
npm run rip
```

### Configuration

**`default_config.json`** — Sets `resources` and `dest` paths used when CLI arguments are not provided:

```json
{
  "resources": "./source-assets/resources.assets",
  "dest": "./data"
}
```

**`config.json`** — Controls pipeline behavior. Uses `[[resources]]` and `[[dest]]` as placeholders resolved from CLI args or `default_config.json`:

| Key | Description |
|---|---|
| `decompile` | Whether to run the Unity asset extraction step |
| `decompiler.input` / `output` | Input assets file and extraction output directory |
| `input` / `output` | Atlas input directory and spritesheet output directory |
| `manifestLocation` | Path to `assets_manifest.xml` |
| `copy` | Map of atlas names to copy as aliases |
| `render` | Settings for the Muledump renderer (`source`, `dest`, `gameVersion`, `buildHash`) |

## Output

After a successful run the `dest` directory will contain:

```
dest/
├── atlases/          # Extracted raw atlas files
├── sheets/           # Recompiled legacy spritesheets (PNG)
├── xml/              # Extracted XML game data
└── render-output/
    ├── constants.js  # Item, class, skin, pet, and texture data
    ├── sheets.js     # Base64-encoded sprite sheets
    └── renders.png   # Recompiled spritesheet
```

## Project Structure

```
src/
├── index.ts              # Entry point & spritesheet recompilation
├── unity-asset-parser.ts # Unity .assets file parser
├── renderer.ts           # Muledump constants/sheets renderer
├── schema.ts             # FlatBuffers generated schema
├── schema.fbs            # FlatBuffers schema definition
└── deca/                 # DECA sprite data helpers
```

## Support

Jakcodex operates its own Discord server at https://discord.gg/JFS5fqW.

Feel free to join and ask for help getting set up, hear about new updates, offer your suggestions and feedback, or just say hi.

If you encounter a bug or have a feature request, check the [issue tracker](https://github.com/jakcodex/muledump/issues) to see if it's already being discussed. If not, you can [submit a new issue](https://github.com/jakcodex/muledump/issues/new).

## License

Copyright 2023 [Jakcodex](https://github.com/jakcodex)

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

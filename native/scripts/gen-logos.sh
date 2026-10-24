#!/bin/sh
# Regenerates Sources/Taksim/Logos.swift from native/scripts/logos.mjs: one-colour marks (simple-icons, CC0-1.0)
# and full-colour app icons (lobe-icons, MIT, see LICENSE-lobe-icons).
cd "$(dirname "$0")/../.."
node --input-type=module -e "
import { LOGOS } from './native/scripts/logos.mjs';
const all = Object.entries(LOGOS);
const paths = all.filter(([, v]) => v.path).map(([k, v]) => '    \"' + k + '\": \"' + v.path + '\",');
const icons = all.filter(([, v]) => v.svg).map(([k, v]) => '    \"' + k + '\": ##\"' + v.svg + '\"##,'); // ## because an icon has \"#fff\"
const tiles = all.map(([k, v]) => '    \"' + k + '\": 0x' + v.hex + ',');
console.log([
  '// Generated from native/scripts/logos.mjs by native/scripts/gen-logos.sh: the CLI marks. Trademarks belong to their',
  '// owners. paths: one-colour marks (simple-icons, CC0-1.0) as SVG paths in a 24x24 box, drawn white on the tile colour;',
  '// icons: the products\\' own full-colour icons (lobe-icons, MIT, native/scripts/LICENSE-lobe-icons), drawn as they are.',
  '',
  'enum Logos {',
  '    static let paths: [String: String] = [', ...paths, '    ]',
  '',
  '    static let icons: [String: String] = [', ...icons, '    ]',
  '',
  '    /// the brand colour a one-colour mark sits on',
  '    static let tiles: [String: UInt32] = [', ...tiles, '    ]',
  '}',
].join('\n'));
" > native/Sources/Taksim/Logos.swift

#!/bin/sh
# Regenerates Sources/Taksim/Logos.swift from native/scripts/logos.mjs (simple-icons, CC0-1.0).
cd "$(dirname "$0")/../.."
node --input-type=module -e "
import { LOGOS } from './native/scripts/logos.mjs';
const lines = Object.entries(LOGOS).map(([k, v]) => '    \"' + k + '\": \"' + v.path + '\",');
console.log('// Generated from native/scripts/logos.mjs (simple-icons, CC0-1.0) by native/scripts/gen-logos.sh: the CLI marks,\n// as SVG paths in a 24x24 box.\n\nenum Logos {\n    static let paths: [String: String] = [\n' + lines.join('\n') + '\n    ]\n}');
" > native/Sources/Taksim/Logos.swift

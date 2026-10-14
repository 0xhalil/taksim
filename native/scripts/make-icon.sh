#!/bin/sh
# Draws native/Resources/AppIcon.icns and AppIcon.png: the mark in white on the accent blue.
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
cp "$here/make-icon.swift" "$work/main.swift"
cp "$here/../Sources/TaksimKit/TaksimMark.swift" "$work/"
mkdir -p "$work/scripts" && cp "$work/main.swift" "$work/scripts/make-icon.swift"
swiftc -O -o "$work/make-icon" "$work/main.swift" "$work/TaksimMark.swift"
# the program finds Resources next to itself: run it from a copy of scripts/
mkdir -p "$work/native/scripts" "$work/native/Resources"
cp "$work/make-icon" "$work/native/scripts/make-icon"
"$work/native/scripts/make-icon"
cp "$work/native/Resources/AppIcon.icns" "$work/native/Resources/AppIcon.png" "$here/../Resources/"
rm -rf "$work"

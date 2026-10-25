// The native app's SF Symbols (AppIcon.swift), drawn as 24-unit outline paths so they can ship on Linux and
// Windows. `icon()` makes an inline SVG for the DOM, `drawIcon()` strokes the same path on the canvas.

const stroke = {
  'sidebar.left': 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9.5 4v16 M5.6 7.6h1.6 M5.6 10.4h1.6 M5.6 13.2h1.6',
  gearshape: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M10.3 2.8h3.4l.5 2.6 1.9 1.1 2.5-.9 1.7 2.9-2 1.7v2.2l2 1.7-1.7 2.9-2.5-.9-1.9 1.1-.5 2.6h-3.4l-.5-2.6-1.9-1.1-2.5.9-1.7-2.9 2-1.7v-2.2l-2-1.7 1.7-2.9 2.5.9 1.9-1.1z',
  'arrow.up.left.and.arrow.down.right': 'M4.5 4.5l6 6 M4.5 4.5h5.2 M4.5 4.5v5.2 M19.5 19.5l-6-6 M19.5 19.5h-5.2 M19.5 19.5v-5.2',
  plus: 'M12 4.5v15 M4.5 12h15',
  xmark: 'M6 6l12 12 M18 6L6 18',
  minus: 'M4.5 12h15',
  terminal: 'M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5z M7 9.5l2.8 2.5L7 14.5 M11.5 15h5',
  'chevron.left.forwardslash.chevron.right': 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.8 4.5l-3.6 15',
  'person.2': 'M9 11a3.6 3.6 0 1 0 0-7.2A3.6 3.6 0 0 0 9 11z M2.5 20.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6 M16 4.2a3.4 3.4 0 0 1 0 6.6 M18 14.8c2 .6 3.5 2.6 3.5 5.7',
  person: 'M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 21c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5',
  display: 'M3.5 4h17a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8.5 20h7 M12 16v4',
  'book.closed': 'M6 3.5h12.5v14H7.2A2.2 2.2 0 0 0 5 19.7V5a1.5 1.5 0 0 1 1-1.5z M5 19.7a1.8 1.8 0 0 0 1.8 1.8h11.7v-4 M9 7.5h6',
  folder: 'M3 7V5.8A1.8 1.8 0 0 1 4.8 4h4.1l2 2.2h8.3A1.8 1.8 0 0 1 21 8v10.2a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.2z M3 9h18',
  'arrow.triangle.branch': 'M6 3.5v10.5 M6 14c0-3 2.4-4.5 6-4.5h3 M14 6.5l3 3-3 3 M6 20.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
  brain: 'M12 5v14.5 M12 5a3 3 0 0 0-5.6-1.3A3 3 0 0 0 4 7.6a3.3 3.3 0 0 0-.4 6 3.2 3.2 0 0 0 2.9 4.6A3 3 0 0 0 12 19.5 M12 5a3 3 0 0 1 5.6-1.3A3 3 0 0 1 20 7.6a3.3 3.3 0 0 1 .4 6 3.2 3.2 0 0 1-2.9 4.6 3 3 0 0 1-5.5 1.3 M8.5 9.5a2 2 0 0 0 3.5 0 M12 13a2 2 0 0 0 3.5 0',
  'gauge.with.dots.needle.67percent': 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M12 12.5l4-4 M7.5 15.5h.01 M7 11h.01 M9 7.3h.01 M12 6h.01',
  lock: 'M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3',
  'wand.and.stars': 'M4 20L15 9 M13.5 7.5l3 3 M18 2.5v3 M16.5 4h3 M20.5 9v2.5 M19.25 10.25h2.5 M9 3v2.5 M7.75 4.25h2.5',
  'wand.and.stars.inverse': 'M4 20L15 9 M13.5 7.5l3 3 M18 2.5v3 M16.5 4h3 M3 3l18 18',
  magnifyingglass: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.3 15.3L20.5 20.5',
  'rectangle.3.group': 'M4 3.5h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z M4 14.5h6a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z M14 14.5h6a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z',
  'exclamationmark.triangle': 'M12 3.5l9.5 16.5h-19z M12 10v4.5 M12 17.4v.2',
  'square.stack.3d.up': 'M12 3l9 4.8-9 4.8-9-4.8z M3 12l9 4.8 9-4.8 M3 16.4l9 4.8 9-4.8',
  'chevron.down': 'M6 9l6 6 6-6',
  'chevron.up': 'M6 15l6-6 6 6',
  'chevron.left': 'M15 5.5L8.5 12l6.5 6.5',
  'chevron.right': 'M9 5.5l6.5 6.5L9 18.5',
  checkmark: 'M5 12.5l4.5 4.5L19 7',
  'circle.grid.3x3': 'M5 5h.01 M12 5h.01 M19 5h.01 M5 12h.01 M12 12h.01 M19 12h.01 M5 19h.01 M12 19h.01 M19 19h.01',
  'arrow.clockwise': 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v4h-4',
  'arrow.up': 'M12 19.5V5 M6 11l6-6 6 6',
  'arrow.up.right': 'M7 17L17 7 M8.5 7H17v8.5',
  'arrow.uturn.backward': 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  'arrow.down.circle': 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M12 7.5v9 M8 12.5l4 4 4-4',
  paperclip: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  at: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M15.5 8.5v4.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7',
  photo: 'M4 4.5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M3 16l5-5 4 4 3-3 6 6 M15.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  'doc.on.doc': 'M8.5 7.5V4.8A1.3 1.3 0 0 1 9.8 3.5h9.4a1.3 1.3 0 0 1 1.3 1.3v11.4a1.3 1.3 0 0 1-1.3 1.3h-2.7 M4.8 7.5h9.4a1.3 1.3 0 0 1 1.3 1.3v11.4a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3V8.8a1.3 1.3 0 0 1 1.3-1.3z',
  'square.and.arrow.down': 'M12 3v12 M7.5 10.5L12 15l4.5-4.5 M4.5 13v6.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V13',
  'square.and.arrow.up': 'M12 15V3 M7.5 7.5L12 3l4.5 4.5 M4.5 11v8.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V11',
  bookmark: 'M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.5-6.5 4.5v-16a1 1 0 0 1 1-1z',
  trash: 'M4 6.5h16 M9 6.5V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4l1-13 M10 10.5v6.5 M14 10.5v6.5',
  'pencil': 'M4 20l1-4.5L16 4.5a2.1 2.1 0 0 1 3 3L8 18.5z M14.5 6l3.5 3.5',
  ellipsis: 'M5.5 12h.01 M12 12h.01 M18.5 12h.01',
  'clock.arrow.circlepath': 'M3.5 12a8.5 8.5 0 1 0 2.5-6 M3.5 4.5V9H8 M12 7.5V12l3 2',
  'bubble.left': 'M4.5 4h15a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h-1A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z',
  sparkles: 'M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z',
  'list.bullet': 'M9 6.5h11 M9 12h11 M9 17.5h11 M4.5 6.5h.01 M4.5 12h.01 M4.5 17.5h.01',
  checklist: 'M3.5 6.5l1.5 1.5 3-3 M3.5 13l1.5 1.5 3-3 M11 7h9.5 M11 13.5h9.5 M11 19h9.5 M4 19h3',
  'hand.raised': 'M8 12V5.5a1.5 1.5 0 0 1 3 0V11 M11 10V4a1.5 1.5 0 0 1 3 0v6.5 M14 10.5V5.5a1.5 1.5 0 0 1 3 0v8 M8 12.5V9a1.5 1.5 0 0 0-3 0v5.5c0 4 3 7 7 7s6-3 6-6.5v-3',
  'arrow.triangle.2.circlepath': 'M4.5 12a7.5 7.5 0 0 1 13-5 M17.5 3.5v3.5H14 M19.5 12a7.5 7.5 0 0 1-13 5 M6.5 20.5V17H10',
  safari: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M15.8 8.2l-2.3 5.3-5.3 2.3 2.3-5.3z M12 3v1.6 M12 19.4V21 M3 12h1.6 M19.4 12H21',
  'eye.slash': 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M4 3.5l16 17',
  'globe': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  'cpu': 'M7 7h10v10H7z M10 3.5V7 M14 3.5V7 M10 17v3.5 M14 17v3.5 M3.5 10H7 M3.5 14H7 M17 10h3.5 M17 14h3.5',
  'key': 'M8 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M11.5 12H21 M18 12v3 M15 12v2',
  'paintbrush': 'M14.5 4.5l5 5-7 7-5-5z M7.5 11.5L4 15c-1 1-.5 4.5 1 5s4-.1 5-1l3.5-3.5',
  'puzzlepiece': 'M5 8h3.5a2 2 0 1 1 4 0H16v3.5a2 2 0 1 1 0 4V19H5v-3.5a2 2 0 1 0 0-4z',
  'info.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5.5 M12 7.6v.2',
  'moon': 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  'sun.max': 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4',
  'tray': 'M3 13.5l2.5-8.5h13l2.5 8.5v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M3 13.5h5l1.5 2.5h5l1.5-2.5h5',
  'folder.badge.plus': 'M3 7V5.8A1.8 1.8 0 0 1 4.8 4h4.1l2 2.2h8.3A1.8 1.8 0 0 1 21 8v3.5 M3 7v11.2A1.8 1.8 0 0 0 4.8 20H12 M18 14v6 M15 17h6',
  'megaphone': 'M4 9.5v5h3l8 4.5v-14L7 9.5z M18 9.5a3 3 0 0 1 0 5',
  'eye': 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'xmark.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 9l6 6 M15 9l-6 6',
  'chevron.up.chevron.down': 'M7 8.5l5-4.5 5 4.5 M7 15.5l5 4.5 5-4.5',
  'text.alignleft': 'M3.5 5h17 M3.5 9.7h11 M3.5 14.3h17 M3.5 19h11',
  theatermasks: 'M3 10.5c0-4 3.5-7 8-7s8 3 8 7c0 4.5-3.5 7.5-8 7.5s-8-3-8-7.5z M7.5 9h.01 M14.5 9h.01 M8 13.5c1 1 5 1 6 0',
  'person.crop.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11.5a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z M6.8 17.6c1.3-2.4 3.2-3.6 5.2-3.6s3.9 1.2 5.2 3.6',
  'arrow.uturn.backward.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M10 13l-3-3 3-3 M7 10h5a3 3 0 0 1 0 6h-2',
  'circle.lefthalf.filled': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18',
  // the chat's and agent sheet's own symbols (Chat/*.swift, AgentSheet.swift)
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  'pause.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M10 8.8v6.4 M14 8.8v6.4',
  'stop.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.5h5v5h-5z',
  'checkmark.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.3l2.8 2.8L16.2 9.5',
  'exclamationmark.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5v5.5 M12 16.2v.2',
  'minus.circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12h8',
  'questionmark.bubble': 'M4.5 4h15a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h-1A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z M9.8 8.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.3 M12 14.6v.2',
  'bubble.left.and.text.bubble.right': 'M3.5 3.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3 2.5v-2.5h-1.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z M17 8.5h3.5a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H19v2.5L16 17h-5.5a1 1 0 0 1-1-1v-1.5 M13 14.5h5',
  'list.bullet.clipboard': 'M8.5 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5h-2 M9.5 3h5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 10.5h5 M11 14h5 M11 17.5h5 M8 10.5h.01 M8 14h.01 M8 17.5h.01',
  'arrow.trianglehead.2.clockwise.rotate.90': 'M4.5 12a7.5 7.5 0 0 1 13-5 M17.5 3.5v3.5H14 M19.5 12a7.5 7.5 0 0 1-13 5 M6.5 20.5V17H10',
  'arrow.down': 'M12 4.5V19 M6 13l6 6 6-6',
  'arrow.uturn.forward': 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  return: 'M19.5 5v7a2 2 0 0 1-2 2H5 M9 10l-4 4 4 4',
  'sidebar.right': 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M14.5 4v16 M16.8 7.6h1.6 M16.8 10.4h1.6 M16.8 13.2h1.6',
  'doc.text.magnifyingglass': 'M13 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3h7l5 5v3 M13.5 3v5h5 M8 11h4 M8 14.5h2.5 M16 19.5a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z M18 18.6l2.5 2.5',
  'text.line.first.and.arrowtriangle.forward': 'M3.5 5l4 2.8-4 2.8z M11 7.8h9.5 M3.5 14h17 M3.5 19h17',
  'line.3.horizontal': 'M4 7h16 M4 12h16 M4 17h16',
  'point.3.connected.trianglepath.dotted': 'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M19 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M10.8 7.2l-.01.01 M9.7 9.2l-.01.01 M8.6 11.2l-.01.01 M7.5 13.2l-.01.01 M6.4 15.2l-.01.01 M13.2 7.2l.01.01 M14.3 9.2l.01.01 M15.4 11.2l.01.01 M16.5 13.2l.01.01 M17.6 15.2l.01.01 M8 19h.01 M10 19h.01 M12 19h.01 M14 19h.01 M16 19h.01',
  bolt: 'M13.5 2.5L5 13.5h6.5l-1 8 8.5-11h-6.5z',
  'exclamationmark.shield': 'M12 3l7.5 3v5.5c0 4.7-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.8-7.5-9.5V6z M12 8v5 M12 15.8v.2',
  'arrow.up.right.square': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M9.5 14.5l5-5 M10 9.5h4.5V14',
  doc: 'M13.5 3h-7A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5z M13.5 3v5.5H19',
  'text.quote': 'M4 6h16 M9 11h11 M9 15.5h11 M4 20h16 M5 10.5v6',
  'arrow.right': 'M4.5 12h15 M13.5 6l6 6-6 6',
  'person.crop.circle.badge.exclamationmark': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11.5a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z M6.8 17.6c1.3-2.4 3.2-3.6 5.2-3.6s3.9 1.2 5.2 3.6 M19.5 5.5v3 M19.5 11v.2',
  'plus.bubble': 'M4.5 4h15a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h-1A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z M12 7.5v6 M9 10.5h6',
  'person.2.badge.plus': 'M9 11a3.6 3.6 0 1 0 0-7.2A3.6 3.6 0 0 0 9 11z M2.5 20.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6 M16 4.2a3.4 3.4 0 0 1 0 6.6 M18 14.8c2 .6 3.5 2.6 3.5 5.7 M19 3v4 M17 5h4',
};

// filled symbols (SF's ".fill"): a solid shape
const fill = {
  'bookmark.fill': 'M6.5 3h11A1.5 1.5 0 0 1 19 4.5V21l-7-4.8L5 21V4.5A1.5 1.5 0 0 1 6.5 3z',
  'folder.fill': 'M3 6.2A2.2 2.2 0 0 1 5.2 4h4l2 2.2h7.6A2.2 2.2 0 0 1 21 8.4v9.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8z',
  'person.2.fill': 'M9 3.4a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4z M2 20.2C2 16.6 5 14 9 14s7 2.6 7 6.2v.8H2z M16.6 4.2a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z M17.4 13.4c2.8.3 4.6 2.6 4.6 5.8v1.8h-4.5v-.8c0-2.6-1-4.9-2.7-6.4.8-.3 1.7-.4 2.6-.4z',
  'book.closed.fill': 'M6.6 3h12.4v14.5H7.2a2.2 2.2 0 0 0-2.2 2.2V4.6A1.6 1.6 0 0 1 6.6 3z M5.6 20.5a2 2 0 0 0 1.6.9H19v-2.6H7.2a1 1 0 0 0-1 1z',
  'lock.fill': 'M8 10V7.5a4 4 0 0 1 8 0V10h.8A1.2 1.2 0 0 1 18 11.2v8.6a1.2 1.2 0 0 1-1.2 1.2H7.2A1.2 1.2 0 0 1 6 19.8v-8.6A1.2 1.2 0 0 1 7.2 10z M9.6 10h4.8V7.5a2.4 2.4 0 0 0-4.8 0z',
  'stop.fill': 'M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
  'play.fill': 'M7.5 4.6a1 1 0 0 1 1.5-.9l10.4 7.4a1 1 0 0 1 0 1.7L9 20.3a1 1 0 0 1-1.5-.9z',
  'checkmark.circle.fill': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M16.9 9.3l-1.4-1.4-4.7 4.7-2.3-2.3-1.4 1.4 3.7 3.7z',
  'checkmark.seal.fill': 'M12 2l2.4 2.1 3.2-.5 1.5 2.8 3.1 1.1-.1 3.2 2.3 2.3-1.6 2.8 1 3.1-2.8 1.6-.5 3.2-3.2.1-1.8 2.6-3-1.2-2.7 1.7-2.1-2.4-3.2.5-1.5-2.8-3.1-1.1.1-3.2-2.3-2.3 1.6-2.8-1-3.1 2.8-1.6.5-3.2 3.2-.1 1.8-2.6 3 1.2z M10.2 15.6l-3.2-3.2 1.4-1.4 1.8 1.8 4.8-4.8 1.4 1.4z',
  'xmark.circle.fill': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 7.1L7.1 8.5 10.6 12l-3.5 3.5 1.4 1.4 3.5-3.5 3.5 3.5 1.4-1.4-3.5-3.5 3.5-3.5-1.4-1.4-3.5 3.5z',
  'exclamationmark.triangle.fill': 'M10.7 3.8a1.5 1.5 0 0 1 2.6 0l8.4 14.7a1.5 1.5 0 0 1-1.3 2.2H3.6a1.5 1.5 0 0 1-1.3-2.2z M11 9h2v5.5h-2z M11 16h2v2h-2z',
  'plus.circle.fill': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M11 7.5h2V11h3.5v2H13v3.5h-2V13H7.5v-2H11z',
  'circle.fill': 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  'exclamationmark.circle.fill': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M11 7h2v7h-2z M11 15.5h2v2h-2z',
  'megaphone.fill': 'M4 9h3l8.5-4.5v15L7 15H4z M17.5 9a3 3 0 0 1 0 6z',
};

const SVG = 'http://www.w3.org/2000/svg';
const cache = new Map();

export function has(name) { return name in stroke || name in fill; }

/** an inline SVG of a symbol, coloured by `currentColor` */
export function icon(name, size = 16, weight = 1.6) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('sym');
  const p = document.createElementNS(SVG, 'path');
  if (fill[name]) { p.setAttribute('d', fill[name]); p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd'); }
  else {
    p.setAttribute('d', stroke[name] || stroke.ellipsis);
    for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', (weight * 24 / size).toFixed(2)], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) p.setAttribute(k, v);
  }
  svg.append(p);
  return svg;
}

/** a symbol in a rect on the canvas (graph units), as AppIcon.draw does */
export function drawIcon(ctx, name, x, y, w, h, color, weight = 1.15) {
  const filled = !!fill[name];
  const key = name;
  let path = cache.get(key);
  if (!path) { path = new Path2D(fill[name] || stroke[name] || stroke.ellipsis); cache.set(key, path); }
  const s = Math.min(w, h) / 24;
  ctx.save();
  ctx.translate(x + (w - 24 * s) / 2, y + (h - 24 * s) / 2);
  ctx.scale(s, s);
  if (filled) { ctx.fillStyle = color; ctx.fill(path, 'evenodd'); }
  else {
    ctx.strokeStyle = color;
    ctx.lineWidth = weight / s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  ctx.restore();
}

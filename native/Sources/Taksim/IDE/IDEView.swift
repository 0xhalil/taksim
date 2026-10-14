import AppKit
import SwiftUI
import TaksimKit

/// The native IDE, PyCharm-like and calm: the project on the left, tabs over the editor, the agent's notes on
/// this file under it. No Save button (edits save themselves), no toolbar of words: icons, names and line numbers.
struct IDEView: View {
    let model: IDEModel

    var body: some View {
        GeometryReader { g in
            // the IDE keeps its real text size at every canvas zoom, so when it gets narrow the project steps aside
            let roomy = g.size.width >= 560
            HStack(spacing: 0) {
                if roomy {
                    IDESideStrip(model: model)
                    Rectangle().fill(JB.line).frame(width: 1)
                    if model.showLeft {
                        Group {
                            switch model.panel {
                            case .project: IDETree(model: model)
                            case .commit: IDECommit(model: model)
                            }
                        }
                        .frame(width: min(230, g.size.width * 0.32))
                        .background(JB.panel)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                        Rectangle().fill(JB.line).frame(width: 1)
                    }
                }
                editorColumn
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.9), value: model.showLeft)
            .animation(.easeOut(duration: 0.18), value: model.panel)
        }
        .overlay(alignment: .top) {
            if model.goingToFile { GoToFile(model: model).padding(.top, 40).transition(.opacity.combined(with: .move(edge: .top))) }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: model.goingToFile)
        .task { if !model.gitLoaded { await model.refreshGit() } } // the stripe can offer Commit from the first moment
    }

    private var editorColumn: some View {
            VStack(spacing: 0) {
                IDETabs(model: model)
                Rectangle().fill(JB.line).frame(height: 1)
                content
                IDENotes(model: model)
            }
            .background(JB.bg)
    }

    @ViewBuilder private var content: some View {
        if let d = model.diff {
            IDEDiffView(model: model, diff: d)
        } else if let path = model.active, let b = model.buffers[path] {
            switch b.kind {
            case .text:
                VStack(spacing: 0) {
                    if b.conflict { ConflictBar(model: model, path: path) }
                    IDEEditor(model: model, path: path).id(path)
                }
            case .binary: Placeholder(symbol: "doc.zipper", word: L("Binary file"))
            case .tooLarge: Placeholder(symbol: "doc.text.magnifyingglass", word: L("Too large"))
            case .missing: Placeholder(symbol: "questionmark.folder", word: L("Missing"))
            }
        } else if model.active != nil {
            Color.clear.overlay(ProgressView().controlSize(.small))
        } else {
            // no file open: the way to find one, as its keys
            VStack(spacing: 14) {
                Image(systemName: "chevron.left.forwardslash.chevron.right").font(.system(size: 34, weight: .light)).foregroundStyle(JB.muted2)
                Button { model.startGoToFile() } label: { Keycaps(keys: ["⌘", "P"]) }.buttonStyle(Press()).help(L("Go to file"))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// ---------- the project ----------

/// PyCharm's left stripe: Project and Commit, the open one lit. The Commit button carries the count of
/// changed files, as an editor's source-control button does; a folder outside a repository has no Commit.
struct IDESideStrip: View {
    let model: IDEModel

    var body: some View {
        VStack(spacing: 2) {
            button(.project, symbol: "folder", help: L("Project"), badge: nil)
            if model.git != nil || !model.gitLoaded {
                button(.commit, symbol: "arrow.triangle.branch", help: "Commit", badge: model.git?.files.count)
            }
            Spacer()
        }
        .padding(.vertical, 6)
        .frame(width: 34)
        .background(JB.panel)
    }

    private func button(_ p: IDEPanel, symbol: String, help: String, badge: Int?) -> some View {
        let on = model.panel == p && model.showLeft
        return Button { model.setPanel(p) } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: symbol).font(.system(size: 13)).frame(width: 28, height: 26)
                if let n = badge, n > 0 {
                    Text("\(n)").font(.system(size: 8, weight: .bold)).foregroundStyle(JB.accentInk)
                        .padding(.horizontal, 3).frame(minWidth: 12, minHeight: 12)
                        .background(Capsule().fill(JB.accent)).offset(x: 2, y: -2)
                }
            }
            .foregroundStyle(on ? JB.accent : JB.muted)
            .background(RoundedRectangle(cornerRadius: 6).fill(on ? JB.sel : .clear))
        }
        .buttonStyle(Press())
        .help(help)
    }
}

struct IDETree: View {
    let model: IDEModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "folder.fill").font(.system(size: 11)).foregroundStyle(JB.accent)
                Text(model.rootName).font(.system(size: 12, weight: .semibold)).foregroundStyle(JB.ink).lineLimit(1)
                Spacer()
                Button { model.startGoToFile() } label: { Image(systemName: "magnifyingglass").font(.system(size: 11)) }
                    .buttonStyle(CloseButtonStyle(size: 20)).help(L("Go to file (⌘P)"))
            }
            .padding(.horizontal, 10).frame(height: 32)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows, id: \.entry.path) { r in row(r.entry, depth: r.depth) }
                }
                .padding(.vertical, 4)
            }
        }
    }

    /// the entries shown: each opened folder's children under it
    private var rows: [(entry: IDEEntry, depth: Int)] {
        var out: [(IDEEntry, Int)] = []
        func walk(_ dir: String, _ depth: Int) {
            for e in model.children[dir] ?? [] {
                out.append((e, depth))
                if e.isDir, model.expanded.contains(e.path) { walk(e.path, depth + 1) }
            }
        }
        walk("", 0)
        return out
    }

    private func row(_ e: IDEEntry, depth: Int) -> some View {
        let on = model.active == e.path
        let open = model.expanded.contains(e.path)
        let status = e.isDir ? (model.folderChanged(e.path) ? "modified" : nil) : model.gitStatus(of: e.path)
        let name: Color = e.excluded == true ? JB.muted2 : status != nil ? GitTone.color(status) : on ? JB.ink : JB.text
        return Hovering { hover in
            HStack(spacing: 5) {
                if e.isDir {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).foregroundStyle(JB.muted)
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 10)
                } else { Color.clear.frame(width: 10) }
                FileIcon(path: e.path, dir: e.isDir, open: open)
                Text(e.name).font(.system(size: 12)).lineLimit(1)
                    .foregroundStyle(name)
                    .strikethrough(status == "deleted", color: GitTone.color(status))
                Spacer(minLength: 0)
                if !e.isDir, let n = model.notes.first(where: { $0.path == e.path }) {
                    Circle().fill(Color(nsColor: EditorMarks.tone(worst(e.path) ?? n.severity))).frame(width: 6, height: 6)
                }
            }
            .padding(.leading, 8 + CGFloat(depth) * 14).padding(.trailing, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 4).fill(on ? JB.sel : hover ? JB.tint : .clear).padding(.horizontal, 4))
            .contentShape(Rectangle())
            .onTapGesture { if e.isDir { withAnimation(.easeOut(duration: 0.15)) { model.toggle(e.path) } } else { model.open(e.path) } }
        }
    }

    private func worst(_ path: String) -> String? {
        let s = Set(model.notes.filter { $0.path == path }.compactMap(\.severity))
        return s.contains("error") ? "error" : s.contains("warning") ? "warning" : s.first
    }
}

/// a file's mark: its kind's color, like PyCharm's file icons
struct FileIcon: View {
    let path: String
    var dir = false
    var open = false
    var body: some View {
        if dir {
            Image(systemName: open ? "folder" : "folder.fill").font(.system(size: 11)).foregroundStyle(JB.muted)
        } else {
            let (tint, symbol) = Self.kind((path as NSString).pathExtension.lowercased())
            Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(tint)
        }
    }

    static func kind(_ ext: String) -> (Color, String) {
        switch ext {
        case "py": (Color(hex: 0x3D8BD8), "doc.text")
        case "js", "mjs", "cjs", "ts", "tsx", "jsx": (Color(hex: 0xD9A33F), "doc.text")
        case "swift": (Color(hex: 0xE5673A), "swift")
        case "go": (Color(hex: 0x2AACB8), "doc.text")
        case "rs": (Color(hex: 0xC4552D), "doc.text")
        case "json", "yaml", "yml", "toml": (Color(hex: 0x9B6EE0), "curlybraces")
        case "md", "txt": (JB.muted, "doc.plaintext")
        case "html", "css": (Color(hex: 0xD9773F), "chevron.left.forwardslash.chevron.right")
        case "sh", "zsh": (JB.ok, "terminal")
        default: (JB.muted, "doc")
        }
    }
}

// ---------- tabs ----------

struct IDETabs: View {
    let model: IDEModel
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(model.tabs, id: \.self) { tab($0) }
            }
        }
        .frame(height: 32)
        .background(JB.panel)
    }

    private func tab(_ path: String) -> some View {
        let on = model.active == path
        let b = model.buffers[path]
        return Hovering { hover in
            HStack(spacing: 6) {
                FileIcon(path: path)
                Text((path as NSString).lastPathComponent).font(.system(size: 12, weight: on ? .medium : .regular))
                    .foregroundStyle(on ? JB.ink : JB.muted).lineLimit(1)
                ZStack {
                    if b?.conflict == true {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)).foregroundStyle(JB.warn)
                    } else if b?.dirty == true && !hover {
                        Circle().fill(JB.muted).frame(width: 6, height: 6)
                    }
                    if hover || on {
                        Button { model.close(path) } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                            .buttonStyle(CloseButtonStyle(size: 16)).opacity(hover ? 1 : 0.6)
                    }
                }
                .frame(width: 16)
            }
            .padding(.leading, 10).padding(.trailing, 6)
            .frame(height: 32)
            .overlay(alignment: .bottom) { if on { Rectangle().fill(JB.accent).frame(height: 2) } }
            .background(on ? JB.bg : hover ? JB.tint : .clear)
            .contentShape(Rectangle())
            .onTapGesture { model.select(path) }
            .help(path)
        }
    }
}

// ---------- under the editor ----------

/// the file changed on disk while it had edits here: take the disk's, or keep these (written over it)
struct ConflictBar: View {
    let model: IDEModel
    let path: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(JB.warn)
            Text(L("Changed on disk")).font(.system(size: 12)).foregroundStyle(JB.ink)
            Spacer()
            Button { model.takeDisk(path) } label: { Label(L("Use disk"), systemImage: "arrow.down.doc").font(.system(size: 12)) }
                .buttonStyle(Press())
            Button { model.keepMine(path) } label: { Label(L("Keep mine"), systemImage: "square.and.arrow.up").font(.system(size: 12, weight: .semibold)) }
                .buttonStyle(Press())
        }
        .padding(.horizontal, 12).frame(height: 30)
        .background(JB.warn.opacity(0.14))
    }
}

/// the agent's notes on this file: a line each, a click shows it, × drops it
struct IDENotes: View {
    let model: IDEModel
    var body: some View {
        let notes = model.active.map(model.notes(in:)) ?? []
        if !notes.isEmpty {
            VStack(spacing: 0) {
                Rectangle().fill(JB.line).frame(height: 1)
                ScrollView {
                    VStack(spacing: 0) { ForEach(notes) { row($0) } }
                }
                .frame(height: min(CGFloat(notes.count) * 26 + 4, 110))
            }
            .background(JB.panel)
        }
    }

    private func row(_ n: IDENote) -> some View {
        Hovering { hover in
            HStack(spacing: 8) {
                Image(systemName: n.severity == "error" ? "xmark.octagon.fill" : n.severity == "warning" ? "exclamationmark.triangle.fill" : "info.circle.fill")
                    .font(.system(size: 11)).foregroundStyle(Color(nsColor: EditorMarks.tone(n.severity)))
                Text("\(n.line)").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(JB.muted).frame(minWidth: 26, alignment: .trailing)
                Text(n.text).font(.system(size: 12)).foregroundStyle(JB.text).lineLimit(1).truncationMode(.tail).help(n.text)
                Spacer(minLength: 0)
                if hover {
                    Button { model.clear(n) } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                        .buttonStyle(CloseButtonStyle(size: 16)).help(L("Dismiss note"))
                }
            }
            .padding(.horizontal, 10).frame(height: 26)
            .background(hover ? JB.tint : .clear)
            .contentShape(Rectangle())
            .onTapGesture { model.show(n) }
        }
    }
}

struct Placeholder: View {
    let symbol: String
    let word: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 30, weight: .light)).foregroundStyle(JB.muted2)
            Text(word).font(.system(size: 12)).foregroundStyle(JB.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct Keycaps: View {
    let keys: [String]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(keys, id: \.self) { k in
                Text(k).font(.system(size: 13, weight: .medium)).foregroundStyle(JB.muted)
                    .frame(minWidth: 26, minHeight: 26)
                    .background(RoundedRectangle(cornerRadius: 6).fill(JB.panel))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(JB.line))
            }
        }
    }
}

// ---------- ⌘P ----------

struct GoToFile: View {
    let model: IDEModel
    @State private var query = ""
    @State private var picked = 0
    @FocusState private var focused: Bool

    var body: some View {
        let hits = FuzzyPath.rank(query, model.allFiles ?? [], limit: 12)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(JB.muted)
                TextField("", text: $query).textFieldStyle(.plain).font(.system(size: 14)).focused($focused)
                    .onSubmit { if hits.indices.contains(picked) { go(hits[picked]) } }
                    .onKeyPress(.downArrow) { picked = min(picked + 1, max(0, hits.count - 1)); return .handled }
                    .onKeyPress(.upArrow) { picked = max(picked - 1, 0); return .handled }
                    .onExitCommand { model.goingToFile = false }
                if model.allFiles == nil { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12).frame(height: 40)
            if !hits.isEmpty { Rectangle().fill(JB.line).frame(height: 1) }
            VStack(spacing: 0) {
                ForEach(Array(hits.enumerated()), id: \.element) { i, p in
                    HStack(spacing: 8) {
                        FileIcon(path: p)
                        Text((p as NSString).lastPathComponent).font(.system(size: 12.5, weight: .medium)).foregroundStyle(JB.ink)
                        Text((p as NSString).deletingLastPathComponent).font(.system(size: 11.5)).foregroundStyle(JB.muted).lineLimit(1).truncationMode(.head)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).frame(height: 26)
                    .background(i == picked ? JB.sel : .clear)
                    .contentShape(Rectangle())
                    .onTapGesture { go(p) }
                }
            }
            .padding(.vertical, hits.isEmpty ? 0 : 4)
        }
        .frame(width: 460)
        .background(RoundedRectangle(cornerRadius: 10).fill(JB.panel).shadow(color: .black.opacity(0.35), radius: 18, y: 8))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(JB.line))
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in picked = 0 }
    }

    private func go(_ path: String) {
        model.goingToFile = false
        model.open(path)
    }
}

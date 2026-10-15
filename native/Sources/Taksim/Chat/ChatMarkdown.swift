import AppKit
import SwiftUI
import TaksimKit

/// A streaming-safe block parser. Incomplete code fences remain code, never flash as prose.
struct ChatMarkdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let t): Self.inline(t)
                case .code(let language, let code): CodeBlock(language: language, code: code)
                case .heading(let level, let t):
                    Self.inline(t, size: level == 1 ? 17 : level == 2 ? 14.5 : 13, weight: .semibold).padding(.top, level == 1 ? 6 : 2)
                case .item(let marker, let indent, let t):
                    HStack(alignment: .top, spacing: 7) {
                        Text(marker).font(.system(size: 12)).foregroundStyle(JB.muted).frame(minWidth: 14, alignment: .trailing)
                        Self.inline(t)
                    }.padding(.leading, CGFloat(indent) * 8)
                case .quote(let t):
                    HStack(spacing: 9) {
                        Rectangle().fill(JB.line).frame(width: 2)
                        Self.inline(t)
                    }.padding(.vertical, 3)
                case .table(let rows): MarkdownTable(rows: rows)
                case .rule: Rectangle().fill(JB.line).frame(height: 1).padding(.vertical, 4)
                }
            }
        }.lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
    }

    enum Block: Equatable {
        case text(String), code(String, String), heading(Int, String), item(String, Int, String), quote(String), table([[String]]), rule
    }

    static func blocks(_ source: String) -> [Block] {
        var out: [Block] = [], prose: [String] = [], code: [String]? = nil, language = "", fence = ""
        func flush() {
            let lines = prose; prose = []
            var paragraph: [String] = []
            func flushParagraph() {
                let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !text.isEmpty { out.append(.text(text)) }; paragraph = []
            }
            var i = 0
            while i < lines.count {
                let line = lines[i], t = line.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { flushParagraph(); i += 1; continue }
                if i + 1 < lines.count, t.contains("|"), tableDivider(lines[i + 1]) {
                    flushParagraph()
                    var rows = [cells(t)]; i += 2
                    while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty { rows.append(cells(lines[i])); i += 1 }
                    out.append(.table(rows)); continue
                }
                let hashes = t.prefix(while: { $0 == "#" }).count
                if (1...6).contains(hashes), t.dropFirst(hashes).first == " " {
                    flushParagraph(); out.append(.heading(hashes, String(t.dropFirst(hashes + 1))))
                } else if ["---", "***", "___"].contains(t) { flushParagraph(); out.append(.rule) }
                else if t.hasPrefix(">") { flushParagraph(); out.append(.quote(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))) }
                else if let item = listItem(t) {
                    flushParagraph(); out.append(.item(item.0, line.prefix(while: { $0 == " " }).count / 2, item.1))
                } else { paragraph.append(line) }
                i += 1
            }
            flushParagraph()
        }
        for line in source.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if let current = code {
                let run = t.prefix(while: { String($0) == String(fence.prefix(1)) })
                if run.count >= fence.count, t.dropFirst(run.count).trimmingCharacters(in: .whitespaces).isEmpty {
                    out.append(.code(language, current.joined(separator: "\n"))); code = nil
                } else { code?.append(line) }
            } else if t.hasPrefix("```") || t.hasPrefix("~~~") {
                let marker = t.first ?? "`"
                flush(); fence = String(t.prefix(while: { $0 == marker })); language = String(t.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces); code = []
            } else { prose.append(line) }
        }
        if let code { out.append(.code(language, code.joined(separator: "\n"))) }
        flush(); return out
    }

    private static func listItem(_ t: String) -> (String, String)? {
        for prefix in ["- ", "* ", "+ "] where t.hasPrefix(prefix) {
            let body = String(t.dropFirst(2))
            if body.hasPrefix("[ ] ") { return ("☐", String(body.dropFirst(4))) }
            if body.lowercased().hasPrefix("[x] ") { return ("☑", String(body.dropFirst(4))) }
            return ("•", body)
        }
        let digits = t.prefix(while: \.isNumber)
        let rest = t.dropFirst(digits.count)
        if !digits.isEmpty, rest.hasPrefix(". ") || rest.hasPrefix(") ") { return (String(digits) + ".", String(rest.dropFirst(2))) }
        return nil
    }
    private static func cells(_ text: String) -> [String] {
        var t = text.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }; if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
    private static func tableDivider(_ text: String) -> Bool {
        let columns = cells(text)
        return !columns.isEmpty && columns.allSatisfy { cell in
            let value = cell.replacingOccurrences(of: ":", with: "")
            return value.count >= 3 && value.allSatisfy { $0 == "-" }
        }
    }
    static func inline(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> some View {
        ChatText(markdown: text, size: size, weight: weight)
    }
}

private struct MarkdownTable: View {
    let rows: [[String]]
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 7) {
            ForEach(rows.indices, id: \.self) { i in
                GridRow {
                    ForEach(0..<(rows.map(\.count).max() ?? 0), id: \.self) { j in
                        ChatMarkdown.inline(rows[i].indices.contains(j) ? rows[i][j] : "", weight: i == 0 ? .semibold : .regular)
                    }
                }
                if i == 0 { Rectangle().fill(JB.line).frame(height: 1).gridCellColumns(rows.map(\.count).max() ?? 1) }
            }
        }.padding(10).background(RoundedRectangle(cornerRadius: 7).fill(JB.panel))
    }
}

private struct CodeBlock: View {
    let language: String
    let code: String
    @State private var copied = false
    @State private var expanded = false
    @Environment(\.isSnapshot) private var isSnapshot
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var lines: [String] { code.components(separatedBy: "\n") }
    private var visible: [String] { expanded ? lines : Array(lines.prefix(24)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? L("code") : language).font(.system(size: 10.5)).foregroundStyle(JB.muted)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 10.5)).foregroundStyle(copied ? JB.ok : JB.muted)
                        .contentTransition(.symbolEffect(.replace))
                }.buttonStyle(Tap()).help(L("Copy code")).accessibilityLabel(L("Copy code"))
            }.padding(.horizontal, 12).frame(height: 28)
            Rectangle().fill(JB.line).frame(height: 1)
            if isSnapshot { content }
            else { ScrollView(.horizontal) { content }.scrollIndicators(.hidden) }
            if lines.count > 24 {
                Button { expanded.toggle() } label: {
                    HStack { Spacer(); Text(expanded ? L("Collapse") : L("%d more lines", lines.count - 24)); Image(systemName: expanded ? "chevron.up" : "chevron.down"); Spacer() }
                        .font(.system(size: 10.5)).foregroundStyle(JB.muted).frame(height: 26).contentShape(Rectangle())
                }.buttonStyle(Tap())
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(JB.panel))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(JB.line))
        .animation(reduceMotion || isSnapshot ? nil : .spring(response: 0.35, dampingFraction: 0.9), value: expanded)
    }
    // code without line numbers, as Cursor's chat shows it: the lines are what is read
    private var content: some View {
        ChatText(visible.joined(separator: "\n"), size: 12, monospaced: true, wraps: false)
            .padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
    }
}

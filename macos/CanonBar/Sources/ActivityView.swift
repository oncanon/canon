import AppKit
import SwiftUI

/// page08 "Activity · header · ⌘2": the panel's Activity drill-in. Data is Core's activity/v1
/// (`canon activity --json`, newest first) plus status/v1's `service.refusedToServe`. Every read is
/// a CLI call, so the view works the same under `--read-only`.
///
/// Rows map activity/v1 kinds onto the plate's four row styles (refusal, alias move, publish,
/// service). Wording the plate doesn't draw is listed in docs/app/p1-fidelity.md (pass 8).
struct ActivityView: View {
    @ObservedObject var controller: PublisherController

    private let ink = Color(hex: 0x0f172a)
    private let muted = Color(hex: 0x475569)
    private let rule = Color(hex: 0xe2e8f0)
    private let crimson = Color(hex: 0xb91c1c)

    /// The list scrolls once it is taller than this, so the panel stays on a laptop screen.
    static let maxListHeight: CGFloat = 470
    @State private var listHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            stats
            list
            actions
            footer
        }
        .background(Color.white)
    }

    // MARK: Header — bg #0f172a; padding 12px 16px 12px 8px; gap 8px

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Button {
                controller.showHome()
            } label: {
                BackChevron()
                    .stroke(Color(hex: 0xf1f5f9), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                    .frame(width: 14, height: 14)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(BackButtonStyle())
            // ⌘[ is the macOS "Back" key; the plate draws only the button (invented, listed).
            .keyboardShortcut("[", modifiers: .command)
            .accessibilityLabel("Back")
            .help("Back (⌘[)")

            CanonMark().frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 0) {
                Text("canon").font(Theme.serifBold(17)).foregroundStyle(Color(hex: 0xf1f5f9))
                Text("Activity").font(Theme.sans(12)).foregroundStyle(Color(hex: 0x9ca3af))
            }
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 12, leading: 8, bottom: 12, trailing: 16))
        .background(Color(hex: 0x0f172a))
    }

    // MARK: Stats band — bg #1b2434; padding 14px 16px 16px; gap 12px; border-top 1px #293548

    private var stats: some View {
        let today = todayItems
        let stored = today.filter { $0.kind == "publish" && $0.outcome == "created" && $0.errorClass == nil }.count
        let moved = today.filter { $0.kind == "alias" }.count
        // The feed is capped at activityLimit; if its oldest item is still today, today's counts
        // may be higher than what was read.
        let more = (controller.activity?.truncated ?? false) && isToday(controller.activity?.items.last)
        let refused = controller.service?.refusedToServe
        return VStack(alignment: .leading, spacing: 12) {
            Text("Today").font(Theme.sans(12, .semibold)).foregroundStyle(Color(hex: 0xe2e8f0))
            HStack(alignment: .top, spacing: 8) {
                statCell(controller.activity == nil ? "–" : "\(stored)\(more ? "+" : "")", "editions stored")
                statCell(controller.activity == nil ? "–" : "\(moved)\(more ? "+" : "")",
                         moved == 1 ? "alias moved" : "aliases moved")
                statCell(refused.map { "\($0.count)" } ?? "–", refusedCaption(refused),
                         alarm: (refused?.count ?? 0) > 0)
                    .help(refusedHelp(refused))
            }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: 0x1b2434))
        .overlay(Rectangle().fill(Color(hex: 0x293548)).frame(height: 1), alignment: .top)
    }

    /// padding-left 12px; border-left 1px #293548; gap 2px; number Libron 700 30/1 #f1f5f9
    /// (#fca5a5 for refusals); caption 12px #9ca3af.
    private func statCell(_ value: String, _ caption: String, alarm: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: value).font(Theme.serifBold(30))
                .foregroundStyle(Color(hex: alarm ? 0xfca5a5 : 0xf1f5f9))
                .frame(height: 30)
            Text(caption).font(Theme.sans(12)).foregroundStyle(Color(hex: 0x9ca3af))
                .lineLimit(1).minimumScaleFactor(0.9)
        }
        .padding(.leading, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().fill(Color(hex: 0x293548)).frame(width: 1), alignment: .leading)
    }

    /// status/v1 counts refusals since the service started, or across the whole events log; it
    /// is not a "today" figure, so the caption says which span it covers.
    private func refusedCaption(_ r: RefusedToServe?) -> String {
        switch r?.since {
        case "service-start": return "refused, since start"
        case "all-time": return "refused, all time"
        default: return "refused to serve"
        }
    }

    private func refusedHelp(_ r: RefusedToServe?) -> String {
        guard let r else { return "The service reported no refusal count." }
        let span = r.since == "service-start" ? "since the service last started" : "across the whole events log"
        return "\(r.count) \(r.count == 1 ? "read" : "reads") refused \(span) (integrity failures)."
    }

    // MARK: List

    @ViewBuilder private var list: some View {
        if let feed = controller.activity, !feed.items.isEmpty {
            let groups = dayGroups(feed.items)
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    ForEach(Array(groups.enumerated()), id: \.element.key) { index, group in
                        dayGroup(group, first: index == 0)
                    }
                    notes(feed)
                }
                .background(GeometryReader { geo in
                    Color.clear.preference(key: ActivityListHeight.self, value: geo.size.height)
                })
            }
            .scrollIndicators(.automatic)
            .frame(height: min(max(listHeight, 1), Self.maxListHeight))
            .onPreferenceChange(ActivityListHeight.self) { listHeight = $0 }
        } else {
            placeholder
        }
    }

    @ViewBuilder private var placeholder: some View {
        let text: String = {
            if let error = controller.activityError { return error }
            if controller.activity == nil { return controller.isLoadingActivity ? "Reading activity…" : "No activity read yet." }
            return "Nothing has happened yet."
        }()
        Text(verbatim: text)
            .font(Theme.sans(12.5)).foregroundStyle(muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 16, leading: 16, bottom: 6, trailing: 16))
    }

    @ViewBuilder private func notes(_ feed: ActivityFeed) -> some View {
        let lines: [String] = [
            feed.truncated ? "Showing the newest \(feed.items.count). Older entries are in the full log." : nil,
            feed.skipped > 0 ? "\(feed.skipped) unreadable \(feed.skipped == 1 ? "line was" : "lines were") skipped." : nil,
        ].compactMap { $0 }
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(lines, id: \.self) { Text(verbatim: $0) }
            }
            .font(Theme.sans(12)).foregroundStyle(muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))
        }
    }

    /// padding 14px 16px 6px (first) / 16px 16px 4px; head Libron 700 17 with JetBrains Mono 12
    /// #475569 on the right; border-bottom 2px #0f172a; padding-bottom 8px.
    private func dayGroup(_ group: DayGroup, first: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: group.title).font(Theme.serifBold(17)).foregroundStyle(ink)
                Spacer()
                Text(verbatim: group.dateLabel).font(Theme.mono(12)).foregroundStyle(muted)
            }
            .padding(.bottom, 8)
            .overlay(Rectangle().fill(ink).frame(height: 2), alignment: .bottom)
            ForEach(Array(group.items.enumerated()), id: \.offset) { index, item in
                row(item)
                    .overlay(alignment: .bottom) {
                        if index < group.items.count - 1 { Rectangle().fill(rule).frame(height: 1) }
                    }
            }
        }
        .padding(EdgeInsets(top: first ? 14 : 16, leading: 16, bottom: first ? 6 : 4, trailing: 16))
    }

    // MARK: Row — gap 12px; padding 9px 0; time JetBrains Mono 11.5 #475569, width 40, padding-top 1

    private func row(_ item: ActivityItem) -> some View {
        let refusal = item.kind == "verify-failure"
        return HStack(alignment: .top, spacing: 12) {
            Text(verbatim: timeLabel(item))
                .font(Theme.mono(11.5)).foregroundStyle(muted)
                .frame(width: 40, alignment: .leading)
                .padding(.top, 1)
            // inner: gap 9px; border-left 2px (#b91c1c refusal, else #0f172a); padding-left 10px
            HStack(alignment: .top, spacing: 9) {
                glyph(item).frame(width: 12, alignment: .center).padding(.top, 2)
                VStack(alignment: .leading, spacing: 1) {
                    title(item)
                        .font(Theme.sans(13, .semibold)).foregroundStyle(ink)
                        .lineSpacing(13 * 0.35 - 3)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = detail(item) {
                        detail
                            .font(Theme.sans(12)).foregroundStyle(muted)
                            .lineSpacing(12 * 0.45 - 3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 10)
            .overlay(Rectangle().fill(refusal ? crimson : ink).frame(width: 2), alignment: .leading)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func glyph(_ item: ActivityItem) -> some View {
        switch item.kind {
        case "verify-failure":
            CrossGlyph().stroke(crimson, style: StrokeStyle(lineWidth: 1.8)).frame(width: 11, height: 11)
        case "alias":
            Text("→").font(Theme.mono(12, bold: true)).foregroundStyle(ink)
        case "publish":
            if item.errorClass != nil {
                CrossGlyph().stroke(ink, style: StrokeStyle(lineWidth: 1.8)).frame(width: 11, height: 11)
            } else {
                CheckGlyph().stroke(Color(hex: 0x065f46), style: StrokeStyle(lineWidth: 1.8)).frame(width: 11, height: 11)
            }
        default:
            RoundedRectangle(cornerRadius: 1.5).strokeBorder(ink, lineWidth: 1.5)
                .frame(width: 7, height: 7).padding(.top, 3)
        }
    }

    /// Code chip: JetBrains Mono 11.5 #1e3a8a on #eff4fb, border #cbd8ea, radius 3.5, padding 0 4.
    /// A Text can't carry a border, so inline it is the chip's font and colour; the border is
    /// drawn only where the chip stands alone.
    private func chip(_ s: String) -> Text {
        Text(verbatim: s).font(Theme.mono(11.5)).foregroundColor(Color(hex: 0x1e3a8a))
    }

    private func monoMuted(_ s: String) -> Text {
        Text(verbatim: s).font(Theme.mono(11.5)).foregroundColor(muted)
    }

    private func subject(_ contentId: String?) -> String {
        guard let id = contentId else { return "an edition" }
        return controller.aliasName(forContentId: id) ?? "sha256-\(shortContentId(id))"
    }

    private func title(_ item: ActivityItem) -> Text {
        switch item.kind {
        case "verify-failure":
            return Text(verbatim: "Refused to serve \(subject(item.contentId))")
        case "alias":
            let name = item.name ?? "alias"
            if let g = item.generation, g > 1, item.previousContentId != nil {
                return Text(verbatim: "\(name) g\(g - 1) → g\(g)")
            }
            return Text(verbatim: "\(name) → g\(item.generation ?? 1)")
        case "publish":
            let id = item.contentId.map { "sha256-\(shortContentId($0))" } ?? "an edition"
            if item.errorClass != nil { return Text(verbatim: "Publish failed") }
            return Text(verbatim: item.outcome == "already-present" ? "Already stored \(id)" : "Stored \(id)")
        default:
            return Text(verbatim: serviceTitle(item))
        }
    }

    private func detail(_ item: ActivityItem) -> Text? {
        switch item.kind {
        case "verify-failure":
            if let path = item.path {
                return chip(path) + Text(" failed re-hash on read.")
            }
            return Text("A file failed re-hash on read.")
        case "alias":
            if let prev = item.previousContentId, let cur = item.contentId {
                return monoMuted(shortContentId(prev)) + Text(" → ") + monoMuted(shortContentId(cur))
            }
            if let cur = item.contentId { return Text("New alias · ") + monoMuted(shortContentId(cur)) }
            return nil
        case "publish":
            if let error = item.errorClass { return monoMuted(error) }
            return Text(item.outcome == "already-present" ? "Already in the store; nothing written." : "New edition in the store.")
        default:
            return serviceDetail(item).map { monoMuted($0) }
        }
    }

    private func serviceTitle(_ item: ActivityItem) -> String {
        switch item.event {
        case "start": return "Service started"
        case "ready": return "Service ready"
        case "stop": return "Service stopped"
        case "restart": return "Service restarted"
        case "start-refused": return "Start refused"
        case "start-failed": return "Service failed to start"
        case "recovered-stale-state": return "Recovered stale service state"
        case "clean": return "Service state cleared"
        default: return item.summary ?? (item.event.map { "Service: \($0)" } ?? "Service event")
        }
    }

    private func serviceDetail(_ item: ActivityItem) -> String? {
        guard let detail = item.detail else { return nil }
        if let host = detail["config"]?["host"]?.string, let port = detail["config"]?["port"]?.string {
            let pid = detail["pid"]?.string.map { " · pid \($0)" } ?? ""
            return "\(host):\(port)\(pid)"
        }
        if let url = detail["url"]?.string { return url.replacingOccurrences(of: "http://", with: "") }
        if let pid = detail["pid"]?.string { return "pid \(pid)" }
        if let reason = detail["reason"]?.string { return reason }
        return nil
    }

    // MARK: Actions — margin-top 10px; border-top 1px #cbd5e1; padding 6px 8px; rows 34px

    private var actions: some View {
        let hasLog = controller.eventsLogPath.map { FileManager.default.fileExists(atPath: $0) } ?? false
        return VStack(spacing: 0) {
            Button {
                controller.openFullLog()
            } label: {
                HStack {
                    Text("Open full log").font(Theme.sans(14)).foregroundStyle(ink)
                    Spacer()
                    Text("⌘L").font(Theme.mono(12)).foregroundStyle(muted)
                }
                .padding(.horizontal, 10)
                .frame(height: 34)
                .contentShape(Rectangle())
                .opacity(hasLog ? 1 : 0.45)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("l", modifiers: .command)
            .disabled(!hasLog)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .overlay(Rectangle().fill(Color(hex: 0xcbd5e1)).frame(height: 1), alignment: .top)
        .padding(.top, 10)
    }

    // MARK: Footer — bg #f4f6f9; border-top #e2e8f0; padding 9px 16px; JetBrains Mono 11 #475569

    private var footer: some View {
        HStack {
            Text(verbatim: controller.eventsLogPath.map { StoreFacts.tildePath($0) } ?? "events log unavailable")
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Text("append-only")
        }
        .font(Theme.mono(11))
        .foregroundStyle(muted)
        .padding(.vertical, 9)
        .padding(.horizontal, 16)
        .background(Color(hex: 0xf4f6f9))
        .overlay(Rectangle().fill(rule).frame(height: 1), alignment: .top)
    }

    // MARK: Days and times (local time zone)

    struct DayGroup {
        let key: String
        let title: String
        let dateLabel: String
        var items: [ActivityItem]
    }

    private var todayItems: [ActivityItem] {
        (controller.activity?.items ?? []).filter { isToday($0) }
    }

    private func isToday(_ item: ActivityItem?) -> Bool {
        guard let date = item?.date else { return false }
        return Calendar.current.isDateInToday(date)
    }

    private func dayGroups(_ items: [ActivityItem]) -> [DayGroup] {
        let cal = Calendar.current
        let keyFormat = DateFormatter()
        keyFormat.dateFormat = "yyyy-MM-dd"
        let label = DateFormatter()
        label.locale = Locale(identifier: "en_US_POSIX")
        label.dateFormat = "EEE d MMM" // the plate's "Sun 15 Nov"
        let weekday = DateFormatter()
        weekday.locale = Locale(identifier: "en_US_POSIX")
        weekday.dateFormat = "EEEE"
        let longDate = DateFormatter()
        longDate.locale = Locale(identifier: "en_US_POSIX")
        longDate.dateFormat = "d MMMM"
        var groups: [DayGroup] = []
        for item in items {
            let date = item.date
            let key = date.map { keyFormat.string(from: $0) } ?? "unknown"
            if groups.last?.key == key {
                groups[groups.count - 1].items.append(item)
                continue
            }
            let title: String
            if let date {
                if cal.isDateInToday(date) { title = "Today" }
                else if cal.isDateInYesterday(date) { title = "Yesterday" }
                else if let days = cal.dateComponents([.day], from: cal.startOfDay(for: date),
                                                       to: cal.startOfDay(for: Date())).day, days <= 6 {
                    title = weekday.string(from: date)
                } else {
                    // A weekday name alone would read as this week's day: older days get the date.
                    title = longDate.string(from: date)
                }
            } else {
                title = "Undated"
            }
            groups.append(DayGroup(key: key, title: title, dateLabel: date.map { label.string(from: $0) } ?? "", items: [item]))
        }
        return groups
    }

    private func timeLabel(_ item: ActivityItem) -> String {
        guard let date = item.date else { return "--:--" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
}

private struct ActivityListHeight: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Back button: 32×32, radius 5; chevron `M9 2.5 L4.5 7 L9 11.5` (viewBox 14).
struct BackChevron: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 14
        var p = Path()
        p.move(to: CGPoint(x: 9 * s, y: 2.5 * s))
        p.addLine(to: CGPoint(x: 4.5 * s, y: 7 * s))
        p.addLine(to: CGPoint(x: 9 * s, y: 11.5 * s))
        return p
    }
}

private struct BackButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.white.opacity(0.08) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

import AppKit
import Foundation
import ServiceManagement
import SwiftUI

private enum AppLanguage: String, CaseIterable {
    case system, en, zh

    static var selected: Self {
        let saved = UserDefaults.standard.string(forKey: "RouterLanguage") ?? ""
        return Self(rawValue: saved) ?? .system
    }

    var code: String {
        if self != .system { return rawValue }
        return Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true ? "zh" : "en"
    }

    var label: String {
        switch self {
        case .system: return L("跟随系统", "System")
        case .en: return "English"
        case .zh: return "简体中文"
        }
    }
}

private func L(_ chinese: @autoclosure () -> String, _ english: @autoclosure () -> String) -> String {
    AppLanguage.selected.code == "zh" ? chinese() : english()
}

private var appName: String { L("Codex 多账号代理", "Codex Plan Router") }
private let baseURL = "http://127.0.0.1:47631"
private let stateURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Codex Plan Router/state.json")

private struct Account: Decodable {
    let slot: String
    let email: String
    let registered: Bool
    let enabled: Bool
    let verified: Bool
    let needsLogin: Bool
    let cooldownUntil: Double
    let observedScore: Double
    let inFlight: Int

    var state: String {
        if needsLogin { return L("需要重新授权", "Reauthorization needed") }
        if !registered { return L("尚未登录", "Not signed in") }
        if !enabled { return L("未授权订阅", "Subscription access not granted") }
        if !verified { return L("待验证", "Awaiting verification") }
        if cooldownUntil > Date().timeIntervalSince1970 * 1000 { return L("暂缓调度", "Routing paused") }
        return inFlight > 0 ? L("正在处理 \(inFlight) 个请求", "Requests in progress: \(inFlight)") : L("就绪", "Ready")
    }
}

private struct Desktop: Decodable {
    let enabled: Bool
    let modified: Bool
}

private struct Snapshot: Decodable {
    let app: String
    let accounts: [Account]
    let primarySlot: String
    let routed: Int
    let fallbacks: Int
    let desktop: Desktop

    var canEnableProxy: Bool {
        accounts.filter { $0.verified && $0.enabled && !$0.needsLogin }.count >= 2
    }
}

private struct QuotaWindow: Decodable, Sendable {
    let remainingPercent: Double
    let resetsAt: Double?
}

private struct QuotaSnapshot: Decodable, Sendable {
    let status: String
    let updatedAt: Double?
    let slot: String?
    let fiveHour: QuotaWindow?
    let weekly: QuotaWindow?

    func percent(_ window: QuotaWindow?) -> String {
        guard let window, window.resetsAt.map({ $0 > Date().timeIntervalSince1970 * 1000 }) ?? true else { return "--" }
        return "\(Int(window.remainingPercent.rounded(.down)))%"
    }

    var title: String {
        let account = slot?.uppercased() ?? L("主号", "Primary")
        let stale = status == "stale" ? "*" : ""
        return L("\(account) 5h \(percent(fiveHour)) · 周 \(percent(weekly))\(stale)", "\(account) 5h \(percent(fiveHour)) · Wk \(percent(weekly))\(stale)")
    }
}

private struct QuotaCollection: Decodable, Sendable {
    let accounts: [QuotaSnapshot]
    var title: String { accounts.map(\.title).joined(separator: "\n") }
    var status: String { accounts.allSatisfy { $0.status == "ready" } ? "ready" : accounts.contains { $0.status == "stale" } ? "stale" : "unavailable" }
    func account(_ slot: String) -> QuotaSnapshot? { accounts.first { $0.slot == slot } }
}

@MainActor
private func statusImage(symbol: String, quota: QuotaCollection?) -> NSImage {
    let image = NSImage(size: NSSize(width: 140, height: 22), flipped: false) { _ in
        let icon = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .regular))
        icon?.draw(in: NSRect(x: 3, y: 3, width: 16, height: 16))
        let font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .medium)
        func text(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, right: Bool = false) {
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = right ? .right : .left
            paragraph.lineBreakMode = .byClipping
            (value as NSString).draw(in: NSRect(x: x, y: y, width: width, height: 11), withAttributes: [.font: font, .foregroundColor: NSColor.black, .paragraphStyle: paragraph])
        }
        // 两行共用同一套坐标，百分比固定右对齐，位数变化不会挤动列。
        for (index, slot) in ["a", "b"].enumerated() {
            let account = quota?.account(slot)
            let y: CGFloat = index == 0 ? 10.5 : 0.5
            text(slot.uppercased(), x: 25, y: y, width: 8)
            text("5h", x: 37, y: y, width: 12)
            text(account?.percent(account?.fiveHour) ?? "--", x: 50, y: y, width: 26, right: true)
            text("·", x: 80, y: y, width: 5)
            text(L("周", "W"), x: 89, y: y, width: 10)
            text(account?.percent(account?.weekly) ?? "--", x: 101, y: y, width: 27, right: true)
            if account?.status == "stale" { text("*", x: 130, y: y, width: 6) }
        }
        return true
    }
    image.isTemplate = true
    return image
}

private let legacyServiceURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents/com.sun.codex-plan-router.plist")
private let savedServiceURL = stateURL.deletingLastPathComponent()
    .appendingPathComponent("legacy-service.plist")
private let bundledBackend = Bundle.main.resourceURL?.appendingPathComponent("RouterBackend")

private func quotaProcess(script: String, arguments: [String]) -> Process? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let plist = FileManager.default.fileExists(atPath: legacyServiceURL.path) ? legacyServiceURL : savedServiceURL
    let data = try? Data(contentsOf: plist)
    let settings = data.flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] } ?? [:]
    let process = Process()
    if let bundledBackend {
        process.executableURL = bundledBackend.appendingPathComponent("runtime/node")
        process.arguments = [bundledBackend.appendingPathComponent(script).path] + arguments
    } else {
        guard let serviceArguments = settings["ProgramArguments"] as? [String],
              let node = serviceArguments.first else { return nil }
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [home.appendingPathComponent(".local/share/codex-plan-router").appendingPathComponent(script).path] + arguments
    }
    guard let executable = process.executableURL,
          FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
    var env = ["HOME": home.path, "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "NODE_USE_ENV_PROXY": "1", "NO_PROXY": "localhost,127.0.0.1,::1"]
    // 复用已安装后台服务的无凭据回环代理，不复制任何其他环境或认证值。
    let existing = settings["EnvironmentVariables"] as? [String: String] ?? [:]
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        guard let value = existing[key], let url = URLComponents(string: value),
              ["http", "https"].contains(url.scheme ?? ""),
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { continue }
        env[key] = value
    }
    process.environment = env
    return process
}

private func queryQuota(force: Bool) -> QuotaCollection? {
    guard let process = quotaProcess(script: "quota.mjs", arguments: ["--all"] + (force ? ["--force"] : [])) else { return nil }
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return try? JSONDecoder().decode(QuotaCollection.self, from: data)
}

private enum MenuError: LocalizedError {
    case credentials, response, service(String)
    var errorDescription: String? {
        switch self {
        case .credentials: return L("无法读取本机管理凭证，请检查代理是否已安装。", "Cannot read local management credentials. Check the app installation.")
        case .response: return L("后台服务返回了无法识别的状态。", "The backend returned an unexpected response.")
        case .service(let message): return message
        }
    }
}

private func adminKey() throws -> String {
    let data = try Data(contentsOf: stateURL)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let key = object["adminKey"] as? String, !key.isEmpty else { throw MenuError.credentials }
    return key
}

private func makeSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 5
    config.timeoutIntervalForResource = 180
    // 本机管理请求不经过系统网络代理，不缓存凭证或响应。
    config.connectionProxyDictionary = [:]
    config.urlCache = nil
    config.httpCookieStorage = nil
    return URLSession(configuration: config)
}

private func nativeLoginEmail() -> String? {
    // 只在内存读取本机登录身份，不复制或轮换凭证。
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/auth.json")
    guard let data = try? Data(contentsOf: url),
          let auth = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let mode = auth["auth_mode"] as? String, ["chatgpt", "chatgptAuthTokens"].contains(mode),
          let tokens = auth["tokens"] as? [String: Any],
          let accountID = tokens["account_id"] as? String, !accountID.isEmpty,
          let token = tokens["id_token"] as? String else { return nil }
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
    guard let claimsData = Data(base64Encoded: encoded),
          let claims = try? JSONSerialization.jsonObject(with: claimsData) as? [String: Any],
          let email = claims["email"] as? String, !email.isEmpty else { return nil }
    return email
}

@MainActor
private final class SettingsState: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var quota: QuotaCollection?
    @Published var language = AppLanguage.selected
    @Published var online = false
    @Published var busy = false
    @Published var message = L("额度每分钟更新；账号授权保存在本机。", "Quota refreshes every minute. Account credentials stay on this device.")
    @Published var nativeEmail: String?
    @Published var quotaLoginSlot: String?
    @Published var usingLegacyBackend = false
    @Published var targetSlot = "a"
    @Published var pendingSwitch: String?
    @Published var switchMessage = L("在 Codex 完成登录后，将自动核对账号并更新主号标记。", "After you sign in to Codex, the app checks the account and updates the primary label.")
    var action: ((String, String) -> Void)?
}

private struct NativeSettingsView: View {
    @ObservedObject var state: SettingsState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Image(systemName: "arrow.triangle.swap").font(.system(size: 28)).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L("Codex 多账号代理", "Codex Plan Router")).font(.title2.bold())
                        Text(state.online ? L("后台已连接", "Backend connected") : L("后台暂未连接", "Backend disconnected")).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Picker(L("界面语言", "Language"), selection: Binding(
                        get: { state.language },
                        set: { state.action?("language", $0.rawValue) }
                    )) {
                        ForEach(AppLanguage.allCases, id: \.self) { language in
                            Text(language.label).tag(language)
                        }
                    }.labelsHidden().frame(width: 115)
                    Button { state.action?("refresh", "") } label: { Label(L("刷新", "Refresh"), systemImage: "arrow.clockwise") }
                }
                Text(state.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if state.usingLegacyBackend {
                    Button(L("迁移到 App 内置后台…", "Switch to built-in backend…")) { state.action?("adoptBackend", "") }
                }
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text(L("账号", "Accounts")).font(.headline)
                        Spacer()
                        Button { state.action?("login", "") } label: { Label(L("添加账号…", "Add account…"), systemImage: "plus") }
                            .disabled(!state.online)
                    }
                    ForEach(state.snapshot?.accounts.map(\.slot) ?? [], id: \.self) { slot in
                        accountCard(slot)
                    }
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Label(L("连接方式", "Connection"), systemImage: "network").font(.headline)
                            Spacer()
                            Text(state.snapshot?.desktop.enabled == true ? L("桌面代理已启用", "Desktop proxy enabled") : L("官方直连", "Direct connection")).foregroundStyle(.secondary)
                        }
                        VStack(alignment: .leading, spacing: 9) {
                            Text(L("本机 Codex 登录：\(state.nativeEmail ?? "暂未识别")", "Local Codex login: \(state.nativeEmail ?? "Not detected")")).textSelection(.enabled)
                            Text(L("当前统计主号：\(state.snapshot?.primarySlot.uppercased().isEmpty == false ? state.snapshot!.primarySlot.uppercased() : "未指定")", "Primary account for stats: \(state.snapshot?.primarySlot.uppercased().isEmpty == false ? state.snapshot!.primarySlot.uppercased() : "Not set")"))
                                .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Text(L("切换到", "Switch to"))
                                Picker(L("目标账号", "Target account"), selection: $state.targetSlot) {
                                    ForEach(state.snapshot?.accounts.filter(\.registered).map(\.slot) ?? [], id: \.self) { slot in
                                        Text(L("账号 \(slot.uppercased())", "Account \(slot.uppercased())")).tag(slot)
                                    }
                                }.labelsHidden().frame(width: 110).disabled(state.pendingSwitch != nil)
                                if let account = state.snapshot?.accounts.first(where: { $0.slot == state.targetSlot }) {
                                    Text(account.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                Button(state.pendingSwitch == nil ? L("切换登录…", "Switch login…") : L("等待登录…", "Waiting for sign-in…")) { state.action?("switch", state.targetSlot) }
                                    .disabled(!state.online || state.pendingSwitch != nil || state.snapshot?.accounts.first(where: { $0.slot == state.targetSlot })?.registered != true)
                                if state.pendingSwitch != nil {
                                    Button(L("取消", "Cancel")) { state.action?("cancelSwitch", "") }
                                }
                            }
                            Text(state.switchMessage).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Text(L("依据本机登录凭证识别；正在运行的桌面端账号请以 Codex 账号菜单为准。", "This uses the local login. Check the Codex account menu to confirm which account the desktop app is using."))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        HStack {
                            Button(state.snapshot?.desktop.enabled == true ? L("恢复官方直连…", "Restore direct connection…") : L("启用桌面代理…", "Enable desktop proxy…")) { state.action?("mode", "") }
                                .disabled(!state.online || state.snapshot == nil || state.snapshot?.desktop.modified == true || (state.snapshot?.desktop.enabled != true && state.snapshot?.canEnableProxy != true))
                            Spacer()
                            Button(L("查看官方用量 ↗", "View official usage ↗")) { state.action?("usage", "") }
                        }
                        Text(L("连接配置修改后，等任务完成再重新打开 Codex。", "After changing the connection, finish your tasks and reopen Codex.")).font(.caption).foregroundStyle(.secondary)
                    }.padding(12)
                }
                if let snapshot = state.snapshot {
                    Text(L("代理完成 \(snapshot.routed) 次 · 原生通道请求 \(snapshot.fallbacks) 次", "Proxied: \(snapshot.routed) · Direct: \(snapshot.fallbacks)"))
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }.padding(28).disabled(state.busy)
        }.background(Color(nsColor: .windowBackgroundColor))
            .frame(minWidth: 620, minHeight: 680)
    }

    private func accountCard(_ slot: String) -> some View {
        let account = state.snapshot?.accounts.first { $0.slot == slot }
        let quota = state.quota?.account(slot)
        return GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(L("账号 \(slot.uppercased())", "Account \(slot.uppercased())")).font(.headline)
                    Text(account?.email.isEmpty == false ? account!.email : L("尚未连接", "Not connected")).foregroundStyle(.secondary).textSelection(.enabled)
                    Spacer()
                    Text(account?.state ?? L("读取中", "Loading")).font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 24) {
                    quotaColumn(L("五小时剩余", "5-hour remaining"), window: quota?.fiveHour, quota: quota)
                    Divider().frame(height: 52)
                    quotaColumn(L("每周剩余", "Weekly remaining"), window: quota?.weekly, quota: quota)
                    Spacer()
                }
                HStack {
                    Button(account?.registered == true ? L("重新授权订阅…", "Reauthorize…") : L("连接 ChatGPT…", "Connect ChatGPT…")) { state.action?("login", slot) }
                    Button(state.quotaLoginSlot == slot ? L("等待额度授权…", "Waiting for sign-in…") : L("授权额度查询…", "Authorize quota…")) { state.action?("quota", slot) }
                        .disabled(account?.registered != true || state.quotaLoginSlot != nil)
                    Spacer()
                    Button(L("验证订阅", "Verify plan")) { state.action?("verify", slot) }
                        .disabled(account?.enabled != true || account?.needsLogin == true)
                    if account?.registered == true {
                        Button(L("撤销…", "Revoke…")) { state.action?("disconnect", slot) }
                            .disabled((account?.inFlight ?? 0) > 0)
                    }
                }.controlSize(.small).disabled(!state.online)
                if quota?.status == "unavailable" || quota == nil {
                    Text(L("尚未获取额度，点击“授权额度查询”连接此账号。", "Quota is unavailable. Select Authorize quota to connect this account.")).font(.caption).foregroundStyle(.secondary)
                } else if quota?.status == "stale" {
                    Text(L("显示上次查询值，正在等待官方额度更新。", "Showing the last known quota while waiting for an update.")).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(12)
        }
    }

    private func quotaColumn(_ title: String, window: QuotaWindow?, quota: QuotaSnapshot?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(quota?.percent(window) ?? "--").font(.system(size: 25, weight: .semibold, design: .rounded)).monospacedDigit()
            if let reset = window?.resetsAt {
                Text(L("重置 \(Date(timeIntervalSince1970: reset / 1000).formatted(.dateTime.month().day().hour().minute()))", "Resets \(Date(timeIntervalSince1970: reset / 1000).formatted(.dateTime.month().day().hour().minute()))"))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }.frame(minWidth: 180, alignment: .leading)
    }
}

@MainActor
private final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let serviceItem = NSMenuItem(title: L("正在连接后台服务…", "Connecting to backend…"), action: nil, keyEquivalent: "")
    private let modeItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let countsItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let refreshedItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let quotaItem = NSMenuItem(title: L("官方剩余额度：正在获取…", "Official quota: loading…"), action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: L("恢复官方直连", "Restore direct connection"), action: #selector(toggleMode), keyEquivalent: "")
    private let loginItem = NSMenuItem(title: L("登录时启动", "Open at login"), action: #selector(toggleLoginItem), keyEquivalent: "")
    private let accountsMenu = NSMenu()
    private var quotaLoginProcess: Process?
    private let session = makeSession()
    private var timer: Timer?
    private var snapshot: Snapshot?
    private var refreshing = false
    private var changingMode = false
    private var isOnline = false
    private var quota: QuotaCollection?
    private var refreshingQuota = false
    private let settingsState = SettingsState()
    private var settingsWindow: NSWindow?
    private var switchStartedAt: Date?
    private var lastQuotaAttempt = Date.distantPast

    private var backendProcess: Process?
    private var backendInput: Pipe?
    private var waitingToQuit = false

    private func startBundledService() throws {
        guard bundledBackend != nil, backendProcess == nil else { return }
        guard let process = quotaProcess(script: "cli.mjs", arguments: ["serve", "--parent-pipe"]) else {
            throw MenuError.service(L("App 内缺少后台运行文件。", "The app is missing its backend files."))
        }
        let input = Pipe()
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.backendProcess = nil
                self.backendInput = nil
                if self.waitingToQuit {
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else {
                    self.settingsState.message = L("内置后台已停止。可点「刷新」重试。", "The built-in backend stopped. Select Refresh to try again.")
                }
            }
        }
        try process.run()
        backendInput = input
        backendProcess = process
    }

    private func prepareBundledService() async {
        guard bundledBackend != nil else { return }
        let legacyJob = "gui/\(getuid())/com.sun.codex-plan-router"
        let legacyLoaded = await launchctl(["print", legacyJob])
        settingsState.usingLegacyBackend = legacyLoaded && FileManager.default.fileExists(atPath: legacyServiceURL.path)
        if settingsState.usingLegacyBackend {
            settingsState.message = L("检测到旧版后台。等 Codex 任务结束后，可以在这里迁移。", "An older backend is running. You can migrate here once Codex tasks finish.")
            return
        }
        do {
            try startBundledService()
            for _ in 0..<20 {
                guard backendProcess?.isRunning == true else { break }
                try await Task.sleep(nanoseconds: 150_000_000)
                var health = URLRequest(url: URL(string: baseURL + "/health")!)
                health.timeoutInterval = 1
                if let (_, response) = try? await session.data(for: health),
                   (response as? HTTPURLResponse)?.statusCode == 200 { return }
            }
            settingsState.message = L("内置后台暂未就绪，请点「刷新」重试。", "The built-in backend is not ready. Select Refresh to retry.")
        } catch { settingsState.message = error.localizedDescription }
    }

    private func launchctl(_ arguments: [String]) async -> Bool {
        await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return false }
            process.waitUntilExit()
            return process.terminationStatus == 0
        }.value
    }

    private func adoptBackend() {
        guard settingsState.usingLegacyBackend, !settingsState.busy else { return }
        let alert = NSAlert()
        alert.messageText = L("迁移到 App 内置后台？", "Switch to the built-in backend?")
        alert.informativeText = L("等 Codex 任务结束后再迁移。切换期间代理会短暂断开，账号和额度数据会保留。", "Finish your Codex tasks first. The proxy will briefly disconnect and keep your accounts and quota data.")
        alert.addButton(withTitle: L("迁移", "Migrate"))
        alert.addButton(withTitle: L("取消", "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        settingsState.busy = true
        Task {
            defer { settingsState.busy = false }
            let domain = "gui/\(getuid())"
            let service = domain + "/com.sun.codex-plan-router"
            let manager = FileManager.default
            do {
                guard !manager.fileExists(atPath: savedServiceURL.path) else {
                    throw MenuError.service(L("已有旧服务备份，请先检查本机服务状态。", "A backup of the old service exists. Check the local service status first."))
                }
                let data = try await request("status")
                guard let status = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      status["activeRequests"] as? Int == 0 else {
                    throw MenuError.service(L("代理还有请求在运行，请等任务结束后重试。", "The proxy has active requests. Wait for them to finish before retrying."))
                }
                try manager.moveItem(at: legacyServiceURL, to: savedServiceURL)
                guard await launchctl(["bootout", service]) else {
                    try manager.moveItem(at: savedServiceURL, to: legacyServiceURL)
                    throw MenuError.service(L("未能停止旧版后台。", "Could not stop the old backend."))
                }
                do {
                    try startBundledService()
                    var ready = false
                    for _ in 0..<20 {
                        try await Task.sleep(nanoseconds: 250_000_000)
                        if backendProcess?.isRunning == true, (try? await request("status")) != nil { ready = true; break }
                    }
                    guard ready else { throw MenuError.service(L("内置后台未能就绪。", "The built-in backend did not start.")) }
                } catch {
                    if let process = backendProcess, process.isRunning {
                        try? backendInput?.fileHandleForWriting.close()
                        await Task.detached { process.waitUntilExit() }.value
                    }
                    try manager.moveItem(at: savedServiceURL, to: legacyServiceURL)
                    let restored = await launchctl(["bootstrap", domain, legacyServiceURL.path])
                    throw MenuError.service(restored ? L("迁移未完成，已恢复旧版后台。", "Migration failed. The old backend was restored.") : L("迁移未完成，旧版服务配置已恢复，但需要重新登录 macOS 启动。", "Migration failed. The old service configuration was restored. Sign in to macOS again to start it."))
                }
                settingsState.usingLegacyBackend = false
                settingsState.message = L("迁移完成，后台现在由 App 管理。", "Migration complete. The app now manages the backend.")
                await refresh()
            } catch { settingsState.message = error.localizedDescription }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "CodexPlanRouterStatus"
        statusItem.isVisible = true
        updateIcon(symbol: "arrow.triangle.swap", tooltip: L("Codex 多账号代理：正在读取状态", "Codex Plan Router: loading status"))
        rebuildMenu()
        timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh(); await self?.refreshQuota() }
        }
        RunLoop.main.add(timer!, forMode: .common)
        Task { await prepareBundledService(); await refresh(); await refreshQuota() }
        if CommandLine.arguments.contains("--settings")
            || (bundledBackend != nil && !FileManager.default.fileExists(atPath: stateURL.path)) {
            openDashboard()
        }
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        menu.autoenablesItems = false
        menu.delegate = self
        addInfo(appName, bold: true)
        menu.addItem(serviceItem)
        menu.addItem(modeItem)
        menu.addItem(countsItem)
        menu.addItem(quotaItem)
        menu.addItem(.separator())
        let accountsItem = NSMenuItem(title: L("全部账号与额度", "All accounts and quotas"), action: nil, keyEquivalent: "")
        accountsMenu.autoenablesItems = false
        accountsItem.submenu = accountsMenu
        menu.addItem(accountsItem)
        addInfo(L("百分比为官方剩余；观察用量为本地统计", "Remaining quota is official. Observed usage is a local estimate."))
        menu.addItem(.separator())
        addAction(L("打开设置与账号管理…", "Settings and accounts…"), action: #selector(openDashboard), key: ",")
        addAction(L("查看官方用量…", "View official usage…"), action: #selector(openUsage))
        addAction(L("立即刷新", "Refresh now"), action: #selector(refreshNow), key: "r")
        menu.addItem(toggleItem)
        menu.addItem(refreshedItem)
        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)
        refreshLoginItem()
        addAction(L("退出 Codex Plan Router", "Quit Codex Plan Router"), action: #selector(quitMenu), key: "q")
        for item in [serviceItem, modeItem, countsItem, quotaItem, refreshedItem] { item.isEnabled = false }
        toggleItem.target = self
        toggleItem.isEnabled = false
        toggleItem.title = L("恢复官方直连", "Restore direct connection")
        serviceItem.title = L("正在连接后台服务…", "Connecting to backend…")
        quotaItem.title = L("官方剩余额度：正在获取…", "Official quota: loading…")
        refreshedItem.title = ""
        if let snapshot { render(snapshot) }
        statusItem.menu = menu
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openDashboard()
        return true
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshLoginItem()
        Task { await refresh(); await refreshQuota() }
    }

    private func refreshLoginItem() {
        let status = SMAppService.mainApp.status
        loginItem.title = status == .requiresApproval ? L("登录时启动（待批准）", "Open at login (awaiting approval)") : L("登录时启动", "Open at login")
        loginItem.state = status == .enabled ? .on : status == .requiresApproval ? .mixed : .off
    }

    @objc private func toggleLoginItem() {
        if Bundle.main.bundlePath.hasPrefix("/Volumes/") {
            showMessage(L("请先安装 App", "Install the app first"), message: L("将 App 拖入「应用程序」后，重新打开再设置登录时启动。", "Drag the app to Applications and reopen it before setting it to open at login."))
            return
        }

        let service = SMAppService.mainApp
        defer { refreshLoginItem() }
        do {
            switch service.status {
            case .enabled:
                try service.unregister()
            case .requiresApproval:
                let alert = NSAlert()
                alert.messageText = L("登录时启动需要批准", "Opening at login requires approval")
                alert.informativeText = L("在 macOS 的「登录项」中允许 Codex Plan Router。", "Allow Codex Plan Router in macOS Login Items.")
                alert.addButton(withTitle: L("打开系统设置", "Open System Settings"))
                alert.addButton(withTitle: L("取消", "Cancel"))
                alert.addButton(withTitle: L("关闭自启动", "Turn off Open at Login"))
                NSApp.activate(ignoringOtherApps: true)
                let choice = alert.runModal()
                if choice == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
                if choice == .alertThirdButtonReturn { try service.unregister() }
            case .notRegistered, .notFound:
                try service.register()
                if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            @unknown default:
                showMessage(L("暂时无法修改登录项", "Cannot change the login item"), message: L("请在 macOS「系统设置 → 通用 → 登录项」中查看。", "Check System Settings → General → Login Items."))
            }
        } catch {
            showMessage(L("登录项设置未完成", "Could not update the login item"), message: error.localizedDescription)
        }
    }

    private func addInfo(_ title: String, bold: Bool = false) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if bold { item.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.boldSystemFont(ofSize: 13)]) }
        menu.addItem(item)
    }

    private func addAction(_ title: String, action: Selector, key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    private func updateIcon(symbol: String, tooltip: String) {
        guard let button = statusItem.button else { return }
        button.attributedTitle = NSAttributedString(string: "")
        button.image = statusImage(symbol: symbol, quota: quota)
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleNone
        button.toolTip = tooltip
        button.setAccessibilityLabel(appName)
        button.setAccessibilityHelp(tooltip)
    }

    private func refreshQuota(force: Bool = false) async {
        guard !refreshingQuota, force || Date().timeIntervalSince(lastQuotaAttempt) >= 60 else { return }
        refreshingQuota = true
        lastQuotaAttempt = Date()
        defer { refreshingQuota = false }
        quota = await Task.detached(priority: .utility) { queryQuota(force: force) }.value
        if let current = snapshot { render(current) }
        else { updateIcon(symbol: "exclamationmark.circle", tooltip: L("Codex 多账号代理：后台状态暂不可用", "Codex Plan Router: backend status unavailable")) }
    }

    private func request(_ path: String, post: Bool = false, body: [String: String] = [:]) async throws -> Data {
        var request = URLRequest(url: URL(string: "\(baseURL)/admin/\(path)")!)
        request.setValue(AppLanguage.selected.code, forHTTPHeaderField: "Accept-Language")
        request.setValue(try adminKey(), forHTTPHeaderField: "x-router-key")
        if post {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = path == "verify" ? 150 : 30
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MenuError.response }
        guard http.statusCode == 200 else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let error = object?["error"] as? [String: Any]
            throw MenuError.service(error?["message"] as? String ?? L("后台管理请求失败（\(http.statusCode)）", "Backend request failed (HTTP \(http.statusCode))"))
        }
        return data
    }

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let data = try await request("status")
            var current = try JSONDecoder().decode(Snapshot.self, from: data)
            guard current.app == "Codex Plan Router" else { throw MenuError.response }
            snapshot = current
            if await checkPendingSwitch(current) {
                current = try JSONDecoder().decode(Snapshot.self, from: try await request("status"))
                snapshot = current
            }
            isOnline = true
            render(current)
        } catch {
            isOnline = false
            settingsState.online = false
            serviceItem.title = L("后台服务暂不可用", "Backend unavailable")
            modeItem.title = L("请打开设置检查；现有状态保留", "Open Settings to check the connection")
            refreshedItem.title = L("连接失败，10 秒后自动重试", "Connection failed. Retrying in 10 seconds.")
            toggleItem.isEnabled = false
            updateIcon(symbol: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90", tooltip: L("Codex 多账号代理：无法连接后台服务。点击图标查看。", "Codex Plan Router: cannot connect to the backend. Click the icon for details."))
            if statusItem.button?.image == nil { updateIcon(symbol: "exclamationmark.circle", tooltip: L("Codex 多账号代理：后台服务暂不可用", "Codex Plan Router: backend unavailable")) }
        }
    }

    private func render(_ current: Snapshot) {
        settingsState.nativeEmail = nativeLoginEmail()
        settingsState.snapshot = current
        if settingsState.pendingSwitch == nil, !current.accounts.contains(where: { $0.slot == settingsState.targetSlot && $0.registered }),
           let firstSlot = current.accounts.first(where: \.registered)?.slot {
            settingsState.targetSlot = firstSlot
        }
        settingsState.quota = quota
        settingsState.online = isOnline
        let inFlight = current.accounts.reduce(0) { $0 + $1.inFlight }
        serviceItem.title = inFlight > 0 ? L("后台运行中 · \(inFlight) 个订阅请求处理中", "Backend running · \(inFlight) active requests") : L("后台运行中 · 当前空闲", "Backend running · idle")
        modeItem.title = current.desktop.modified ? L("桌面配置有改动，请在设置页检查", "Desktop configuration changed. Check Settings.") : current.desktop.enabled ? L("桌面代理配置：已启用", "Desktop proxy: enabled") : L("桌面代理配置：官方直连", "Desktop proxy: direct connection")
        countsItem.title = L("代理完成 \(current.routed) 次 · 主号回退 \(current.fallbacks) 次", "Proxied: \(current.routed) · Direct: \(current.fallbacks)")
        let extraCount = current.accounts.filter { $0.slot != "a" && $0.slot != "b" }.count
        let barQuotas = quota?.accounts.filter { $0.slot == "a" || $0.slot == "b" }.map(\.title).joined(separator: " | ")
        quotaItem.title = L("官方剩余：", "Official quota:") + (barQuotas ?? L("正在获取…", "Loading…"))
        if extraCount > 0 { quotaItem.title += L(" · 另有 \(extraCount) 个账号", " · \(extraCount) more") }

        accountsMenu.removeAllItems()
        for account in current.accounts {
            let primary = current.primarySlot == account.slot ? L(" · 主号", " · Primary") : ""
            let quotaSummary = quota?.account(account.slot)?.title
            let caption = quotaSummary ?? L("\(account.slot.uppercased()) · 额度未获取", "\(account.slot.uppercased()) · Quota unavailable")
            let item = NSMenuItem(title: caption + primary, action: nil, keyEquivalent: "")
            let detail = NSMenu()
            detail.autoenablesItems = false
            item.submenu = detail
            accountsMenu.addItem(item)
            for title in [account.email.isEmpty ? L("尚未连接账号", "No account connected") : account.email, L("近 5 小时观察用量：\(number(account.observedScore))", "Observed usage (5h): \(number(account.observedScore))"), L("进行中的请求：\(account.inFlight)", "Active requests: \(account.inFlight)")] {
                let row = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                row.isEnabled = false
                detail.addItem(row)
            }
            var quotaRows: [String] = []
            if let accountQuota = quota?.account(account.slot), accountQuota.status != "unavailable" {
                quotaRows = [L("官方五小时剩余：\(accountQuota.percent(accountQuota.fiveHour))", "Official 5-hour remaining: \(accountQuota.percent(accountQuota.fiveHour))"), L("官方每周剩余：\(accountQuota.percent(accountQuota.weekly))", "Official weekly remaining: \(accountQuota.percent(accountQuota.weekly))")]
                for (name, value) in [(L("五小时重置", "5-hour reset"), accountQuota.fiveHour?.resetsAt), (L("每周重置", "Weekly reset"), accountQuota.weekly?.resetsAt)] {
                    if let value {
                        let formatter = DateFormatter()
                        formatter.dateFormat = "MM-dd HH:mm"
                        quotaRows.append("\(name)：\(formatter.string(from: Date(timeIntervalSince1970: value / 1000)))")
                    }
                }
                if let time = accountQuota.updatedAt {
                    let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
                    quotaRows.append(L("额度查询：\(formatter.string(from: Date(timeIntervalSince1970: time / 1000)))\(accountQuota.status == "stale" ? "（上次值）" : "")", "Quota checked: \(formatter.string(from: Date(timeIntervalSince1970: time / 1000)))\(accountQuota.status == "stale" ? " (cached)" : "")"))
                }
            } else {
                quotaRows = [L("官方五小时 / 每周剩余：未获取", "Official 5-hour / weekly quota: unavailable"), L("需补充独立 Codex 登录或更新其授权", "Sign in to Codex for quota access or renew authorization")]
            }
            for title in quotaRows {
                let row = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                row.isEnabled = false
                detail.addItem(row)
            }
            if account.registered {
                detail.addItem(.separator())
                let authorizeItem = NSMenuItem(title: L("授权额度查询…", "Authorize quota…"), action: #selector(authorizeMenuQuota(_:)), keyEquivalent: "")
                authorizeItem.target = self
                authorizeItem.representedObject = account.slot
                authorizeItem.isEnabled = quotaLoginProcess == nil
                detail.addItem(authorizeItem)
            }
            if account.cooldownUntil > Date().timeIntervalSince1970 * 1000 {
                let formatter = DateFormatter()
                formatter.dateFormat = "HH:mm:ss"
                let time = formatter.string(from: Date(timeIntervalSince1970: account.cooldownUntil / 1000))
                let row = NSMenuItem(title: L("暂缓至 \(time)（非官方重置时间）", "Paused until \(time) (local estimate)"), action: nil, keyEquivalent: "")
                row.isEnabled = false
                detail.addItem(row)
            }
        }
        toggleItem.title = changingMode ? L("正在修改配置…", "Updating configuration…") : current.desktop.enabled ? L("恢复官方直连…", "Restore direct connection…") : L("启用桌面代理…", "Enable desktop proxy…")
        toggleItem.isEnabled = !changingMode && !current.desktop.modified && (current.desktop.enabled || current.canEnableProxy)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        refreshedItem.title = L("更新于 \(formatter.string(from: Date())) · 每 10 秒刷新", "Updated at \(formatter.string(from: Date())) · Refreshes every 10 seconds")
        let needsAttention = current.accounts.contains { $0.needsLogin || !$0.verified || !$0.enabled }
        let symbol = needsAttention || current.desktop.modified ? "exclamationmark.circle" : current.desktop.enabled ? "arrow.triangle.swap" : "pause.circle"
        let mode = current.desktop.enabled ? L("代理已启用", "Proxy enabled") : L("官方直连", "Direct connection")
        let stale = quota?.status == "stale" ? L("（上次查询值）", " (cached)") : ""
        updateIcon(symbol: symbol, tooltip: L("Codex 多账号代理 · \(mode)\n\(quotaItem.title)\(stale)\n点击「全部账号与额度」查看各账号\n代理完成 \(current.routed) 次 · 主号回退 \(current.fallbacks) 次", "Codex Plan Router · \(mode)\n\(quotaItem.title)\(stale)\nOpen All accounts and quotas to see each account.\nProxied: \(current.routed) · Direct: \(current.fallbacks)"))
    }

    private func number(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "0"
    }

    @objc private func refreshNow() { Task { await refresh(); await refreshQuota(force: true) } }

    @objc private func authorizeMenuQuota(_ sender: NSMenuItem) {
        guard let slot = sender.representedObject as? String else { return }
        authorizeQuota(slot: slot)
    }

    private func authorizeQuota(slot: String) {
        guard quotaLoginProcess == nil,
              let account = snapshot?.accounts.first(where: { $0.slot == slot && $0.registered }) else { return }
        guard let process = quotaProcess(script: "quota-native.mjs", arguments: ["login", slot]) else {
            showMessage(L("无法启动额度授权", "Could not start quota authorization"), message: L("请检查菜单栏工具的安装状态。", "Check the menu bar app installation."))
            return
        }
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] result in
            let succeeded = result.terminationStatus == 0
            Task { @MainActor in
                guard let self else { return }
                self.quotaLoginProcess = nil
                self.settingsState.quotaLoginSlot = nil
                if succeeded {
                    self.settingsState.message = L("账号 \(slot.uppercased()) 已授权额度查询。", "Quota access granted for account \(slot.uppercased()).")
                    self.lastQuotaAttempt = .distantPast
                    await self.refreshQuota(force: true)
                } else {
                    self.settingsState.message = L("额度授权未完成。请重试，并在官方页面选择 \(account.email)。", "Quota authorization did not finish. Retry and select \(account.email) on the sign-in page.")
                    if self.settingsWindow?.isVisible != true {
                        self.showMessage(L("额度授权未完成", "Quota authorization incomplete"), message: self.settingsState.message)
                    }
                }
            }
        }
        do {
            try process.run()
            quotaLoginProcess = process
            settingsState.quotaLoginSlot = slot
            settingsState.message = L("请在 OpenAI 官方页面登录 \(account.email)。", "Sign in as \(account.email) on the OpenAI page.")
        } catch {
            showMessage(L("无法启动额度授权", "Could not start quota authorization"), message: L("请检查菜单栏工具的安装状态。", "Check the menu bar app installation."))
        }
    }

    @objc private func openDashboard() {
        if settingsWindow == nil {
            settingsState.action = { [weak self] action, slot in self?.settingsAction(action, slot: slot) }
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 770), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = L("设置与账号管理", "Settings and Accounts")
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: NativeSettingsView(state: settingsState))
            window.minSize = NSSize(width: 640, height: 620)
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
        Task { await refresh(); await refreshQuota() }
    }

    private func settingsAction(_ action: String, slot: String) {
        if action == "language", let language = AppLanguage(rawValue: slot) {
            UserDefaults.standard.set(language.rawValue, forKey: "RouterLanguage")
            settingsState.language = language
            settingsWindow?.title = L("设置与账号管理", "Settings and Accounts")
            settingsState.message = L("界面语言已更新。", "Language updated.")
            if settingsState.pendingSwitch == nil {
                settingsState.switchMessage = L("在 Codex 完成登录后，将自动核对账号并更新主号标记。", "After you sign in to Codex, the app checks the account and updates the primary label.")
            }
            rebuildMenu()
            return
        }
        if action == "switch" { beginDesktopSwitch(slot: slot); return }
        if action == "cancelSwitch" {
            settingsState.pendingSwitch = nil
            switchStartedAt = nil
            settingsState.switchMessage = L("已取消等待，主号标记保持原值。", "Stopped waiting. The primary account label stays as it was.")
            return
        }
        if action == "adoptBackend" { adoptBackend(); return }
        if action == "refresh" {
            Task { await prepareBundledService(); await refresh(); await refreshQuota(force: true) }
            return
        }
        if action == "quota" { authorizeQuota(slot: slot); return }
        if action == "usage" { openUsage(); return }
        if action == "mode" { toggleMode(); return }
        guard ["login", "verify", "disconnect"].contains(action), !settingsState.busy else { return }
        if action == "verify" || action == "disconnect" {
            let alert = NSAlert()
            alert.messageText = action == "verify" ? L("验证账号 \(slot.uppercased()) 的订阅？", "Verify the plan for account \(slot.uppercased())?") : L("撤销账号 \(slot.uppercased()) 的订阅授权？", "Revoke plan access for account \(slot.uppercased())?")
            alert.informativeText = action == "verify" ? L("将发送一条很短的真实模型请求，消耗少量订阅额度。", "This sends a short model request and uses some subscription quota.") : L("将断开此工具的订阅连接。", "This removes the app’s subscription access for this account.")
            alert.addButton(withTitle: action == "verify" ? L("验证", "Verify") : L("撤销", "Revoke"))
            alert.addButton(withTitle: L("取消", "Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        settingsState.busy = true
        settingsState.message = L("正在处理…", "Working…")
        Task {
            defer { settingsState.busy = false }
            do {
                let data = try await request(action, post: true, body: ["slot": slot])
                if action == "login" {
                    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    guard let value = object?["url"] as? String, let url = URL(string: value), url.scheme == "https", url.host == "auth.openai.com" else { throw MenuError.response }
                    if !NSWorkspace.shared.open(url) { throw MenuError.service(L("无法打开 OpenAI 官方授权页，请重试。", "Could not open the OpenAI authorization page. Please retry.")) }
                    settingsState.message = slot.isEmpty ? L("在官方页面选择新账号，授权完成后列表会自动更新。", "Choose the new account on the OpenAI page. The list updates after authorization.") : L("请在 OpenAI 官方页面完成授权，再返回此窗口。", "Complete authorization on the OpenAI page, then return here.")
                } else {
                    settingsState.message = action == "verify" ? L("账号 \(slot.uppercased()) 的订阅验证通过。", "Account \(slot.uppercased()) passed plan verification.") : L("设置已更新。", "Settings updated.")
                }
                await refresh()
            } catch { settingsState.message = error.localizedDescription }
        }
    }

    private func beginDesktopSwitch(slot: String) {
        guard let current = snapshot, let target = current.accounts.first(where: { $0.slot == slot }), !target.email.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = L("在 Codex 中切换到账号 \(slot.uppercased())？", "Switch Codex to account \(slot.uppercased())?")
        alert.informativeText = L("目标：\(target.email)\n\n请先完成正在运行的任务，再在 Codex 账号菜单退出当前账号，并登录目标账号。此窗口会等待身份匹配后自动更新统计主号。", "Target: \(target.email)\n\nFinish running tasks. Use the Codex account menu to sign out and sign in to the target account. This app updates the primary label once the account matches.")
        alert.addButton(withTitle: L("打开 Codex", "Open Codex"))
        alert.addButton(withTitle: L("取消", "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let app = URL(fileURLWithPath: "/Applications/ChatGPT.app")
        guard FileManager.default.fileExists(atPath: app.path) else {
            settingsState.switchMessage = L("未找到 Codex 桌面客户端，请手动打开后登录目标账号。", "The Codex desktop client was not found. Open it and sign in to the target account.")
            return
        }
        settingsState.pendingSwitch = slot
        switchStartedAt = Date()
        settingsState.switchMessage = L("等待登录 \(target.email)。在 Codex 账号菜单完成切换后，将自动核对；每 10 秒检查一次。", "Waiting for \(target.email). Complete the switch in Codex. This app checks every 10 seconds.")
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
            if error != nil {
                Task { @MainActor in self?.settingsState.switchMessage = L("未能打开 Codex，请手动打开并登录目标账号。", "Could not open Codex. Open it and sign in to the target account.") }
            }
        }
    }

    private func checkPendingSwitch(_ current: Snapshot) async -> Bool {
        guard let slot = settingsState.pendingSwitch else { return false }
        if let started = switchStartedAt, Date().timeIntervalSince(started) > 900 {
            settingsState.pendingSwitch = nil
            switchStartedAt = nil
            settingsState.switchMessage = L("等待已结束，未修改主号标记。需要时可重新发起切换。", "The sign-in wait expired. Start another switch if needed.")
            return false
        }
        guard let email = nativeLoginEmail(), let target = current.accounts.first(where: { $0.slot == slot }),
              email.caseInsensitiveCompare(target.email) == .orderedSame else { return false }
        do {
            _ = try await request("primary", post: true, body: ["slot": slot])
            settingsState.pendingSwitch = nil
            switchStartedAt = nil
            settingsState.switchMessage = L("本机登录已匹配账号 \(slot.uppercased())，统计主号已更新。请确认 Codex 账号菜单也显示 \(email)。", "The local login matches account \(slot.uppercased()), and the primary label was updated. Check that the Codex menu also shows \(email).")
            return true
        } catch { settingsState.switchMessage = L("账号已匹配，但主号标记更新失败；稍后自动重试。", "The account matches. Updating the primary label failed and will retry automatically."); return false }
    }

    @objc private func openUsage() {
        NSWorkspace.shared.open(URL(string: "https://chatgpt.com/settings/usage")!)
    }

    @objc private func toggleMode() {
        guard let current = snapshot, isOnline, !changingMode else { return }
        let disabling = current.desktop.enabled
        let alert = NSAlert()
        alert.messageText = disabling ? L("恢复官方直连？", "Restore direct connection?") : L("启用桌面代理？", "Enable desktop proxy?")
        alert.informativeText = L("将更新桌面请求配置。请等 Codex 的任务结束后手动重新打开客户端生效，工具不会重启客户端。后台代理会继续运行。", "This updates the desktop connection. Finish your Codex tasks and reopen Codex to apply it. The local backend will keep running.")
        alert.addButton(withTitle: disabling ? L("恢复直连", "Restore direct") : L("启用代理", "Enable proxy"))
        alert.addButton(withTitle: L("取消", "Cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        changingMode = true
        render(current)
        Task {
            defer { changingMode = false; if let current = snapshot { render(current) } }
            do {
                _ = try await request(disabling ? "disable" : "enable", post: true)
                await refresh()
                showMessage(L("配置已更新", "Configuration updated"), message: L("请等所有任务结束后，手动退出并重新打开 Codex。当前聊天不会被本工具重启。", "Finish your tasks, then quit and reopen Codex to apply the change."))
            } catch { showMessage(L("配置未能更新", "Could not update configuration"), message: error.localizedDescription) }
        }
    }

    private func showMessage(_ title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: L("知道了", "OK"))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func quitMenu() {
        if backendProcess?.isRunning == true && snapshot?.desktop.enabled == true {
            let alert = NSAlert()
            alert.messageText = L("退出并停止后台？", "Quit and stop the backend?")
            alert.informativeText = L("若 Codex 仍启用本地代理，退出后请求会暂停。可以重新打开本 App，或先在设置里恢复官方直连。", "If Codex is configured to use the local proxy, requests will stop. Reopen this app, or restore the direct connection in Settings first.")
            alert.addButton(withTitle: L("继续运行", "Keep running"))
            alert.addButton(withTitle: L("退出", "Quit"))
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard backendProcess?.isRunning == true else { return .terminateNow }
        waitingToQuit = true
        try? backendInput?.fileHandleForWriting.close()
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        session.invalidateAndCancel()
    }
}

@main
private struct RouterMenu {
    @MainActor static func main() {
        if let index = CommandLine.arguments.firstIndex(of: "--layout-preview"), CommandLine.arguments.count > index + 1 {
            let data = Data("{\"accounts\":[{\"slot\":\"a\",\"status\":\"ready\",\"fiveHour\":{\"remainingPercent\":76},\"weekly\":{\"remainingPercent\":63}},{\"slot\":\"b\",\"status\":\"ready\",\"fiveHour\":{\"remainingPercent\":48},\"weekly\":{\"remainingPercent\":92}}]}".utf8)
            let quota = try? JSONDecoder().decode(QuotaCollection.self, from: data)
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 560, pixelsHigh: 88, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            bitmap.size = NSSize(width: 140, height: 22)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            NSColor(calibratedWhite: 0.94, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: 140, height: 22).fill()
            statusImage(symbol: "arrow.triangle.swap", quota: quota).draw(in: NSRect(x: 0, y: 0, width: 140, height: 22))
            NSGraphicsContext.restoreGraphicsState()
            if let png = bitmap.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1])) }
            return
        }
        if let index = CommandLine.arguments.firstIndex(of: "--settings-preview"), CommandLine.arguments.count > index + 1 {
            _ = NSApplication.shared
            let state = SettingsState()
            state.online = true
            state.snapshot = try? JSONDecoder().decode(Snapshot.self, from: Data("""
            {"app":"Codex Plan Router","accounts":[{"slot":"a","email":"account-a@example.com","registered":true,"enabled":true,"verified":true,"needsLogin":false,"cooldownUntil":0,"observedScore":100,"inFlight":0},{"slot":"b","email":"account-b@example.com","registered":true,"enabled":true,"verified":true,"needsLogin":false,"cooldownUntil":0,"observedScore":80,"inFlight":0}],"primarySlot":"b","routed":43,"fallbacks":92,"desktop":{"enabled":true,"modified":false}}
            """.utf8))
            state.quota = try? JSONDecoder().decode(QuotaCollection.self, from: Data("""
            {"accounts":[{"slot":"a","status":"ready","fiveHour":{"remainingPercent":0},"weekly":{"remainingPercent":51}},{"slot":"b","status":"ready","fiveHour":{"remainingPercent":47},"weekly":{"remainingPercent":92}}]}
            """.utf8))
            let view = NSHostingView(rootView: NativeSettingsView(state: state))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 770), styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = view
            view.frame = NSRect(x: 0, y: 0, width: 680, height: 770)
            window.display()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.3))
            view.layoutSubtreeIfNeeded()
            if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1])) }
            }
            return
        }
        if CommandLine.arguments.contains("--login-check") {
            let email = nativeLoginEmail()
            let object = (try? Data(contentsOf: stateURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let accounts = object?["accounts"] as? [String: [String: Any]] ?? [:]
            let slot = accounts.first { _, account in
                guard let email, let saved = account["email"] as? String else { return false }
                return email.caseInsensitiveCompare(saved) == .orderedSame
            }?.key
            print(email == nil ? L("本机登录暂未识别；不会更新主号标记。", "Local login was not detected. The primary account label was not updated.") : L("本机登录身份已识别，对应账号：\(slot?.uppercased() ?? "未匹配")。", "Local login detected. Account: \(slot?.uppercased() ?? "No match")."))
            return
        }
        if CommandLine.arguments.contains("--self-check") {
            selfCheck()
            return
        }
        if CommandLine.arguments.contains("--quota-check") {
            if let quota = queryQuota(force: true) {
                print(L("菜单栏显示：\(quota.title)；数据状态：\(quota.status)", "Menu bar quota: \(quota.title). Status: \(quota.status)"))
                if quota.status == "unavailable" { exit(1) }
            } else { print(L("官方额度暂未获取", "Official quota unavailable")); exit(1) }
            return
        }
        // 重复打开应用不会生成多个菜单栏图标。
        if let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let controller = MenuController()
        app.delegate = controller
        app.run()
    }

    private static func selfCheck() {
        do {
            var request = URLRequest(url: URL(string: "\(baseURL)/admin/status")!)
            request.setValue(try adminKey(), forHTTPHeaderField: "x-router-key")
            let session = makeSession()
            let done = DispatchSemaphore(value: 0)
            session.dataTask(with: request) { data, response, _ in
                defer { done.signal() }
                guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                      let status = try? JSONDecoder().decode(Snapshot.self, from: data), status.app == "Codex Plan Router" else {
                    print(L("菜单栏状态检查失败", "Menu bar status check failed"))
                    exit(1)
                }
                print(L("菜单栏状态检查通过：后台在线，\(status.accounts.count) 个账号，代理配置\(status.desktop.enabled ? "已启用" : "未启用")。", "Menu bar status check passed. Backend online, \(status.accounts.count) accounts, proxy \(status.desktop.enabled ? "enabled" : "disabled")."))
            }.resume()
            guard done.wait(timeout: .now() + 12) == .success else {
                print(L("菜单栏状态检查超时", "Menu bar status check timed out"))
                exit(1)
            }
            session.invalidateAndCancel()
        } catch {
            print(L("菜单栏状态检查失败：无法读取本机管理凭证", "Menu bar status check failed: could not read local management credentials."))
            exit(1)
        }
    }
}

import AppKit
import Darwin
import ServiceManagement
import SwiftUI

struct LocalDevice: Codable, Identifiable {
    var id = UUID()
    var localId: String
    var name: String
    var model: String
    var connector: String
    var adbSerial: String? = nil
    var adbPath: String? = nil
    var allowUiDump = false
    var allowControl = false
    var serialPort: String? = nil
    var baudRate: Int? = nil
    var haUrl: String? = nil
    var haToken: String? = nil
    var haEntityId: String? = nil

    var kindLabel: String {
        switch connector {
        case "adb": "Android · ADB"
        case "esp32_serial": "ESP32 · USB 串口"
        case "home_assistant": "Home Assistant"
        default: connector
        }
    }

    var gatewayObject: [String: Any] {
        var value: [String: Any] = ["localId": localId, "name": name, "model": model,
                                     "connector": connector, "allowControl": allowControl,
                                     "allowUiDump": allowUiDump]
        if let adbSerial { value["adbSerial"] = adbSerial }
        if let adbPath { value["adbPath"] = adbPath }
        if let serialPort { value["serialPort"] = serialPort }
        if let baudRate { value["baudRate"] = baudRate }
        if let haUrl { value["haUrl"] = haUrl }
        if let haToken { value["haToken"] = haToken }
        if let haEntityId { value["haEntityId"] = haEntityId }
        return value
    }
}

@MainActor final class ConnectModel: ObservableObject {
    @Published var devices: [LocalDevice] = []
    @Published var status = "尚未连接"
    @Published var detail = "先添加设备，再从 MeshMind 网页导入入网文件。"
    @Published var hub = ""
    @Published var adbDevices: [String] = []
    @Published var serialPorts: [String] = []
    @Published var adbExecutable = ""
    @Published var loginEnabled = false

    private var gatewayProcess: Process?
    private var outputPipe: Pipe?
    private var started = false
    let directory: URL

    private var devicesURL: URL { directory.appendingPathComponent("devices.json") }
    private var configURL: URL { directory.appendingPathComponent("gateway.json") }
    private var stateURL: URL { directory.appendingPathComponent("gateway-state.json") }
    private var enrollmentURL: URL { directory.appendingPathComponent("enrollment.json") }
    var hasIdentity: Bool { FileManager.default.fileExists(atPath: stateURL.path) }
    var hasEnrollment: Bool { FileManager.default.fileExists(atPath: enrollmentURL.path) }
    var isRunning: Bool { gatewayProcess?.isRunning == true }

    init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MeshMind Connect", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                  attributes: [.posixPermissions: 0o700])
        if let data = try? Data(contentsOf: devicesURL),
           let saved = try? JSONDecoder().decode([LocalDevice].self, from: data) { devices = saved }
        if let data = try? Data(contentsOf: stateURL),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { hub = object["hub"] as? String ?? "" }
        loginEnabled = SMAppService.mainApp.status == .enabled
        refreshHardware()
    }

    func startIfReady() {
        if started { return }
        started = true
        if hasIdentity && !devices.isEmpty { start() }
    }

    private func writePrivate(_ data: Data, to url: URL) throws {
        let temporary = url.path + "." + UUID().uuidString + ".tmp"
        let descriptor = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        do {
            try data.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress else { return }
                var offset = 0
                while offset < bytes.count {
                    let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                    if count <= 0 { throw CocoaError(.fileWriteUnknown) }
                    offset += count
                }
            }
            guard Darwin.fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
        } catch {
            Darwin.close(descriptor)
            Darwin.unlink(temporary)
            throw error
        }
        Darwin.close(descriptor)
        if Darwin.rename(temporary, url.path) != 0 {
            Darwin.unlink(temporary)
            throw CocoaError(.fileWriteUnknown)
        }
    }

    func saveDevices() {
        do {
            try writePrivate(JSONEncoder().encode(devices), to: devicesURL)
            try writeGatewayConfig()
            if isRunning { stop(); start() }
            else { detail = "设备配置已保存。" }
        } catch { status = "保存失败"; detail = error.localizedDescription }
    }

    private func writeGatewayConfig() throws {
        let object: [String: Any] = ["devices": devices.map(\.gatewayObject)]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        try writePrivate(data, to: configURL)
    }

    func importEnrollment(_ url: URL) {
        if hasIdentity { status = "已有网关身份"; detail = "同一台 Mac 只需一个网关。直接在下方添加设备即可。"; return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
                  let address = object["hub"], let parsed = URL(string: address),
                  parsed.scheme == "https" || (parsed.scheme == "http" && ["localhost", "127.0.0.1"].contains(parsed.host ?? "")),
                  let token = object["token"], token.hasPrefix("join_") else {
                throw ConnectError.invalidEnrollment
            }
            let safe = try JSONSerialization.data(withJSONObject: ["hub": address, "token": token])
            try writePrivate(safe, to: enrollmentURL)
            hub = address
            status = "入网文件已导入"
            detail = "一次性文件十分钟有效；正在连接…"
            if !devices.isEmpty { start() }
        } catch { status = "导入失败"; detail = error.localizedDescription }
    }

    func start() {
        guard !isRunning else { return }
        guard !devices.isEmpty else { status = "先添加设备"; return }
        guard hasIdentity || hasEnrollment else { status = "需要入网文件"; return }
        guard let resources = Bundle.main.resourceURL else { status = "程序资源缺失"; return }
        do {
            try writeGatewayConfig()
            let process = Process()
            process.executableURL = resources.appendingPathComponent("node")
            process.arguments = [resources.appendingPathComponent("gateway.cjs").path,
                                 "--config", configURL.path, "--state", stateURL.path]
                + (hasIdentity ? [] : ["--enroll", enrollmentURL.path])
            process.currentDirectoryURL = directory
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            outputPipe = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let message = String(data: data, encoding: .utf8) else { return }
                Task { @MainActor [weak self] in self?.received(message) }
            }
            process.terminationHandler = { [weak self, weak process] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.gatewayProcess === process else { return }
                    self.outputPipe?.fileHandleForReading.readabilityHandler = nil
                    self.gatewayProcess = nil
                    self.outputPipe = nil
                    if self.status != "已停止" { self.status = "连接已停止"; self.detail = "检查设备配置与入网文件是否过期。" }
                }
            }
            try process.run()
            gatewayProcess = process
            status = "正在连接"
            detail = "本机网关正在主动连接 MeshMind；设备端口不会对公网开放。"
        } catch { status = "启动失败"; detail = error.localizedDescription }
    }

    private func received(_ message: String) {
        if message.contains("网关已连接") {
            status = "已连接"
            detail = "设备已接入 MeshMind。可以在网页中按设备授权给用户或 Agent。"
            if hasIdentity && hasEnrollment { try? FileManager.default.removeItem(at: enrollmentURL) }
        } else if message.contains("入网失败") || message.contains("网关启动失败") {
            status = "连接失败"
            detail = "请检查入网文件是否过期、设备配置是否正确。"
        } else if message.contains("Hub 连接已关闭") || message.contains("Hub 连接不可用") {
            status = "正在重连"
            detail = "网络中断后会自动尝试重新连接。"
        }
    }

    func stop() {
        guard let process = gatewayProcess else { return }
        status = "已停止"
        detail = "本地网关已停止，网页中的设备将显示离线。"
        process.terminate()
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginEnabled = SMAppService.mainApp.status == .enabled
        } catch { detail = "设置登录启动失败：\(error.localizedDescription)"; loginEnabled = SMAppService.mainApp.status == .enabled }
    }

    func refreshHardware() {
        serialPorts = ((try? FileManager.default.contentsOfDirectory(atPath: "/dev")) ?? [])
            .filter { $0.hasPrefix("cu.usb") || $0.hasPrefix("cu.SLAB") || $0.hasPrefix("cu.wch") }
            .sorted().map { "/dev/" + $0 }
        adbExecutable = ["/opt/homebrew/bin/adb", "/usr/local/bin/adb", "/usr/bin/adb"]
            .first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? ""
        guard !adbExecutable.isEmpty else { adbDevices = []; return }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: adbExecutable)
        process.arguments = ["devices", "-l"]
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let lines = String(data: data, encoding: .utf8)?.components(separatedBy: .newlines) ?? []
            adbDevices = lines.compactMap { line in
                let parts = line.split(whereSeparator: \.isWhitespace).map(String.init)
                return parts.count >= 2 && parts[1] == "device" ? parts[0] : nil
            }
        } catch { adbDevices = [] }
    }
}

enum ConnectError: LocalizedError {
    case invalidEnrollment
    var errorDescription: String? { "入网文件格式或 Hub 地址无效。" }
}

struct ConnectView: View {
    @ObservedObject var model: ConnectModel
    @State private var showImporter = false
    @State private var selectedKind = "adb"
    @State private var name = ""
    @State private var adbSerial = ""
    @State private var allowUiDump = false
    @State private var allowControl = false
    @State private var serialPort = ""
    @State private var baudRate = 115200
    @State private var haUrl = "http://homeassistant.local:8123"
    @State private var haEntityId = ""
    @State private var haToken = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("MeshMind Connect").font(.largeTitle.bold())
                        Text("把这台 Mac 连接的设备安全地接进你的 Mesh。")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label(model.status, systemImage: model.status == "已连接" ? "checkmark.circle.fill" : "circle.dotted")
                        .foregroundStyle(model.status == "已连接" ? .green : .secondary)
                }
                GroupBox("连接状态") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(model.detail).foregroundStyle(.secondary)
                        if !model.hub.isEmpty { LabeledContent("Mesh 地址", value: model.hub) }
                        HStack {
                            Button("打开 Mesh 网页") { NSWorkspace.shared.open(URL(string: "https://mesh.xiaopingfeng.com/")!) }
                            Button("导入 enrollment.json") { showImporter = true }
                                .disabled(model.hasIdentity)
                            Button(model.isRunning ? "停止连接" : "开始连接") {
                                if model.isRunning { model.stop() } else { model.start() }
                            }
                            .disabled(model.devices.isEmpty || (!model.hasIdentity && !model.hasEnrollment))
                        }
                        Toggle("登录 Mac 后自动启动", isOn: Binding(get: { model.loginEnabled }, set: model.setLaunchAtLogin))
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                GroupBox("已添加的设备") {
                    VStack(alignment: .leading, spacing: 10) {
                        if model.devices.isEmpty { Text("还没有设备。下面选择一种接入方式。").foregroundStyle(.secondary) }
                        ForEach(model.devices) { device in
                            HStack {
                                Image(systemName: device.connector == "adb" ? "iphone" : device.connector == "esp32_serial" ? "cable.connector" : "house")
                                VStack(alignment: .leading) {
                                    Text(device.name).fontWeight(.semibold)
                                    Text("\(device.kindLabel) · \(device.model)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("移除") { model.devices.removeAll { $0.id == device.id }; model.saveDevices() }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                GroupBox("添加本地设备") {
                    VStack(alignment: .leading, spacing: 13) {
                        Picker("设备类型", selection: $selectedKind) {
                            Text("Android · ADB").tag("adb")
                            Text("ESP32 · USB 串口").tag("esp32_serial")
                            Text("Home Assistant").tag("home_assistant")
                        }.pickerStyle(.segmented)
                        HStack { TextField("显示名称", text: $name); Button("刷新本机设备") { model.refreshHardware() } }
                        if selectedKind == "adb" {
                            if model.adbExecutable.isEmpty { Text("未找到 adb。请先安装 Android Platform Tools。") .foregroundStyle(.orange) }
                            Picker("已授权 Android", selection: $adbSerial) {
                                Text("请选择").tag("")
                                ForEach(model.adbDevices, id: \.self) { Text($0).tag($0) }
                            }
                            Toggle("允许读取当前界面结构", isOn: $allowUiDump)
                            Toggle("允许获授权的 Agent 直接点击和按键（无需逐次审批，操作会记录）", isOn: $allowControl)
                        } else if selectedKind == "esp32_serial" {
                            Picker("USB 串口", selection: $serialPort) {
                                Text("请选择").tag("")
                                ForEach(model.serialPorts, id: \.self) { Text($0).tag($0) }
                            }
                            Picker("波特率", selection: $baudRate) {
                                ForEach([9600, 57600, 115200, 230400, 460800, 921600], id: \.self) { Text(String($0)).tag($0) }
                            }
                            Text("ESP32 每行输出一个 UTF-8 值，或 JSON：{\"state\":\"online\",\"value\":\"23.5\",\"unit\":\"°C\"}。当前只读取。")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            TextField("Home Assistant 地址", text: $haUrl)
                            TextField("实体 ID，例如 sensor.living_room_temperature", text: $haEntityId)
                            SecureField("长期访问令牌", text: $haToken)
                            Text("只读取指定实体；令牌保存在这台 Mac 的当前用户目录，不上传到 Mesh。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Button("添加设备") { addDevice() }.buttonStyle(.borderedProminent).disabled(!canAdd)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                Text("设备网关从本机主动连接 Mesh；USB、ADB 和 Home Assistant 的地址及凭证只留在本机。Agent 只看到你在网页中单独授权的设备与能力。")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(26).frame(maxWidth: 820)
        }
        .frame(minWidth: 720, minHeight: 680)
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { model.importEnrollment(url) }
        }
        .task { model.startIfReady() }
    }

    private var canAdd: Bool {
        switch selectedKind {
        case "adb": !adbSerial.isEmpty && !model.adbExecutable.isEmpty
        case "esp32_serial": !serialPort.isEmpty
        default: URL(string: haUrl)?.host != nil && haEntityId.contains(".") && !haToken.isEmpty
        }
    }

    private func addDevice() {
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = label.isEmpty ? (selectedKind == "adb" ? "本机 Android" : selectedKind == "esp32_serial" ? "ESP32 串口" : haEntityId) : label
        let localId = "mac-" + UUID().uuidString.lowercased().prefix(12)
        var device = LocalDevice(localId: String(localId), name: title,
                                 model: selectedKind == "adb" ? "Android via ADB" : selectedKind == "esp32_serial" ? "USB serial" : "Home Assistant entity",
                                 connector: selectedKind)
        if selectedKind == "adb" {
            device.adbSerial = adbSerial; device.adbPath = model.adbExecutable
            device.allowUiDump = allowUiDump; device.allowControl = allowControl
        } else if selectedKind == "esp32_serial" {
            device.serialPort = serialPort; device.baudRate = baudRate
        } else { device.haUrl = haUrl; device.haEntityId = haEntityId; device.haToken = haToken; haToken = "" }
        model.devices.append(device)
        model.saveDevices()
        name = ""
    }
}

@main struct MeshMindConnectApp: App {
    @StateObject private var model = ConnectModel()
    var body: some Scene {
        WindowGroup { ConnectView(model: model) }
        MenuBarExtra("MeshMind Connect", systemImage: "point.3.connected.trianglepath.dotted") {
            Text(model.status)
            Button("打开 MeshMind") { NSWorkspace.shared.open(URL(string: "https://mesh.xiaopingfeng.com/")!) }
            Button(model.isRunning ? "停止连接" : "开始连接") { if model.isRunning { model.stop() } else { model.start() } }
            Divider()
            Button("退出") { model.stop(); NSApplication.shared.terminate(nil) }
        }
    }
}

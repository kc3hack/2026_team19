import Foundation
import AVFoundation
@preconcurrency import Speech
@preconcurrency import ScreenCaptureKit
import AppKit
import CoreGraphics
import CoreMedia
import Vapor

struct AgentConfig {
    let host: String
    let port: Int
    let backendBaseURL: String

    static func load() -> AgentConfig {
        let env = loadEnvironment()
        let host = env["LEXIFLOW_AGENT_HOST"] ?? "127.0.0.1"
        let port = Int(env["LEXIFLOW_AGENT_PORT"] ?? "55100") ?? 55100
        let backendBaseURL = env["LEXIFLOW_BACKEND_BASE_URL"] ?? "http://127.0.0.1:8000"
        return AgentConfig(
            host: host,
            port: port,
            backendBaseURL: backendBaseURL
        )
    }

    private static func loadEnvironment() -> [String: String] {
        let processEnv = ProcessInfo.processInfo.environment
        guard let dotenvURL = resolveDotenvURL() else {
            return processEnv
        }

        let dotenvValues = (try? loadDotenv(from: dotenvURL)) ?? [:]
        return dotenvValues.merging(processEnv) { _, processValue in processValue }
    }

    private static func resolveDotenvURL() -> URL? {
        let fileManager = FileManager.default
        let searchRoots = [
            URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true),
            URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
        ]

        for root in searchRoots {
            let dotenvURL = root.appendingPathComponent(".env")
            if fileManager.fileExists(atPath: dotenvURL.path) {
                return dotenvURL
            }
        }

        return nil
    }

    private static func loadDotenv(from url: URL) throws -> [String: String] {
        let contents = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]

        for rawLine in contents.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#") else {
                continue
            }

            let assignment = line.hasPrefix("export ") ? String(line.dropFirst(7)) : line
            guard let separatorIndex = assignment.firstIndex(of: "=") else {
                continue
            }

            let key = assignment[..<separatorIndex].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else {
                continue
            }

            let valueStart = assignment.index(after: separatorIndex)
            let rawValue = assignment[valueStart...].trimmingCharacters(in: .whitespaces)
            values[key] = normalizeDotenvValue(rawValue)
        }

        return values
    }

    private static func normalizeDotenvValue(_ value: String) -> String {
        guard value.count >= 2 else {
            return value
        }

        if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
            (value.hasPrefix("'") && value.hasSuffix("'")) {
            return String(value.dropFirst().dropLast())
        }

        return value
    }
}

@available(macOS 14.0, *)
private final class SystemAudioCaptureController: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputQueue = DispatchQueue(label: "lexiflow.swift-capture-agent.system-audio")
    private let sampleHandler: (CMSampleBuffer) -> Void
    private let errorHandler: (Error) -> Void
    private var stream: SCStream?

    init(
        sampleHandler: @escaping (CMSampleBuffer) -> Void,
        errorHandler: @escaping (Error) -> Void
    ) {
        self.sampleHandler = sampleHandler
        self.errorHandler = errorHandler
    }

    func start(sourceID: String?) async throws {
        let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let target = try resolveTarget(from: shareableContent, sourceID: sourceID)

        let configuration = SCStreamConfiguration()
        configuration.width = target.width
        configuration.height = target.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.queueDepth = 3
        configuration.capturesAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1
        configuration.excludesCurrentProcessAudio = true

        let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: outputQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        guard let stream else { return }
        self.stream = nil
        do {
            try stream.removeStreamOutput(self, type: .audio)
        } catch {
            errorHandler(error)
        }
        do {
            try await stream.stopCapture()
        } catch {
            errorHandler(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        sampleHandler(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        errorHandler(error)
    }

    private func resolveTarget(from content: SCShareableContent, sourceID: String?) throws -> (filter: SCContentFilter, width: Int, height: Int) {
        if let sourceID {
            if let displayID = Self.parseSourceID(sourceID, prefix: "screen"),
               let display = content.displays.first(where: { Int($0.displayID) == displayID }) {
                return (
                    SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []),
                    max(display.width, 2),
                    max(display.height, 2)
                )
            }

            if let windowID = Self.parseSourceID(sourceID, prefix: "window"),
               let window = content.windows.first(where: { Int($0.windowID) == windowID }) {
                return (
                    SCContentFilter(desktopIndependentWindow: window),
                    max(Int(window.frame.width), 2),
                    max(Int(window.frame.height), 2)
                )
            }
        }

        guard let display = content.displays.first else {
            throw NSError(
                domain: "SwiftCaptureAgent",
                code: 2001,
                userInfo: [NSLocalizedDescriptionKey: "No shareable display found for system audio capture"]
            )
        }

        return (
            SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []),
            max(display.width, 2),
            max(display.height, 2)
        )
    }

    private static func parseSourceID(_ raw: String, prefix: String) -> Int? {
        let parts = raw.split(separator: ":")
        guard parts.count >= 2, parts[0] == Substring(prefix) else {
            return nil
        }
        return Int(parts[1])
    }
}

final class AgentRuntime {
    private struct RecognitionSnapshot: Sendable {
        let text: String
        let isFinal: Bool
        let startMs: Int
        let endMs: Int
        let confidence: Double?
    }

    private let queue = DispatchQueue(label: "lexiflow.swift-capture-agent.runtime")
    private let config: AgentConfig
    private let logger: Logger

    private let protocolVersion = "1.0.0"
    private let wsSubprotocol = "lexiflow.capture.v1"
    private let allowedSources: Set<String> = ["microphone", "system_audio"]

    private var connectedClients: [ObjectIdentifier: WebSocket] = [:]
    private var controllerClientID: ObjectIdentifier?

    private var isCapturing = false
    private var sessionID = ""
    private var activeSources: Set<String> = []
    private var autoLaunchEnabled = false

    private var emitPartials = true
    private var analyzeOnFinal = true
    private var includeDictionary = true
    private var language = "ja-JP"
    private var selectedSystemAudioSourceID: String?

    private var sequenceBySource: [String: Int] = [:]
    private var activeUtteranceIDBySource: [String: String] = [:]

    private var microphonePermission = "unknown"
    private var speechPermission = "unknown"
    private var screenPermission = "unknown"

    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionStartWallMs: Int = 0
    private var recognitionSource: String?
    private var systemAudioCaptureController: SystemAudioCaptureController?

    init(config: AgentConfig, logger: Logger) {
        self.config = config
        self.logger = logger
    }

    var requiredSubprotocol: String {
        wsSubprotocol
    }

    func connect(_ ws: WebSocket) {
        queue.async {
            let id = ObjectIdentifier(ws)
            self.connectedClients[id] = ws
            self.refreshPermissionSnapshot()
            self.logger.info("ws client connected")
            self.sendReady(to: ws)
            self.sendStateChanged(to: ws)
        }
    }

    func disconnect(_ ws: WebSocket) {
        queue.async {
            let id = ObjectIdentifier(ws)
            self.connectedClients.removeValue(forKey: id)
            if self.controllerClientID == id {
                self.stopCapture(reason: "client_disconnected")
                self.controllerClientID = nil
            }
            self.logger.info("ws client disconnected")
        }
    }

    func handleText(_ text: String, from ws: WebSocket) {
        queue.async {
            do {
                let envelope = try self.parseEnvelope(text)
                guard envelope.kind == "command" else {
                    self.sendErrorEvent(
                        code: "INTERNAL_ERROR",
                        message: "kind must be command for client->agent",
                        recoverable: true,
                        to: ws
                    )
                    return
                }

                guard envelope.version == self.protocolVersion else {
                    self.sendResponse(
                        name: envelope.name,
                        requestID: envelope.requestID ?? UUID().uuidString.lowercased(),
                        ok: false,
                        error: self.makeError(
                            code: "INTERNAL_ERROR",
                            message: "unsupported protocol version",
                            recoverable: false
                        ),
                        extra: [:],
                        to: ws
                    )
                    return
                }

                guard let requestID = envelope.requestID else {
                    self.sendErrorEvent(
                        code: "INTERNAL_ERROR",
                        message: "request_id is required for command",
                        recoverable: true,
                        to: ws
                    )
                    return
                }

                switch envelope.name {
                case "hello":
                    self.handleHello(requestID: requestID, to: ws)
                case "get_status":
                    self.handleGetStatus(requestID: requestID, to: ws)
                case "start_capture":
                    self.handleStartCapture(payload: envelope.payload, requestID: requestID, ws: ws)
                case "stop_capture":
                    self.handleStopCapture(requestID: requestID, ws: ws)
                case "set_source_enabled":
                    self.handleSetSourceEnabled(payload: envelope.payload, requestID: requestID, ws: ws)
                case "open_settings":
                    self.handleOpenSettings(payload: envelope.payload, requestID: requestID, ws: ws)
                case "set_auto_launch":
                    self.handleSetAutoLaunch(payload: envelope.payload, requestID: requestID, ws: ws)
                default:
                    self.sendResponse(
                        name: envelope.name,
                        requestID: requestID,
                        ok: false,
                        error: self.makeError(
                            code: "INTERNAL_ERROR",
                            message: "unknown command: \(envelope.name)",
                            recoverable: true
                        ),
                        extra: [:],
                        to: ws
                    )
                }
            } catch {
                self.sendErrorEvent(
                    code: "INTERNAL_ERROR",
                    message: "failed to parse command: \(error.localizedDescription)",
                    recoverable: true,
                    to: ws
                )
            }
        }
    }

    private func handleHello(requestID: String, to ws: WebSocket) {
        let payload: [String: Any] = [
            "agent_version": "0.1.0",
            "protocol_version": protocolVersion,
            "capabilities": ["microphone_stt", "system_audio_stt", "backend_analyze_text", "ws_protocol_v1"]
        ]
        sendResponse(name: "hello", requestID: requestID, ok: true, error: nil, extra: payload, to: ws)
    }

    private func handleGetStatus(requestID: String, to ws: WebSocket) {
        refreshPermissionSnapshot()
        sendResponse(
            name: "get_status",
            requestID: requestID,
            ok: true,
            error: nil,
            extra: [
                "state": statePayload(),
                "auto_launch": autoLaunchEnabled
            ],
            to: ws
        )
    }

    private func handleStartCapture(payload: [String: Any], requestID: String, ws: WebSocket) {
        guard let requestedSessionID = payload["session_id"] as? String, !requestedSessionID.isEmpty else {
            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(code: "CAPTURE_START_FAILED", message: "session_id is required", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }

        let rawSources = (payload["sources"] as? [String])
            ?? ((payload["sources"] as? [Any])?.compactMap { $0 as? String })
            ?? []

        guard !rawSources.isEmpty else {
            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(code: "CAPTURE_START_FAILED", message: "sources is required", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }

        let sources = Set(rawSources)
        guard sources.isSubset(of: allowedSources) else {
            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(code: "CAPTURE_START_FAILED", message: "sources must be microphone/system_audio", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }

        sessionID = requestedSessionID
        activeSources = sources
        controllerClientID = ObjectIdentifier(ws)
        selectedSystemAudioSourceID = (payload["source_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        language = (payload["language"] as? String) ?? "ja-JP"
        emitPartials = (payload["emit_partials"] as? Bool) ?? true
        analyzeOnFinal = (payload["analyze_on_final"] as? Bool) ?? true
        includeDictionary = (payload["include_dictionary"] as? Bool) ?? true

        requestStartCapturePermissionsAndStart(requestID: requestID, ws: ws)
    }

    private func handleStopCapture(requestID: String, ws: WebSocket) {
        stopCapture(reason: "requested")
        sendResponse(name: "stop_capture", requestID: requestID, ok: true, error: nil, extra: [:], to: ws)
    }

    private func handleSetSourceEnabled(payload: [String: Any], requestID: String, ws: WebSocket) {
        guard let source = payload["source"] as? String, allowedSources.contains(source) else {
            sendResponse(
                name: "set_source_enabled",
                requestID: requestID,
                ok: false,
                error: makeError(code: "CAPTURE_START_FAILED", message: "invalid source", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }
        guard let enabled = payload["enabled"] as? Bool else {
            sendResponse(
                name: "set_source_enabled",
                requestID: requestID,
                ok: false,
                error: makeError(code: "CAPTURE_START_FAILED", message: "enabled is required", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }

        if enabled {
            activeSources.insert(source)
        } else {
            activeSources.remove(source)
            if source == "microphone" || activeSources.isEmpty {
                stopCapture(reason: "no_active_source")
            }
        }

        sendResponse(name: "set_source_enabled", requestID: requestID, ok: true, error: nil, extra: [:], to: ws)
        sendStateChanged(to: nil)
    }

    private func handleOpenSettings(payload: [String: Any], requestID: String, ws: WebSocket) {
        let target = payload["target"] as? String ?? "microphone"
        let opened = openSystemSettings(target: target)
        if !opened {
            sendResponse(
                name: "open_settings",
                requestID: requestID,
                ok: false,
                error: makeError(
                    code: "INTERNAL_ERROR",
                    message: "failed to open settings for \(target)",
                    recoverable: true
                ),
                extra: [:],
                to: ws
            )
            return
        }
        sendResponse(
            name: "open_settings",
            requestID: requestID,
            ok: true,
            error: nil,
            extra: ["target": target],
            to: ws
        )
    }

    private func openSystemSettings(target: String) -> Bool {
        let urlString: String
        switch target {
        case "microphone":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case "speech":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
        case "screen":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        default:
            urlString = "x-apple.systempreferences:com.apple.preference.security"
        }
        guard let url = URL(string: urlString) else {
            return false
        }
        return NSWorkspace.shared.open(url)
    }

    private func handleSetAutoLaunch(payload: [String: Any], requestID: String, ws: WebSocket) {
        guard let enabled = payload["enabled"] as? Bool else {
            sendResponse(
                name: "set_auto_launch",
                requestID: requestID,
                ok: false,
                error: makeError(code: "INTERNAL_ERROR", message: "enabled is required", recoverable: true),
                extra: [:],
                to: ws
            )
            return
        }
        autoLaunchEnabled = enabled
        sendResponse(
            name: "set_auto_launch",
            requestID: requestID,
            ok: true,
            error: nil,
            extra: ["enabled": autoLaunchEnabled],
            to: ws
        )
    }

    private func requestStartCapturePermissionsAndStart(requestID: String, ws: WebSocket) {
        let needsMicrophone = activeSources.contains("microphone")
        let needsScreen = activeSources.contains("system_audio")

        if needsMicrophone {
            requestMicrophonePermission { [weak self] microphoneGranted in
                guard let self else { return }
                self.queue.async {
                    self.refreshPermissionSnapshot()
                    if !microphoneGranted {
                        self.sendEvent(
                            name: "permission_required",
                            payload: [
                                "target": "microphone",
                                "message": "マイク権限が必要です。システム設定で許可してください。"
                            ],
                            to: ws
                        )
                        self.sendResponse(
                            name: "start_capture",
                            requestID: requestID,
                            ok: false,
                            error: self.makeError(
                                code: "PERMISSION_DENIED_MICROPHONE",
                                message: "microphone permission denied",
                                recoverable: true
                            ),
                            extra: [:],
                            to: ws
                        )
                        self.sendStateChanged(to: nil)
                        return
                    }

                    if needsScreen {
                        self.requestScreenPermissionThenSpeechAndStart(requestID: requestID, ws: ws)
                    } else {
                        self.requestSpeechPermissionAndStart(requestID: requestID, ws: ws)
                    }
                }
            }
            return
        }

        if needsScreen {
            requestScreenPermissionThenSpeechAndStart(requestID: requestID, ws: ws)
            return
        }

        sendResponse(
            name: "start_capture",
            requestID: requestID,
            ok: false,
            error: makeError(code: "CAPTURE_START_FAILED", message: "no active source configured", recoverable: true),
            extra: [:],
            to: ws
        )
        sendStateChanged(to: nil)
    }

    private func requestScreenPermissionThenSpeechAndStart(requestID: String, ws: WebSocket) {
        requestScreenCapturePermission { [weak self] screenGranted in
            guard let self else { return }
            self.queue.async {
                self.refreshPermissionSnapshot()
                if !screenGranted {
                    self.sendEvent(
                        name: "permission_required",
                        payload: [
                            "target": "screen",
                            "message": "画面収録権限が必要です。システム設定で許可してください。"
                        ],
                        to: ws
                    )
                    self.sendResponse(
                        name: "start_capture",
                        requestID: requestID,
                        ok: false,
                        error: self.makeError(
                            code: "PERMISSION_DENIED_SCREEN",
                            message: "screen capture permission denied",
                            recoverable: true
                        ),
                        extra: [:],
                        to: ws
                    )
                    self.sendStateChanged(to: nil)
                    return
                }

                self.requestSpeechPermissionAndStart(requestID: requestID, ws: ws)
            }
        }
    }

    private func requestSpeechPermissionAndStart(requestID: String, ws: WebSocket) {
        requestSpeechPermission { [weak self] speechGranted in
            guard let self else { return }
            self.queue.async {
                self.refreshPermissionSnapshot()
                if !speechGranted {
                    self.sendEvent(
                        name: "permission_required",
                        payload: [
                            "target": "speech",
                            "message": "音声認識権限が必要です。システム設定で許可してください。"
                        ],
                        to: ws
                    )
                    self.sendResponse(
                        name: "start_capture",
                        requestID: requestID,
                        ok: false,
                        error: self.makeError(
                            code: "PERMISSION_DENIED_SPEECH",
                            message: "speech recognition permission denied",
                            recoverable: true
                        ),
                        extra: [:],
                        to: ws
                    )
                    self.sendStateChanged(to: nil)
                    return
                }

                self.startConfiguredCapture(requestID: requestID, ws: ws)
            }
        }
    }

    private func requestMicrophonePermission(completion: @escaping @Sendable (Bool) -> Void) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        microphonePermission = Self.microphonePermissionString(status)
        switch status {
        case .authorized:
            completion(true)
        case .denied, .restricted:
            completion(false)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                completion(granted)
            }
        @unknown default:
            completion(false)
        }
    }

    private func requestSpeechPermission(completion: @escaping @Sendable (Bool) -> Void) {
        let status = SFSpeechRecognizer.authorizationStatus()
        speechPermission = Self.speechPermissionString(status)
        switch status {
        case .authorized:
            completion(true)
        case .denied, .restricted:
            completion(false)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { auth in
                completion(auth == .authorized)
            }
        @unknown default:
            completion(false)
        }
    }

    private func requestScreenCapturePermission(completion: @escaping @Sendable (Bool) -> Void) {
        if CGPreflightScreenCaptureAccess() {
            screenPermission = "granted"
            completion(true)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let granted = CGRequestScreenCaptureAccess()
            guard let runtime = self else {
                completion(granted)
                return
            }
            runtime.queue.async {
                runtime.screenPermission = granted ? "granted" : "denied"
                completion(granted)
            }
        }
    }

    private func startConfiguredCapture(requestID: String, ws: WebSocket) {
        if activeSources.count > 1 {
            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(
                    code: "CAPTURE_START_FAILED",
                    message: "simultaneous microphone and system_audio capture is not implemented yet",
                    recoverable: true
                ),
                extra: [:],
                to: ws
            )
            sendStateChanged(to: nil)
            return
        }

        do {
            if activeSources.contains("microphone") {
                try startMicrophoneRecognition()
                sendResponse(name: "start_capture", requestID: requestID, ok: true, error: nil, extra: [:], to: ws)
                sendStateChanged(to: nil)
                return
            }
        } catch {
            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(
                    code: "CAPTURE_START_FAILED",
                    message: "failed to start microphone capture: \(error.localizedDescription)",
                    recoverable: true
                ),
                extra: [:],
                to: ws
            )
            sendErrorEvent(
                code: "CAPTURE_START_FAILED",
                message: "failed to start microphone capture: \(error.localizedDescription)",
                recoverable: true,
                to: nil
            )
            sendStateChanged(to: nil)
            return
        }

        if activeSources.contains("system_audio") {
            if #available(macOS 14.0, *) {
                Task { [weak self] in
                    do {
                        try await self?.startSystemAudioRecognition(sourceID: self?.selectedSystemAudioSourceID)
                        guard let self else { return }
                        self.queue.async {
                            self.sendResponse(name: "start_capture", requestID: requestID, ok: true, error: nil, extra: [:], to: ws)
                            self.sendStateChanged(to: nil)
                        }
                    } catch {
                        guard let self else { return }
                        self.queue.async {
                            self.sendResponse(
                                name: "start_capture",
                                requestID: requestID,
                                ok: false,
                                error: self.makeError(
                                    code: "CAPTURE_START_FAILED",
                                    message: "failed to start system audio capture: \(error.localizedDescription)",
                                    recoverable: true
                                ),
                                extra: [:],
                                to: ws
                            )
                            self.sendErrorEvent(
                                code: "CAPTURE_START_FAILED",
                                message: "failed to start system audio capture: \(error.localizedDescription)",
                                recoverable: true,
                                to: nil
                            )
                            self.sendStateChanged(to: nil)
                        }
                    }
                }
                return
            }

            sendResponse(
                name: "start_capture",
                requestID: requestID,
                ok: false,
                error: makeError(
                    code: "SYSTEM_AUDIO_NOT_SUPPORTED",
                    message: "system audio capture requires macOS 14 or later",
                    recoverable: true
                ),
                extra: [:],
                to: ws
            )
            sendStateChanged(to: nil)
            return
        }

        sendResponse(
            name: "start_capture",
            requestID: requestID,
            ok: false,
            error: makeError(code: "CAPTURE_START_FAILED", message: "no supported source selected", recoverable: true),
            extra: [:],
            to: ws
        )
        sendStateChanged(to: nil)
    }

    private func startMicrophoneRecognition() throws {
        stopSystemAudioCapture()
        stopRecognitionSession()

        let locale = Locale(identifier: language)
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw NSError(domain: "SwiftCaptureAgent", code: 1, userInfo: [NSLocalizedDescriptionKey: "SFSpeechRecognizer not available"])
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        recognitionStartWallMs = currentTimestampMs()
        recognitionRequest = request
        recognitionSource = "microphone"
        isCapturing = true
        activeUtteranceIDBySource["microphone"] = makeUtteranceID()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            let snapshot = result.flatMap { self.makeRecognitionSnapshot(from: $0) }
            let errorMessage = error?.localizedDescription
            self.queue.async {
                if let snapshot {
                    self.handleRecognitionSnapshot(snapshot, source: self.recognitionSource ?? "microphone")
                }
                if let errorMessage {
                    self.sendErrorEvent(
                        code: "STT_NOT_AVAILABLE",
                        message: "speech recognition error: \(errorMessage)",
                        recoverable: true,
                        to: nil
                    )
                    if self.isCapturing {
                        self.stopCapture(reason: "stt_error")
                    }
                }
            }
        }
    }

    @available(macOS 14.0, *)
    private func startSystemAudioRecognition(sourceID: String?) async throws {
        stopMicrophoneCapture()
        stopRecognitionSession()

        let locale = Locale(identifier: language)
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw NSError(domain: "SwiftCaptureAgent", code: 2, userInfo: [NSLocalizedDescriptionKey: "SFSpeechRecognizer not available"])
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation

        let controller = SystemAudioCaptureController(
            sampleHandler: { [weak self] sampleBuffer in
                self?.recognitionRequest?.appendAudioSampleBuffer(sampleBuffer)
            },
            errorHandler: { [weak self] error in
                guard let runtime = self else { return }
                runtime.queue.async {
                    runtime.sendErrorEvent(
                        code: "CAPTURE_START_FAILED",
                        message: "system audio stream error: \(error.localizedDescription)",
                        recoverable: true,
                        to: nil
                    )
                    if runtime.isCapturing {
                        runtime.stopCapture(reason: "system_audio_error")
                    }
                }
            }
        )

        try await controller.start(sourceID: sourceID)

        recognitionStartWallMs = currentTimestampMs()
        recognitionRequest = request
        recognitionSource = "system_audio"
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            let snapshot = result.flatMap { self.makeRecognitionSnapshot(from: $0) }
            let errorMessage = error?.localizedDescription
            self.queue.async {
                if let snapshot {
                    self.handleRecognitionSnapshot(snapshot, source: self.recognitionSource ?? "system_audio")
                }
                if let errorMessage {
                    self.sendErrorEvent(
                        code: "STT_NOT_AVAILABLE",
                        message: "speech recognition error: \(errorMessage)",
                        recoverable: true,
                        to: nil
                    )
                    if self.isCapturing {
                        self.stopCapture(reason: "stt_error")
                    }
                }
            }
        }

        systemAudioCaptureController = controller
        isCapturing = true
        activeUtteranceIDBySource["system_audio"] = makeUtteranceID()
    }

    private func stopRecognitionSession() {
        recognitionTask?.cancel()
        recognitionTask = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionSource = nil

        stopMicrophoneCapture()
    }

    private func stopMicrophoneCapture() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func stopSystemAudioCapture() {
        guard let controller = systemAudioCaptureController else { return }
        systemAudioCaptureController = nil
        Task {
            await controller.stop()
        }
    }

    private func makeRecognitionSnapshot(from result: SFSpeechRecognitionResult) -> RecognitionSnapshot? {
        let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return nil
        }

        let segments = result.bestTranscription.segments
        let nowMs = currentTimestampMs()
        let startMs: Int
        let endMs: Int
        if let first = segments.first, let last = segments.last {
            startMs = recognitionStartWallMs + Int(first.timestamp * 1000)
            endMs = recognitionStartWallMs + Int((last.timestamp + last.duration) * 1000)
        } else {
            startMs = max(0, nowMs - 500)
            endMs = nowMs
        }

        return RecognitionSnapshot(
            text: text,
            isFinal: result.isFinal,
            startMs: startMs,
            endMs: endMs,
            confidence: averageConfidence(from: segments.map { $0.confidence })
        )
    }

    private func handleRecognitionSnapshot(_ snapshot: RecognitionSnapshot, source: String) {
        let utteranceID = ensureActiveUtteranceID(for: source)
        let seq = nextSequence(for: source)

        if snapshot.isFinal {
            sendEvent(
                name: "final_transcript",
                payload: transcriptPayload(
                    sessionID: sessionID,
                    source: source,
                    utteranceID: utteranceID,
                    seq: seq,
                    text: snapshot.text,
                    isFinal: true,
                    confidence: snapshot.confidence ?? 0.9,
                    language: language,
                    startMs: snapshot.startMs,
                    endMs: snapshot.endMs
                ),
                to: nil
            )
            if analyzeOnFinal {
                callAnalyzeText(
                    sessionID: sessionID,
                    source: source,
                    utteranceID: utteranceID,
                    seq: seq,
                    text: snapshot.text,
                    startMs: snapshot.startMs,
                    endMs: snapshot.endMs,
                    includeDictionary: includeDictionary
                )
            }
            activeUtteranceIDBySource[source] = makeUtteranceID()
            return
        }

        if emitPartials {
            sendEvent(
                name: "partial_transcript",
                payload: transcriptPayload(
                    sessionID: sessionID,
                    source: source,
                    utteranceID: utteranceID,
                    seq: seq,
                    text: snapshot.text,
                    isFinal: false,
                    confidence: snapshot.confidence ?? 0.5,
                    language: language,
                    startMs: snapshot.startMs,
                    endMs: snapshot.endMs
                ),
                to: nil
            )
        }
    }

    private func averageConfidence(from values: [Float]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sum = values.reduce(0.0) { partial, value in
            partial + Double(value)
        }
        let avg = sum / Double(values.count)
        return max(0.0, min(1.0, avg))
    }

    private func nextSequence(for source: String) -> Int {
        let seq = sequenceBySource[source, default: 0]
        sequenceBySource[source] = seq + 1
        return seq
    }

    private func makeUtteranceID() -> String {
        "utt-\(UUID().uuidString.lowercased())"
    }

    private func ensureActiveUtteranceID(for source: String) -> String {
        if let existing = activeUtteranceIDBySource[source] {
            return existing
        }
        let created = makeUtteranceID()
        activeUtteranceIDBySource[source] = created
        return created
    }

    private static func microphonePermissionString(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "not_determined"
        @unknown default:
            return "unknown"
        }
    }

    private static func speechPermissionString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "not_determined"
        @unknown default:
            return "unknown"
        }
    }

    private func refreshPermissionSnapshot() {
        microphonePermission = Self.microphonePermissionString(AVCaptureDevice.authorizationStatus(for: .audio))
        speechPermission = Self.speechPermissionString(SFSpeechRecognizer.authorizationStatus())
        if CGPreflightScreenCaptureAccess() {
            screenPermission = "granted"
        } else if screenPermission != "denied" {
            screenPermission = "not_determined"
        }
    }

    private func callAnalyzeText(
        sessionID: String,
        source: String,
        utteranceID: String,
        seq: Int,
        text: String,
        startMs: Int,
        endMs: Int,
        includeDictionary: Bool
    ) {
        guard let url = URL(string: "\(config.backendBaseURL)/pipeline/analyze-text") else {
            sendErrorEvent(code: "BACKEND_UNAVAILABLE", message: "invalid backend url", recoverable: true, to: nil)
            return
        }

        let body: [String: Any] = [
            "session_id": sessionID,
            "source": source,
            "utterance_id": utteranceID,
            "seq": seq,
            "text": text,
            "is_final": true,
            "confidence": 0.9,
            "language": language,
            "start_ms": startMs,
            "end_ms": endMs,
            "include_dictionary": includeDictionary,
            "dictionary_top_k": 5,
            "deduplicate": false,
            "min_length": 1,
            "normalize_sentence_vector": true,
            "metadata": [
                "agent_version": "0.1.0",
                "device_name": Host.current().localizedName ?? "macOS"
            ]
        ]

        guard let payloadData = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            sendErrorEvent(code: "INTERNAL_ERROR", message: "failed to encode analyze request", recoverable: true, to: nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = payloadData

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async {
                if let error {
                    self.sendErrorEvent(
                        code: "BACKEND_UNAVAILABLE",
                        message: "backend request failed: \(error.localizedDescription)",
                        recoverable: true,
                        to: nil
                    )
                    return
                }

                guard let http = response as? HTTPURLResponse else {
                    self.sendErrorEvent(
                        code: "BACKEND_UNAVAILABLE",
                        message: "backend response is not HTTP",
                        recoverable: true,
                        to: nil
                    )
                    return
                }

                guard (200..<300).contains(http.statusCode) else {
                    self.sendErrorEvent(
                        code: "BACKEND_TIMEOUT",
                        message: "backend returned status \(http.statusCode)",
                        recoverable: true,
                        to: nil
                    )
                    return
                }

                guard
                    let data,
                    let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
                else {
                    self.sendErrorEvent(
                        code: "INTERNAL_ERROR",
                        message: "failed to decode backend response",
                        recoverable: true,
                        to: nil
                    )
                    return
                }

                let payload: [String: Any] = [
                    "session_id": sessionID,
                    "source": source,
                    "utterance_id": utteranceID,
                    "analysis": json["analysis"] as? [String: Any] ?? [:],
                    "dictionary": json["dictionary"] as? [String: Any] ?? [:],
                    "seq": seq
                ]
                self.sendEvent(name: "analysis_result", payload: payload, to: nil)
            }
        }.resume()
    }

    private func stopCapture(reason: String) {
        guard isCapturing else { return }
        stopRecognitionSession()
        stopSystemAudioCapture()
        isCapturing = false
        activeSources.removeAll()
        sequenceBySource.removeAll()
        activeUtteranceIDBySource.removeAll()
        selectedSystemAudioSourceID = nil

        sendEvent(
            name: "capture_stopped",
            payload: [
                "session_id": sessionID,
                "reason": reason
            ],
            to: nil
        )
        sendStateChanged(to: nil)
    }

    private func sendReady(to ws: WebSocket) {
        sendEvent(
            name: "ready",
            payload: [
                "agent_version": "0.1.0",
                "capabilities": ["microphone_stt", "system_audio_stt", "backend_analyze_text", "ws_protocol_v1"]
            ],
            to: ws
        )
    }

    private func sendStateChanged(to ws: WebSocket?) {
        sendEvent(name: "state_changed", payload: statePayload(), to: ws)
    }

    private func statePayload() -> [String: Any] {
        [
            "is_capturing": isCapturing,
            "session_id": sessionID,
            "active_sources": activeSources.sorted(),
            "permissions": [
                "microphone": microphonePermission,
                "screen": screenPermission,
                "speech": speechPermission
            ]
        ]
    }

    private func transcriptPayload(
        sessionID: String,
        source: String,
        utteranceID: String,
        seq: Int,
        text: String,
        isFinal: Bool,
        confidence: Double,
        language: String,
        startMs: Int,
        endMs: Int
    ) -> [String: Any] {
        [
            "session_id": sessionID,
            "source": source,
            "utterance_id": utteranceID,
            "seq": seq,
            "text": text,
            "is_final": isFinal,
            "confidence": confidence,
            "language": language,
            "start_ms": startMs,
            "end_ms": endMs
        ]
    }

    private func sendResponse(
        name: String,
        requestID: String,
        ok: Bool,
        error: [String: Any]?,
        extra: [String: Any],
        to ws: WebSocket
    ) {
        var payload = extra
        payload["ok"] = ok
        if let error {
            payload["error"] = error
        }

        let envelope = makeEnvelope(
            kind: "response",
            name: name,
            requestID: requestID,
            payload: payload
        )
        sendJSON(envelope, to: ws)
    }

    private func sendEvent(name: String, payload: [String: Any], to ws: WebSocket?) {
        let envelope = makeEnvelope(kind: "event", name: name, requestID: nil, payload: payload)
        if let ws {
            sendJSON(envelope, to: ws)
            return
        }
        for client in connectedClients.values {
            sendJSON(envelope, to: client)
        }
    }

    private func sendErrorEvent(code: String, message: String, recoverable: Bool, to ws: WebSocket?) {
        sendEvent(
            name: "error",
            payload: makeError(code: code, message: message, recoverable: recoverable),
            to: ws
        )
    }

    private func makeError(code: String, message: String, recoverable: Bool) -> [String: Any] {
        [
            "code": code,
            "message": message,
            "recoverable": recoverable
        ]
    }

    private func makeEnvelope(kind: String, name: String, requestID: String?, payload: [String: Any]) -> [String: Any] {
        var envelope: [String: Any] = [
            "version": protocolVersion,
            "kind": kind,
            "name": name,
            "timestamp_ms": currentTimestampMs(),
            "payload": payload
        ]
        if let requestID {
            envelope["request_id"] = requestID
        }
        return envelope
    }

    private func sendJSON(_ object: [String: Any], to ws: WebSocket) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
              let text = String(data: data, encoding: .utf8)
        else {
            logger.error("failed to encode ws message")
            return
        }
        ws.send(text)
    }

    private func currentTimestampMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private func parseEnvelope(_ text: String) throws -> IncomingEnvelope {
        guard let data = text.data(using: .utf8) else {
            throw Abort(.badRequest, reason: "invalid utf8")
        }
        guard let root = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw Abort(.badRequest, reason: "invalid json object")
        }

        guard let version = root["version"] as? String,
              let kind = root["kind"] as? String,
              let name = root["name"] as? String,
              let timestampMs = root["timestamp_ms"] as? Int,
              let payload = root["payload"] as? [String: Any]
        else {
            throw Abort(.badRequest, reason: "invalid envelope")
        }

        return IncomingEnvelope(
            version: version,
            kind: kind,
            name: name,
            requestID: root["request_id"] as? String,
            timestampMs: timestampMs,
            payload: payload
        )
    }

    struct IncomingEnvelope {
        let version: String
        let kind: String
        let name: String
        let requestID: String?
        let timestampMs: Int
        let payload: [String: Any]
    }
}

extension AgentRuntime: @unchecked Sendable {}

@main
struct SwiftCaptureAgentMain {
    static func main() async throws {
        let config = AgentConfig.load()
        let app = try await Application.make(.development)
        app.logger.logLevel = .info
        app.http.server.configuration.hostname = config.host
        app.http.server.configuration.port = config.port

        let runtime = AgentRuntime(config: config, logger: app.logger)
        let secWebSocketProtocol = HTTPHeaders.Name("Sec-WebSocket-Protocol")

        app.get("healthz") { _ in
            ["status": "ok"]
        }

        app.webSocket(
            "ws",
            shouldUpgrade: { req in
                let offered = req.headers[secWebSocketProtocol]
                    .flatMap { $0.split(separator: ",") }
                    .map { $0.trimmingCharacters(in: .whitespaces) }

                guard offered.contains(runtime.requiredSubprotocol) else {
                    req.logger.warning("ws rejected: missing required subprotocol")
                    return req.eventLoop.makeSucceededFuture(nil)
                }

                var headers = HTTPHeaders()
                headers.add(name: secWebSocketProtocol, value: runtime.requiredSubprotocol)
                return req.eventLoop.makeSucceededFuture(headers)
            },
            onUpgrade: { _req, ws in
                runtime.connect(ws)

                ws.onText { ws, text in
                    runtime.handleText(text, from: ws)
                }

                ws.onClose.whenComplete { _ in
                    runtime.disconnect(ws)
                }
            }
        )

        app.logger.info("swift-capture-agent listening on ws://\(config.host):\(config.port)/ws")
        do {
            try await app.execute()
            try await app.asyncShutdown()
        } catch {
            try? await app.asyncShutdown()
            throw error
        }
    }
}

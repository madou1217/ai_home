import AppKit
import CoreGraphics
import Foundation

let output=SurfaceOutput()
func emit(_ value:[String:Any]) {output.send(value)}

NSApplication.shared.setActivationPolicy(.prohibited)
if CommandLine.arguments.contains("--request-permissions") {
  // This command is reached only after an explicit WebUI start confirmation.
  // The OS owns the permission UI; AI Home never clicks or scripts it.
  _ = CGRequestScreenCaptureAccess()
  _ = CGRequestPostEventAccess()
  let data=try! JSONSerialization.data(withJSONObject:["type":"permission-request","screenCapture":CGPreflightScreenCaptureAccess(),"eventPosting":CGPreflightPostEventAccess()],options:.sortedKeys)
  FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]));exit(0)
}
if CommandLine.arguments.contains("--preflight") {
  let data=try! JSONSerialization.data(withJSONObject:["type":"preflight","screenCapture":CGPreflightScreenCaptureAccess(),"eventPosting":CGPreflightPostEventAccess()],options:.sortedKeys)
  FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]));exit(0)
}
guard CommandLine.arguments.count == 2, let pid=Int32(CommandLine.arguments[1]), pid>1 else { exit(2) }
guard CGPreflightScreenCaptureAccess(),CGPreflightPostEventAccess() else {emit(["type":"error","error":"browser_system_permission_required"]);output.flush();exit(3)}
let input:BrowserInput
do {input=try BrowserInput(pid:pid)} catch {emit(["type":"error","error":"browser_identity_unavailable"]);output.flush();exit(4)}
let capture=BrowserCapture(pid:pid,input:input,emit:emit)
Task { @MainActor in
  do {try await capture.start()} catch {
    input.gate.stop();input.enabled=false
    emit(["type":"error","error":(error as? SurfaceFailure)?.code ?? "browser_capture_unavailable"])
    output.flush();exit(5)
  }
}
let pending=DispatchSemaphore(value:8)
let stoppedLock=NSLock()
var stopped=false
func isStopped()->Bool {stoppedLock.lock();defer{stoppedLock.unlock()};return stopped}
func stopImmediately(){stoppedLock.lock();stopped=true;stoppedLock.unlock();input.gate.stop()}
DispatchQueue.global(qos:.userInitiated).async {
  var rateStart=Date(),count=0
  while let line=readLine() {
    if Date().timeIntervalSince(rateStart)>1 {rateStart=Date();count=0}
    count += 1
    if count>90 {stopImmediately();break}
    guard line.utf8.count<=16384,let raw=line.data(using:.utf8),let command=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any] else {stopImmediately();break}
    if command["type"] as? String == "close" {stopImmediately();break}
    guard pending.wait(timeout:.now()) == .success else {stopImmediately();break}
    DispatchQueue.main.async {
      defer {pending.signal()}
      if isStopped(){return}
      do {try input.apply(command)} catch {
        let code=(error as? SurfaceFailure)?.code ?? "browser_input_unavailable"
        if code != "browser_frame_stale" {stopImmediately();input.enabled=false}
        emit(["type":"error","error":code])
        if code != "browser_frame_stale" {
          Task {await capture.stop();output.flush();exit(6)}
        }
      }
    }
  }
  stopImmediately()
  DispatchQueue.main.async {input.enabled=false;Task {await capture.stop();exit(0)}}
}
NSApplication.shared.run()

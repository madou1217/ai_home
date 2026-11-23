import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

final class BrowserCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  let pid: pid_t
  let input: BrowserInput
  let emit: ([String:Any]) -> Void
  private let queue = DispatchQueue(label: "aih.browser.frames", qos: .userInitiated)
  private let context = CIContext(options: [.cacheIntermediates:false])
  private var stream: SCStream?
  private var lastEncoded = Date.distantPast
  private var lastJPEG: Data?
  private var frameSize = CGSize.zero
  private let lifecycle=NSLock()
  private var terminated=false
  private var publishing=false

  private func invalidate() {
    lifecycle.lock();terminated=true;lifecycle.unlock()
    input.gate.stop()
    DispatchQueue.main.async {self.input.enabled=false;self.input.history.removeAll();self.input.lastFrame=Date.distantPast}
  }


  init(pid: pid_t, input: BrowserInput, emit: @escaping ([String:Any]) -> Void) {
    self.pid=pid;self.input=input;self.emit=emit
  }

  func start() async throws {
    guard CGPreflightScreenCaptureAccess() else { throw SurfaceFailure("browser_screen_permission_required") }
    var selected: SCWindow?
    for _ in 0..<40 {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly:false)
      let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.isOnScreen && $0.frame.width >= 700 && $0.frame.height >= 400 }
      if candidates.count > 1 {
        // The host launches the surface with --window-size=1200,900. Prefer that
        // exact size, then the largest window; never fail just because Edge also
        // restored or opened another large window.
        let preferred = candidates.first { abs($0.frame.width-1200) < 2 && abs($0.frame.height-900) < 2 }
        selected = preferred ?? candidates.max { left, right in
          left.frame.width * left.frame.height < right.frame.width * right.frame.height
        }
        break
      }
      if let window = candidates.first { selected=window;break }
      try await Task.sleep(nanoseconds:100_000_000)
    }
    guard let window = selected else { throw SurfaceFailure("browser_window_unavailable") }
    input.windowID=window.windowID;input.frame=window.frame
    let config=SCStreamConfiguration()
    let scale=min(1,1280/window.frame.width)
    config.width=Int(window.frame.width*scale);config.height=Int(window.frame.height*scale)
    config.minimumFrameInterval=CMTime(value:1,timescale:8)
    config.queueDepth=3
    config.pixelFormat=kCVPixelFormatType_32BGRA
    config.showsCursor=false
    let stream=SCStream(filter:SCContentFilter(desktopIndependentWindow:window),configuration:config,delegate:self)
    try stream.addStreamOutput(self,type:.screen,sampleHandlerQueue:queue)
    self.stream=stream
    try await stream.startCapture()
    emit(["type":"ready","width":config.width,"height":config.height])
  }

  func stop() async { invalidate();input.enabled=false;input.history.removeAll();try? await stream?.stopCapture();stream=nil }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    invalidate()
    emit(["type":"error","error":"browser_capture_stopped"])
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    lifecycle.lock();let ended=terminated;lifecycle.unlock()
    if ended {return}
    guard type == .screen, sampleBuffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo:Any]],
      let status = attachments.first?[.status] as? Int else { return }
    if status == SCFrameStatus.idle.rawValue {
      guard Date().timeIntervalSince(lastEncoded)>=0.5,let data=lastJPEG else {return}
      lastEncoded=Date();publish(data,width:Int(frameSize.width),height:Int(frameSize.height));return
    }
    guard status == SCFrameStatus.complete.rawValue,
      Date().timeIntervalSince(lastEncoded)>=0.10,
      let pixelBuffer=sampleBuffer.imageBuffer else {return}
    lastEncoded=Date()
    let image=CIImage(cvPixelBuffer:pixelBuffer)
    guard let space=CGColorSpace(name:CGColorSpace.sRGB), let data=context.jpegRepresentation(of:image,colorSpace:space,options:[kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:0.60]), data.count <= 1_000_000 else { return }
    let width=CVPixelBufferGetWidth(pixelBuffer),height=CVPixelBufferGetHeight(pixelBuffer)
    lastJPEG=data;frameSize=CGSize(width:width,height:height)
    publish(data,width:width,height:height)
  }

  private func publish(_ data:Data,width:Int,height:Int) {
    let captured=Date()
    lifecycle.lock()
    if terminated || publishing {lifecycle.unlock();return}
    publishing=true;lifecycle.unlock()
    DispatchQueue.main.async {
      self.lifecycle.lock()
      defer {self.publishing=false;self.lifecycle.unlock()}
      if self.terminated || Date().timeIntervalSince(captured)>2.5 {return}
      guard CGPreflightScreenCaptureAccess(), let app=NSRunningApplication(processIdentifier:self.pid), !app.isTerminated else {self.input.enabled=false;return}
      self.input.lastFrame=captured;self.input.enabled=true;self.input.sequence += 1
      let sequence=self.input.sequence
      self.input.history[sequence]=captured
      self.input.history=self.input.history.filter {Date().timeIntervalSince($0.value)<3}
      self.emit(["type":"frame","_capturedAt":captured.timeIntervalSince1970,"frame":sequence,"data":data.base64EncodedString(),"width":width,"height":height])
    }
  }
}

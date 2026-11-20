import Foundation

// Never write a pipe from the main/input/capture queues. Backpressure retains
// one latest frame and a bounded control queue, not an unbounded dispatch chain.
final class SurfaceOutput {
  private let lock=NSLock()
  private let queue=DispatchQueue(label:"aih.browser.output",qos:.userInitiated)
  private var latest:[String:Any]?
  private var controls:[[String:Any]]=[]
  private var draining=false

  func send(_ value:[String:Any]) {
    lock.lock()
    if value["type"] as? String == "frame" {latest=value}
    else {
      if controls.count>=8 {controls.removeFirst()}
      controls.append(value)
    }
    if draining {lock.unlock();return}
    draining=true;lock.unlock()
    queue.async {self.drain()}
  }

  func flush() {
    let done=DispatchSemaphore(value:0)
    queue.async {done.signal()}
    _ = done.wait(timeout:.now()+0.5)
  }

  private func drain() {
    while true {
      lock.lock()
      var value:[String:Any]?
      if !controls.isEmpty {value=controls.removeFirst()}
      else if let frame=latest {value=frame;latest=nil}
      else {draining=false;lock.unlock();return}
      lock.unlock()
      guard var current=value else {continue}
      if let at=current.removeValue(forKey:"_capturedAt") as? TimeInterval, Date().timeIntervalSince1970-at>2.5 {continue}
      guard var data=try? JSONSerialization.data(withJSONObject:current,options:.sortedKeys) else {continue}
      data.append(10)
      do {try FileHandle.standardOutput.write(contentsOf:data)} catch {return}
    }
  }
}

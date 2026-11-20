import AppKit
import CoreGraphics
import Foundation

// CGEvent mouse construction alone does not associate the foreign AppKit
// window. Build through NSEvent's public windowNumber API before PID-directed
// delivery. No global event tap, cursor movement or private window fields.
final class TaskWindowMouseEvents {
  private var number = 0

  private func make(_ type: NSEvent.EventType, point: CGPoint, window: CGWindowID,
                    number: Int, clicks: Int, pressure: Float = 0) throws -> CGEvent {
    guard window != 0, point.x.isFinite, point.y.isFinite,
      let screen = NSScreen.screens.first, screen.frame.height > 0 else {
      throw SurfaceFailure("browser_event_unavailable")
    }
    // The sending helper does not own this window. AppKit therefore flips the
    // supplied position using the primary screen, not the foreign window's
    // height. Compensate that flip so the target receives window-local x/y.
    // Observed on the validated display topology; other display origins/scales
    // still need receiver-side acceptance, not just this sender-side check.
    guard let event = NSEvent.mouseEvent(with: type,
      location: CGPoint(x: point.x, y: screen.frame.height - point.y),
      modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: Int(window), context: nil, eventNumber: number,
      clickCount: clicks, pressure: pressure)?.cgEvent else {
      throw SurfaceFailure("browser_event_unavailable")
    }
    event.flags = []
    // Fail closed if a future AppKit conversion no longer preserves this
    // window association or the compensated sender-side local coordinates.
    guard NSEvent(cgEvent: event)?.windowNumber == Int(window),
      abs(event.location.x - point.x) < 0.01,
      abs(event.location.y - point.y) < 0.01 else {
      throw SurfaceFailure("browser_event_unavailable")
    }
    return event
  }

  private func nextNumber() -> Int {
    number = number == Int32.max ? 1 : number + 1
    return number
  }

  func click(pid: pid_t, window: CGWindowID, point: CGPoint, right: Bool) throws {
    let number = nextNumber()
    // Construct the whole pair before posting; allocation failure cannot leave
    // a button down. The caller holds its identity/window/frame input gate.
    let down = try make(right ? .rightMouseDown : .leftMouseDown, point: point,
      window: window, number: number, clicks: 1, pressure: 1)
    let up = try make(right ? .rightMouseUp : .leftMouseUp, point: point,
      window: window, number: number, clicks: 1)
    down.postToPid(pid)
    up.postToPid(pid)
  }

  func scroll(pid: pid_t, window: CGWindowID, point: CGPoint, dx: Double, dy: Double) throws {
    // Preserve the same public AppKit window association for the wheel event.
    let event = try make(.mouseMoved, point: point, window: window,
      number: nextNumber(), clicks: 0)
    guard let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
      wheelCount: 2, wheel1: -Int32(dy), wheel2: -Int32(dx), wheel3: 0) else {
      throw SurfaceFailure("browser_event_unavailable")
    }
    event.type = .scrollWheel
    // Let CoreGraphics calculate line/fixed-point/pixel values consistently;
    // copying only the integer line delta would discard pixel-based scrolling.
    for field in [CGEventField.scrollWheelEventIsContinuous,
      .scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2,
      .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2] {
      event.setIntegerValueField(field, value: wheel.getIntegerValueField(field))
    }
    for field in [CGEventField.scrollWheelEventFixedPtDeltaAxis1,
      .scrollWheelEventFixedPtDeltaAxis2] {
      event.setDoubleValueField(field, value: wheel.getDoubleValueField(field))
    }
    guard NSEvent(cgEvent: event)?.windowNumber == Int(window),
      abs(event.location.x - point.x) < 0.01,
      abs(event.location.y - point.y) < 0.01 else {
      throw SurfaceFailure("browser_event_unavailable")
    }
    event.postToPid(pid)
  }
}

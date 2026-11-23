import Foundation

func expect(_ condition: Bool, _ message: String) {
  guard condition else {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

@main
struct SelectionTests {
  static func main() {
    let surface = CaptureWindowCandidate(id: 1, width: 1200, height: 900, onScreen: true)
    let small = CaptureWindowCandidate(id: 2, width: 800, height: 600, onScreen: true)
    let large = CaptureWindowCandidate(id: 3, width: 1400, height: 1000, onScreen: true)
    let offscreen = CaptureWindowCandidate(id: 4, width: 1200, height: 900, onScreen: false)
    let tiny = CaptureWindowCandidate(id: 5, width: 400, height: 300, onScreen: true)

    expect(selectCaptureWindow([surface])?.id == 1, "single window")
    expect(selectCaptureWindow([small, surface])?.id == 1, "prefers the 1200x900 host window")
    expect(selectCaptureWindow([surface, small])?.id == 1, "preference is order independent")
    expect(selectCaptureWindow([small, large])?.id == 3, "falls back to the largest window")
    expect(selectCaptureWindow([offscreen, small])?.id == 2, "ignores off-screen windows")
    expect(selectCaptureWindow([tiny]) == nil, "rejects undersized windows")
    expect(selectCaptureWindow([]) == nil, "empty candidates")
    print("capture selection tests passed")
  }
}

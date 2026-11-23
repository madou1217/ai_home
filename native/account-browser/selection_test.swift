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

    let exact = CaptureWindowCandidate(id: 10, width: 700, height: 400, onScreen: true)
    expect(selectCaptureWindow([exact])?.id == 10, "accepts exactly 700x400")
    let narrow = CaptureWindowCandidate(id: 11, width: 699, height: 400, onScreen: true)
    expect(selectCaptureWindow([narrow]) == nil, "rejects 699 width")
    let short = CaptureWindowCandidate(id: 12, width: 700, height: 399, onScreen: true)
    expect(selectCaptureWindow([short]) == nil, "rejects 399 height")
    let near = CaptureWindowCandidate(id: 13, width: 1201.5, height: 900, onScreen: true)
    expect(selectCaptureWindow([near, large])?.id == 13, "preference tolerates less than 2pt drift")
    let outside = CaptureWindowCandidate(id: 14, width: 1202, height: 900, onScreen: true)
    expect(selectCaptureWindow([outside, large])?.id == 3, "1202 is not the preferred size")
    let zero = CaptureWindowCandidate(id: 15, width: 0, height: 0, onScreen: true)
    expect(selectCaptureWindow([zero]) == nil, "rejects zero size")
    let duplicateA = CaptureWindowCandidate(id: 16, width: 1200, height: 900, onScreen: true)
    let duplicateB = CaptureWindowCandidate(id: 17, width: 1200, height: 900, onScreen: true)
    expect(selectCaptureWindow([duplicateA, duplicateB])?.id == 16, "keeps the first preferred window")
    let tieA = CaptureWindowCandidate(id: 18, width: 1000, height: 800, onScreen: true)
    let tieB = CaptureWindowCandidate(id: 19, width: 800, height: 1000, onScreen: true)
    expect(selectCaptureWindow([tieA, tieB])?.id == 18, "equal areas keep the first")
    let offA = CaptureWindowCandidate(id: 20, width: 1200, height: 900, onScreen: false)
    let offB = CaptureWindowCandidate(id: 21, width: 1400, height: 1000, onScreen: false)
    expect(selectCaptureWindow([offA, offB]) == nil, "all off-screen rejected")
    let nan = CaptureWindowCandidate(id: 22, width: CGFloat.nan, height: 900, onScreen: true)
    expect(selectCaptureWindow([nan]) == nil, "NaN rejected")
    print("capture selection tests passed")
  }
}

import CoreGraphics

struct CaptureWindowCandidate {
  let id: CGWindowID
  let width: CGFloat
  let height: CGFloat
  let onScreen: Bool
}

let captureMinimumWidth: CGFloat = 700
let captureMinimumHeight: CGFloat = 400
let capturePreferredWidth: CGFloat = 1200
let capturePreferredHeight: CGFloat = 900

// selectCaptureWindow picks the surface window when Edge has several windows.
// It ignores off-screen and undersized windows, prefers the host's launch size,
// then falls back to the largest remaining window. Never fails just because a
// second large window exists.
func selectCaptureWindow(_ candidates: [CaptureWindowCandidate]) -> CaptureWindowCandidate? {
  let eligible = candidates.filter {
    $0.onScreen && $0.width >= captureMinimumWidth && $0.height >= captureMinimumHeight
  }
  guard !eligible.isEmpty else { return nil }
  if eligible.count == 1 { return eligible[0] }
  if let preferred = eligible.first(where: {
    abs($0.width - capturePreferredWidth) < 2 && abs($0.height - capturePreferredHeight) < 2
  }) {
    return preferred
  }
  return eligible.max { $0.width * $0.height < $1.width * $1.height }
}

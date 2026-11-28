import AppKit
import AVFoundation
import AVKit
import CoreGraphics
import Foundation
import PDFKit
import QuartzCore

// MARK: - Shared Toolbar Helper

private func makeRendererToolbar(palette: LumenPalette, darkOverride: Bool = false) -> NSView {
  let bar = NSView()
  bar.wantsLayer = true
  bar.layer?.backgroundColor = (darkOverride ? palette.codeToolbarBackground : palette.surface).cgColor
  bar.translatesAutoresizingMaskIntoConstraints = false
  let line = NSView()
  line.wantsLayer = true
  line.layer?.backgroundColor = (darkOverride ? NSColor.white.withAlphaComponent(0.10) : palette.border).cgColor
  line.translatesAutoresizingMaskIntoConstraints = false
  bar.addSubview(line)
  NSLayoutConstraint.activate([
    bar.heightAnchor.constraint(equalToConstant: 40),
    line.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
    line.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
    line.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
    line.heightAnchor.constraint(equalToConstant: 1)
  ])
  return bar
}

private func makePillButton(title: String, target: AnyObject, action: Selector, palette: LumenPalette, dark: Bool = false) -> NSButton {
  let btn = NSButton(title: title, target: target, action: action)
  btn.isBordered = false
  btn.wantsLayer = true
  btn.font = .systemFont(ofSize: 11.5, weight: .medium)
  btn.contentTintColor = dark ? palette.codeBaseText : palette.ink
  btn.layer?.cornerRadius = 7
  btn.layer?.cornerCurve = .continuous
  btn.layer?.borderWidth = 1
  btn.layer?.borderColor = (dark ? NSColor.white.withAlphaComponent(0.16) : palette.border).cgColor
  btn.layer?.backgroundColor = (dark ? NSColor.white.withAlphaComponent(0.08) : palette.surfaceElevated).cgColor
  btn.translatesAutoresizingMaskIntoConstraints = false
  btn.heightAnchor.constraint(equalToConstant: 26).isActive = true
  btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 28).isActive = true
  return btn
}

private func makeStatusLabel(_ text: String, palette: LumenPalette, dark: Bool = false) -> NSTextField {
  let label = NSTextField(labelWithString: text)
  label.font = .systemFont(ofSize: 11.5, weight: .medium)
  label.textColor = dark ? palette.codeBaseText.withAlphaComponent(0.82) : palette.muted
  label.lineBreakMode = .byTruncatingTail
  label.translatesAutoresizingMaskIntoConstraints = false
  return label
}

// MARK: - 1. Native PDFKit Renderer

struct LumenPDFRenderer: LumenPreviewRenderer {
  let rendererID = "native.pdfkit"
  let priority = 100
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .pdf }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenPDFRendererView(palette: context.palette)
  }
}

final class LumenPDFRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let pageLabel: NSTextField
  private let zoomLabel: NSTextField
  private let pdfView = PDFView()
  private let thumbnailView = PDFThumbnailView()
  private let emptyLabel = NSTextField(labelWithString: "正在加载 PDF…")
  private var zoomPercent: CGFloat = 100
  private var loadGeneration = 0
  private var pageObserver: NSObjectProtocol?

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("PDF 文档", palette: palette)
    pageLabel = makeStatusLabel("第 1 / 1 页", palette: palette)
    zoomLabel = makeStatusLabel("100%", palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  private func setupUI() {
    let prevBtn = makePillButton(title: "‹", target: self, action: #selector(prevPage), palette: palette)
    let nextBtn = makePillButton(title: "›", target: self, action: #selector(nextPage), palette: palette)
    let zoomOutBtn = makePillButton(title: "−", target: self, action: #selector(zoomOutClicked), palette: palette)
    let zoomInBtn = makePillButton(title: "+", target: self, action: #selector(zoomInClicked), palette: palette)

    let pageStack = NSStackView(views: [prevBtn, pageLabel, nextBtn])
    pageStack.orientation = .horizontal
    pageStack.spacing = 6
    pageStack.translatesAutoresizingMaskIntoConstraints = false

    let zoomStack = NSStackView(views: [zoomOutBtn, zoomLabel, zoomInBtn])
    zoomStack.orientation = .horizontal
    zoomStack.spacing = 6
    zoomStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(pageStack)
    toolbar.addSubview(zoomStack)

    thumbnailView.pdfView = pdfView
    thumbnailView.thumbnailSize = NSSize(width: 78, height: 102)
    thumbnailView.backgroundColor = palette.surface
    thumbnailView.translatesAutoresizingMaskIntoConstraints = false

    let thumbDivider = NSView()
    thumbDivider.wantsLayer = true
    thumbDivider.layer?.backgroundColor = palette.border.cgColor
    thumbDivider.translatesAutoresizingMaskIntoConstraints = false

    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.displaysPageBreaks = true
    pdfView.autoScales = true
    pdfView.backgroundColor = palette.windowBackground
    pdfView.translatesAutoresizingMaskIntoConstraints = false

    emptyLabel.font = .systemFont(ofSize: 13)
    emptyLabel.textColor = palette.muted
    emptyLabel.alignment = .center
    emptyLabel.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(thumbnailView)
    addSubview(thumbDivider)
    addSubview(pdfView)
    addSubview(emptyLabel)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),

      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      pageStack.centerXAnchor.constraint(equalTo: toolbar.centerXAnchor),
      pageStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      zoomStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      zoomStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      thumbnailView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      thumbnailView.leadingAnchor.constraint(equalTo: leadingAnchor),
      thumbnailView.bottomAnchor.constraint(equalTo: bottomAnchor),
      thumbnailView.widthAnchor.constraint(equalToConstant: 108),

      thumbDivider.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      thumbDivider.leadingAnchor.constraint(equalTo: thumbnailView.trailingAnchor),
      thumbDivider.bottomAnchor.constraint(equalTo: bottomAnchor),
      thumbDivider.widthAnchor.constraint(equalToConstant: 1),

      pdfView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      pdfView.leadingAnchor.constraint(equalTo: thumbDivider.trailingAnchor),
      pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
      pdfView.bottomAnchor.constraint(equalTo: bottomAnchor),

      emptyLabel.centerXAnchor.constraint(equalTo: pdfView.centerXAnchor),
      emptyLabel.centerYAnchor.constraint(equalTo: pdfView.centerYAnchor)
    ])

    pageObserver = NotificationCenter.default.addObserver(
      forName: .PDFViewPageChanged,
      object: pdfView,
      queue: .main
    ) { [weak self] _ in
      self?.updatePageCounter()
    }
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    emptyLabel.isHidden = false
    emptyLabel.stringValue = "正在加载 PDF…"

    if let cached = context.cache.pdf(for: item.cacheKey) {
      applyDocument(cached)
      return
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let doc = PDFDocument(url: url)
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          if let doc {
            context.cache.storePDF(doc, for: item.cacheKey)
            self.applyDocument(doc)
          } else {
            self.emptyLabel.stringValue = "无法解析此 PDF 文件"
          }
        }
      }
      return
    }
    guard let clip = item.clipboardItem else {
      emptyLabel.stringValue = "PDF 文件不可用"
      return
    }
    context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0) { [weak self] result in
      guard let self, self.loadGeneration == gen else { return }
      switch result {
      case .success(let (data, _)):
        if let doc = PDFDocument(data: data) {
          context.cache.storePDF(doc, for: item.cacheKey)
          self.applyDocument(doc)
        } else {
          self.emptyLabel.stringValue = "无法解码 PDF 数据"
        }
      case .failure(let error):
        self.emptyLabel.stringValue = "加载失败：\(error.localizedDescription)"
      }
    }
  }

  private func applyDocument(_ document: PDFDocument) {
    emptyLabel.isHidden = true
    pdfView.document = document
    pdfView.autoScales = true
    zoomPercent = 100
    zoomLabel.stringValue = "适配"
    infoLabel.stringValue = "PDF · \(document.pageCount) 页"
    updatePageCounter()
  }

  private func updatePageCounter() {
    guard let doc = pdfView.document, doc.pageCount > 0 else {
      pageLabel.stringValue = "0 / 0"
      return
    }
    let idx = pdfView.currentPage.map { doc.index(for: $0) + 1 } ?? 1
    pageLabel.stringValue = "第 \(idx) / \(doc.pageCount) 页"
  }

  @objc private func prevPage() { _ = stepPage(-1) }
  @objc private func nextPage() { _ = stepPage(1) }
  @objc private func zoomOutClicked() { zoomOut() }
  @objc private func zoomInClicked() { zoomIn() }

  override func stepPage(_ delta: Int) -> Bool {
    if delta < 0, pdfView.canGoToPreviousPage {
      pdfView.goToPreviousPage(nil)
      updatePageCounter()
      return true
    }
    if delta > 0, pdfView.canGoToNextPage {
      pdfView.goToNextPage(nil)
      updatePageCounter()
      return true
    }
    return false
  }

  override func zoomIn() {
    pdfView.autoScales = false
    zoomPercent = min(250, zoomPercent + 25)
    pdfView.scaleFactor = zoomPercent / 100.0
    zoomLabel.stringValue = "\(Int(zoomPercent))%"
  }

  override func zoomOut() {
    pdfView.autoScales = false
    zoomPercent = max(50, zoomPercent - 25)
    pdfView.scaleFactor = zoomPercent / 100.0
    zoomLabel.stringValue = "\(Int(zoomPercent))%"
  }

  override func resetZoom() {
    pdfView.autoScales = true
    zoomPercent = 100
    zoomLabel.stringValue = "适配"
  }

  override func teardown() {
    loadGeneration += 1
    if let obs = pageObserver {
      NotificationCenter.default.removeObserver(obs)
      pageObserver = nil
    }
    pdfView.document = nil
  }
}

// MARK: - 2. Native AVFoundation + CoreGraphics Audio Renderer

struct LumenAudioRenderer: LumenPreviewRenderer {
  let rendererID = "native.avfoundation.audio"
  let priority = 95
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .audio }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenAudioRendererView(palette: context.palette)
  }
}

/// Interactive 66-bar CoreGraphics waveform with click & drag seek.
private final class LumenWaveformView: NSView {
  var peaks: [CGFloat] = (0..<66).map { i in
    CGFloat(0.24 + abs(sin(Double(i) * 1.73) * cos(Double(i) * 0.21)) * 0.72)
  } { didSet { needsDisplay = true } }
  var progress: CGFloat = 0 { didSet { needsDisplay = true } }
  var playedColor: NSColor = NSColor(srgbRed: 0.408, green: 0.522, blue: 0.835, alpha: 1)
  var unplayedColor: NSColor = NSColor(srgbRed: 0.569, green: 0.655, blue: 0.847, alpha: 0.42)
  var onSeekFraction: ((CGFloat) -> Void)?

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext, !peaks.isEmpty else { return }
    let count = peaks.count
    let gap: CGFloat = 3
    let totalGap = gap * CGFloat(count - 1)
    let barWidth = max(2, min(5.5, (bounds.width - totalGap) / CGFloat(count)))
    let contentWidth = barWidth * CGFloat(count) + totalGap
    let startX = (bounds.width - contentWidth) / 2
    let maxHeight = max(8, bounds.height - 6)

    for i in 0..<count {
      let norm = max(0.12, min(1.0, peaks[i]))
      let h = maxHeight * norm
      let x = startX + CGFloat(i) * (barWidth + gap)
      let y = (bounds.height - h) / 2
      let barRect = CGRect(x: x, y: y, width: barWidth, height: h)
      let path = CGPath(roundedRect: barRect, cornerWidth: barWidth / 2, cornerHeight: barWidth / 2, transform: nil)
      let frac = CGFloat(i) / CGFloat(max(1, count - 1))
      ctx.setFillColor((frac <= progress ? playedColor : unplayedColor).cgColor)
      ctx.addPath(path)
      ctx.fillPath()
    }
  }

  override func mouseDown(with event: NSEvent) {
    seek(with: event)
  }

  override func mouseDragged(with event: NSEvent) {
    seek(with: event)
  }

  private func seek(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let frac = max(0, min(1, point.x / max(1, bounds.width)))
    onSeekFraction?(frac)
  }
}

final class LumenAudioRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let coverView = LumenAlbumCoverView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let waveformView = LumenWaveformView()
  private let nowLabel = NSTextField(labelWithString: "0:00")
  private let durationLabel = NSTextField(labelWithString: "0:00")
  private let seekSlider = NSSlider(value: 0, minValue: 0, maxValue: 1000, target: nil, action: nil)
  private let volumeSlider = NSSlider(value: 0.75, minValue: 0, maxValue: 1, target: nil, action: nil)
  private let repeatButton = NSButton()
  private let prevButton = NSButton()
  private let playButton = NSButton()
  private let nextButton = NSButton()
  private let statusLabel = NSTextField(labelWithString: "")

  private var player: AVPlayer?
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var durationSeconds: Double = 0
  private var repeatEnabled = false
  private var isPlaying = false
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  private func setupUI() {
    coverView.translatesAutoresizingMaskIntoConstraints = false

    titleLabel.font = .systemFont(ofSize: 21, weight: .semibold)
    titleLabel.textColor = palette.ink
    titleLabel.alignment = .center
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.translatesAutoresizingMaskIntoConstraints = false

    subtitleLabel.font = .systemFont(ofSize: 12)
    subtitleLabel.textColor = palette.muted
    subtitleLabel.alignment = .center
    subtitleLabel.translatesAutoresizingMaskIntoConstraints = false

    waveformView.playedColor = palette.accent
    waveformView.unplayedColor = palette.muted.withAlphaComponent(0.35)
    waveformView.translatesAutoresizingMaskIntoConstraints = false
    waveformView.onSeekFraction = { [weak self] frac in
      self?.seekToFraction(Double(frac))
    }

    for lbl in [nowLabel, durationLabel] {
      lbl.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
      lbl.textColor = palette.muted
      lbl.translatesAutoresizingMaskIntoConstraints = false
    }

    seekSlider.target = self
    seekSlider.action = #selector(seekSliderChanged)
    seekSlider.isContinuous = true
    seekSlider.translatesAutoresizingMaskIntoConstraints = false

    let progressStack = NSStackView(views: [nowLabel, seekSlider, durationLabel])
    progressStack.orientation = .horizontal
    progressStack.spacing = 10
    progressStack.translatesAutoresizingMaskIntoConstraints = false

    configureTransportButton(repeatButton, symbol: "repeat", size: 15, action: #selector(toggleRepeat))
    configureTransportButton(prevButton, symbol: "backward.end.fill", size: 16, action: #selector(stepPrev))
    configureTransportButton(nextButton, symbol: "forward.end.fill", size: 16, action: #selector(stepNext))

    playButton.isBordered = false
    playButton.wantsLayer = true
    playButton.target = self
    playButton.action = #selector(playButtonClicked)
    playButton.image = LumenIcons.symbol("play.fill", size: 20, weight: .semibold)
    playButton.contentTintColor = .white
    playButton.layer?.cornerRadius = 26
    playButton.layer?.backgroundColor = palette.accent.cgColor
    playButton.translatesAutoresizingMaskIntoConstraints = false

    let controlsStack = NSStackView(views: [repeatButton, prevButton, playButton, nextButton])
    controlsStack.orientation = .horizontal
    controlsStack.spacing = 18
    controlsStack.alignment = .centerY
    controlsStack.translatesAutoresizingMaskIntoConstraints = false

    let volIcon = NSImageView(image: LumenIcons.symbol("speaker.wave.2.fill", size: 12))
    volIcon.contentTintColor = palette.muted
    volIcon.translatesAutoresizingMaskIntoConstraints = false

    volumeSlider.target = self
    volumeSlider.action = #selector(volumeChanged)
    volumeSlider.isContinuous = true
    volumeSlider.translatesAutoresizingMaskIntoConstraints = false
    volumeSlider.widthAnchor.constraint(equalToConstant: 110).isActive = true

    let volumeStack = NSStackView(views: [volIcon, volumeSlider])
    volumeStack.orientation = .horizontal
    volumeStack.spacing = 8
    volumeStack.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = palette.muted
    statusLabel.alignment = .center
    statusLabel.translatesAutoresizingMaskIntoConstraints = false

    let container = NSStackView(views: [
      coverView, titleLabel, subtitleLabel, waveformView, progressStack, controlsStack, volumeStack, statusLabel
    ])
    container.orientation = .vertical
    container.alignment = .centerX
    container.spacing = 10
    container.setCustomSpacing(16, after: coverView)
    container.setCustomSpacing(14, after: subtitleLabel)
    container.setCustomSpacing(12, after: progressStack)
    container.translatesAutoresizingMaskIntoConstraints = false

    addSubview(container)

    NSLayoutConstraint.activate([
      coverView.widthAnchor.constraint(equalToConstant: 184),
      coverView.heightAnchor.constraint(equalToConstant: 184),
      playButton.widthAnchor.constraint(equalToConstant: 52),
      playButton.heightAnchor.constraint(equalToConstant: 52),
      waveformView.widthAnchor.constraint(equalToConstant: 440),
      waveformView.heightAnchor.constraint(equalToConstant: 46),
      progressStack.widthAnchor.constraint(equalToConstant: 440),
      titleLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 520),

      container.centerXAnchor.constraint(equalTo: centerXAnchor),
      container.centerYAnchor.constraint(equalTo: centerYAnchor),
      container.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
      container.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24)
    ])
  }

  private func configureTransportButton(_ button: NSButton, symbol: String, size: CGFloat, action: Selector) {
    button.isBordered = false
    button.wantsLayer = true
    button.image = LumenIcons.symbol(symbol, size: size, weight: .medium)
    button.contentTintColor = palette.ink
    button.target = self
    button.action = action
    button.layer?.cornerRadius = 17
    button.translatesAutoresizingMaskIntoConstraints = false
    button.widthAnchor.constraint(equalToConstant: 34).isActive = true
    button.heightAnchor.constraint(equalToConstant: 34).isActive = true
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    teardown()
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration

    coverView.seedIndex = item.seedIndex
    coverView.badgeText = String(format: "LUMEN / %02d", (item.seedIndex % 99) + 1)
    titleLabel.stringValue = (item.title as NSString).deletingPathExtension
    subtitleLabel.stringValue = "\(item.subtitle) · \(item.sizeLabel)"
    statusLabel.stringValue = ""
    nowLabel.stringValue = "0:00"
    durationLabel.stringValue = "0:00"
    seekSlider.doubleValue = 0
    waveformView.progress = 0

    let asset: AVURLAsset?
    if let localURL = item.localURL, FileManager.default.fileExists(atPath: localURL.path) {
      asset = AVURLAsset(url: localURL)
      decodeWaveform(from: localURL, cacheKey: item.cacheKey, cache: context.cache, generation: gen)
    } else if let clip = item.clipboardItem,
              let streamURL = context.store.api.itemFileStreamURL(itemID: clip.id, index: item.fileIndex ?? 0) {
      let headers = context.store.api.authHeaders()
      asset = AVURLAsset(url: streamURL, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
    } else {
      asset = nil
    }

    guard let asset else {
      statusLabel.stringValue = "音频文件不可用"
      return
    }

    let playerItem = AVPlayerItem(asset: asset)
    let avPlayer = AVPlayer(playerItem: playerItem)
    avPlayer.volume = Float(volumeSlider.doubleValue)
    player = avPlayer

    asset.loadValuesAsynchronously(forKeys: ["duration"]) { [weak self] in
      let secs = CMTimeGetSeconds(asset.duration)
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == gen else { return }
        if secs.isFinite && secs > 0 {
          self.durationSeconds = secs
          self.durationLabel.stringValue = LumenFormatters.mediaDuration(secs)
        }
      }
    }

    let interval = CMTime(seconds: 0.08, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
    timeObserver = avPlayer.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
      guard let self else { return }
      let current = CMTimeGetSeconds(time)
      if self.durationSeconds <= 0, let dur = self.player?.currentItem?.duration {
        let secs = CMTimeGetSeconds(dur)
        if secs.isFinite && secs > 0 {
          self.durationSeconds = secs
          self.durationLabel.stringValue = LumenFormatters.mediaDuration(secs)
        }
      }
      if current.isFinite {
        self.nowLabel.stringValue = LumenFormatters.mediaDuration(current)
        if self.durationSeconds > 0 {
          let frac = max(0, min(1, current / self.durationSeconds))
          self.seekSlider.doubleValue = frac * 1000
          self.waveformView.progress = CGFloat(frac)
        }
      }
    }

    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: playerItem,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      if self.repeatEnabled {
        self.player?.seek(to: .zero)
        self.player?.play()
      } else {
        self.setPlayingUI(false)
        self.currentContext?.onStepQueue(1, true)
      }
    }
  }

  private func decodeWaveform(from url: URL, cacheKey: String, cache: LumenPreviewCache, generation: Int) {
    if let cached = cache.waveform(for: cacheKey) {
      waveformView.peaks = cached
      return
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let audioFile = try? AVAudioFile(forReading: url) else { return }
      let totalFrames = Int(audioFile.length)
      guard totalFrames > 0 else { return }
      let barCount = 66
      let maxFramesToRead = min(totalFrames, 44_100 * 120) // cap 2 min decode for snappy response
      let format = audioFile.processingFormat
      let frameChunk = max(256, maxFramesToRead / barCount)
      var peaks: [CGFloat] = []
      peaks.reserveCapacity(barCount)

      guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(min(frameChunk, 16_384))) else { return }
      for i in 0..<barCount {
        let startFrame = AVAudioFramePosition(Int64(i) * Int64(totalFrames) / Int64(barCount))
        audioFile.framePosition = startFrame
        let readCount = AVAudioFrameCount(min(Int(buffer.frameCapacity), max(1, totalFrames - Int(startFrame))))
        do {
          try audioFile.read(into: buffer, frameCount: readCount)
          guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else {
            peaks.append(0.15)
            continue
          }
          let n = Int(buffer.frameLength)
          let strideStep = max(1, n / 128)
          var sumSq: Float = 0
          var samples = 0
          var idx = 0
          while idx < n {
            let sample = channel[idx]
            sumSq += sample * sample
            samples += 1
            idx += strideStep
          }
          peaks.append(CGFloat(sqrt(sumSq / Float(max(1, samples)))))
        } catch {
          peaks.append(0.15)
        }
      }
      let peakMax = max(0.001, peaks.max() ?? 0.001)
      let normalized = peaks.map { pow($0 / peakMax, 0.72) }
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == generation else { return }
        cache.storeWaveform(normalized, for: cacheKey)
        self.waveformView.peaks = normalized
      }
    }
  }

  private func setPlayingUI(_ playing: Bool) {
    isPlaying = playing
    playButton.image = LumenIcons.symbol(playing ? "pause.fill" : "play.fill", size: 20, weight: .semibold)
    guard LumenMotion.isEnabled, let layer = coverView.layer else { return }
    let scale: CGFloat = playing ? 1.035 : 1.0
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.35
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
      let cx = coverView.bounds.midX
      let cy = coverView.bounds.midY
      var transform = CATransform3DIdentity
      transform = CATransform3DTranslate(transform, cx, cy, 0)
      transform = CATransform3DScale(transform, scale, scale, 1)
      transform = CATransform3DTranslate(transform, -cx, -cy, 0)
      layer.transform = transform
    }
  }

  private func seekToFraction(_ fraction: Double) {
    guard let player, durationSeconds > 0 else { return }
    let target = CMTime(seconds: durationSeconds * max(0, min(1, fraction)), preferredTimescale: 600)
    player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
    waveformView.progress = CGFloat(fraction)
    seekSlider.doubleValue = fraction * 1000
  }

  @objc private func playButtonClicked() { _ = togglePlayPause() }
  @objc private func stepPrev() { currentContext?.onStepQueue(-1, true) }
  @objc private func stepNext() { currentContext?.onStepQueue(1, true) }
  @objc private func toggleRepeat() {
    repeatEnabled.toggle()
    repeatButton.contentTintColor = repeatEnabled ? palette.accent : palette.ink
  }
  @objc private func seekSliderChanged() {
    seekToFraction(seekSlider.doubleValue / 1000.0)
  }
  @objc private func volumeChanged() {
    player?.volume = Float(volumeSlider.doubleValue)
  }

  override func togglePlayPause() -> Bool {
    guard let player else { return false }
    if player.rate > 0 {
      player.pause()
      setPlayingUI(false)
    } else {
      if durationSeconds > 0, CMTimeGetSeconds(player.currentTime()) >= durationSeconds - 0.1 {
        player.seek(to: .zero)
      }
      player.play()
      setPlayingUI(true)
    }
    return true
  }

  override func teardown() {
    loadGeneration += 1
    if let obs = timeObserver, let player {
      player.removeTimeObserver(obs)
    }
    timeObserver = nil
    if let obs = endObserver {
      NotificationCenter.default.removeObserver(obs)
      endObserver = nil
    }
    player?.pause()
    player = nil
    isPlaying = false
  }
}

// MARK: - 3. Native AVKit / AVFoundation Video Renderer

struct LumenVideoRenderer: LumenPreviewRenderer {
  let rendererID = "native.avkit.video"
  let priority = 94
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .video }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenVideoRendererView(palette: context.palette)
  }
}

final class LumenVideoRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let playerView = AVPlayerView()
  private var player: AVPlayer?
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("视频预览", palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  private func setupUI() {
    let badge = makeStatusLabel("AVKit 原生控件", palette: palette)
    toolbar.addSubview(infoLabel)
    toolbar.addSubview(badge)

    playerView.controlsStyle = .inline
    playerView.showsFullScreenToggleButton = false
    playerView.videoGravity = .resizeAspect
    playerView.translatesAutoresizingMaskIntoConstraints = false

    let stage = NSView()
    stage.wantsLayer = true
    stage.layer?.backgroundColor = NSColor(srgbRed: 0.067, green: 0.094, blue: 0.153, alpha: 1).cgColor
    stage.translatesAutoresizingMaskIntoConstraints = false
    stage.addSubview(playerView)

    addSubview(toolbar)
    addSubview(stage)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      badge.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      badge.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      stage.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      stage.leadingAnchor.constraint(equalTo: leadingAnchor),
      stage.trailingAnchor.constraint(equalTo: trailingAnchor),
      stage.bottomAnchor.constraint(equalTo: bottomAnchor),

      playerView.topAnchor.constraint(equalTo: stage.topAnchor, constant: 14),
      playerView.leadingAnchor.constraint(equalTo: stage.leadingAnchor, constant: 14),
      playerView.trailingAnchor.constraint(equalTo: stage.trailingAnchor, constant: -14),
      playerView.bottomAnchor.constraint(equalTo: stage.bottomAnchor, constant: -14)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    teardown()
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration

    let asset: AVURLAsset?
    if let localURL = item.localURL, FileManager.default.fileExists(atPath: localURL.path) {
      asset = AVURLAsset(url: localURL)
    } else if let clip = item.clipboardItem,
              let url = context.store.api.itemFileStreamURL(itemID: clip.id, index: item.fileIndex ?? 0) {
      asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": context.store.api.authHeaders()])
    } else {
      asset = nil
    }
    guard let asset else {
      infoLabel.stringValue = "视频文件不可用"
      return
    }
    let avPlayer = AVPlayer(playerItem: AVPlayerItem(asset: asset))
    player = avPlayer
    playerView.player = avPlayer
    infoLabel.stringValue = "视频预览 · \(item.sizeLabel)"

    asset.loadValuesAsynchronously(forKeys: ["duration", "tracks"]) { [weak self] in
      let secs = CMTimeGetSeconds(asset.duration)
      let track = asset.tracks(withMediaType: .video).first
      let dims = track?.naturalSize.applying(track?.preferredTransform ?? .identity)
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == gen else { return }
        var parts: [String] = ["视频预览"]
        if let dims, abs(dims.width) > 0, abs(dims.height) > 0 {
          parts.append("\(Int(abs(dims.width))) × \(Int(abs(dims.height)))")
        }
        if secs.isFinite && secs > 0 {
          parts.append(LumenFormatters.mediaDuration(secs))
        }
        self.infoLabel.stringValue = parts.joined(separator: " · ")
      }
    }
  }

  override func togglePlayPause() -> Bool {
    guard let player else { return false }
    if player.rate > 0 {
      player.pause()
    } else {
      player.play()
    }
    return true
  }

  override func teardown() {
    loadGeneration += 1
    player?.pause()
    playerView.player = nil
    player = nil
  }
}

// MARK: - 4. Server-Backed Structured Office Renderer (DOCX / XLSX / PPTX)

struct LumenOfficeRenderer: LumenPreviewRenderer {
  let rendererID = "server.office.structured"
  let priority = 90
  func canRender(_ item: LumenPreviewItem) -> Bool {
    if case .office = item.kind { return true }
    return false
  }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenOfficeRendererView(palette: context.palette)
  }
}

final class LumenOfficeRendererView: LumenPreviewRendererView, NSTableViewDataSource, NSTableViewDelegate {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let zoomLabel: NSTextField
  private let bodyContainer = NSView()
  private let statusLabel = NSTextField(labelWithString: "正在从本机服务解析结构化预览…")

  // DOCX / PPTX zoom
  private var docPaperWidthConstraint: NSLayoutConstraint?
  private var zoomPercent: CGFloat = 100

  // XLSX state
  private var workbook: LumenWorkbookPreview?
  private var activeSheetIndex = 0
  private var sheetTableView: NSTableView?
  private var cellRefLabel: NSTextField?
  private var formulaField: NSTextField?
  private var sheetTabsStack: NSStackView?

  // PPTX state
  private var presentation: LumenPresentationPreview?
  private var activeSlideIndex = 0
  private var slideTitleLabel: NSTextField?
  private var slideBodyView: NSTextView?
  private var slideCounterLabel: NSTextField?

  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("Office 文档预览", palette: palette)
    zoomLabel = makeStatusLabel("100%", palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupShell()
  }

  required init?(coder: NSCoder) { nil }

  private func setupShell() {
    let zoomOutBtn = makePillButton(title: "−", target: self, action: #selector(zoomOutClicked), palette: palette)
    let zoomInBtn = makePillButton(title: "+", target: self, action: #selector(zoomInClicked), palette: palette)
    let openExternalBtn = makePillButton(title: "外部打开", target: self, action: #selector(openExternal), palette: palette)

    let rightStack = NSStackView(views: [zoomOutBtn, zoomLabel, zoomInBtn, openExternalBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 6
    rightStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(rightStack)

    bodyContainer.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.font = .systemFont(ofSize: 13)
    statusLabel.textColor = palette.muted
    statusLabel.alignment = .center
    statusLabel.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(bodyContainer)
    bodyContainer.addSubview(statusLabel)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      rightStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      rightStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      bodyContainer.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      bodyContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
      bodyContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
      bodyContainer.bottomAnchor.constraint(equalTo: bottomAnchor),

      statusLabel.centerXAnchor.constraint(equalTo: bodyContainer.centerXAnchor),
      statusLabel.centerYAnchor.constraint(equalTo: bodyContainer.centerYAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    clearBody()
    showStatus("正在从本机服务解析结构化预览…")

    if let cached = context.cache.serverPreview(for: item.cacheKey) {
      renderServerPreview(cached)
      return
    }
    guard let clip = item.clipboardItem else {
      showStatus("本地导入的 Office 文件需通过外部应用打开，或先复制到剪贴板由本机服务解析。")
      return
    }
    context.store.api.fetchFilePreview(id: clip.id, index: item.fileIndex) { [weak self] result in
      guard let self, self.loadGeneration == gen else { return }
      switch result {
      case .success(let preview):
        context.cache.storeServerPreview(preview, for: item.cacheKey)
        self.renderServerPreview(preview)
      case .failure(let error):
        self.showStatus("结构化预览不可用：\(error.localizedDescription)")
      }
    }
  }

  private func clearBody() {
    bodyContainer.subviews.forEach { $0.removeFromSuperview() }
    docPaperWidthConstraint = nil
    workbook = nil
    sheetTableView = nil
    presentation = nil
  }

  private func showStatus(_ message: String) {
    clearBody()
    statusLabel.stringValue = message
    bodyContainer.addSubview(statusLabel)
    NSLayoutConstraint.activate([
      statusLabel.centerXAnchor.constraint(equalTo: bodyContainer.centerXAnchor),
      statusLabel.centerYAnchor.constraint(equalTo: bodyContainer.centerYAnchor),
      statusLabel.widthAnchor.constraint(lessThanOrEqualTo: bodyContainer.widthAnchor, constant: -48)
    ])
  }

  private func renderServerPreview(_ preview: LumenServerPreview) {
    clearBody()
    if let office = preview.office {
      if let doc = office.document, !doc.blocks.isEmpty {
        infoLabel.stringValue = "Word · 结构化内容预览 (\(doc.blocks.count) 段落)"
        renderDocx(doc)
        return
      }
      if let wb = office.workbook, !wb.sheets.isEmpty {
        infoLabel.stringValue = "Excel · \(wb.sheets.count) 个工作表"
        renderWorkbook(wb)
        return
      }
      if let pres = office.presentation, !pres.slides.isEmpty {
        infoLabel.stringValue = "PowerPoint · \(pres.slides.count) 页幻灯片"
        renderPresentation(pres)
        return
      }
    }
    if let text = preview.text, !text.isEmpty {
      infoLabel.stringValue = "文档文本预览"
      renderPlainFallbackText(text)
    } else {
      showStatus("此文档暂无可提取的结构化预览，可使用右上角“外部打开”。")
    }
  }

  private func renderDocx(_ doc: LumenDocumentPreview) {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false

    let docHost = LumenFlippedView()
    docHost.translatesAutoresizingMaskIntoConstraints = false

    let paper = NSView()
    paper.wantsLayer = true
    paper.layer?.backgroundColor = NSColor.white.cgColor
    paper.layer?.cornerRadius = 6
    paper.layer?.borderWidth = 1
    paper.layer?.borderColor = NSColor(srgbRed: 0.85, green: 0.88, blue: 0.93, alpha: 1).cgColor
    paper.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false

    let ink = NSColor(srgbRed: 0.15, green: 0.21, blue: 0.30, alpha: 1)
    let subInk = NSColor(srgbRed: 0.35, green: 0.42, blue: 0.52, alpha: 1)

    for block in doc.blocks {
      switch block.kind {
      case "h1":
        let lbl = NSTextField(wrappingLabelWithString: block.text ?? "")
        lbl.font = .systemFont(ofSize: 22, weight: .bold)
        lbl.textColor = ink
        lbl.isSelectable = true
        stack.addArrangedSubview(lbl)
      case "h2":
        let lbl = NSTextField(wrappingLabelWithString: block.text ?? "")
        lbl.font = .systemFont(ofSize: 16, weight: .semibold)
        lbl.textColor = ink
        lbl.isSelectable = true
        stack.addArrangedSubview(lbl)
      case "quote":
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor(srgbRed: 0.933, green: 0.953, blue: 1.0, alpha: 1).cgColor
        box.layer?.cornerRadius = 8
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor(srgbRed: 0.78, green: 0.84, blue: 0.96, alpha: 1).cgColor
        box.translatesAutoresizingMaskIntoConstraints = false
        let lbl = NSTextField(wrappingLabelWithString: block.text ?? "")
        lbl.font = NSFontManager.shared.convert(.systemFont(ofSize: 13.5), toHaveTrait: .italicFontMask)
        lbl.textColor = subInk
        lbl.isSelectable = true
        lbl.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(lbl)
        NSLayoutConstraint.activate([
          lbl.topAnchor.constraint(equalTo: box.topAnchor, constant: 10),
          lbl.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -10),
          lbl.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
          lbl.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14)
        ])
        stack.addArrangedSubview(box)
        box.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
      case "table":
        if let rows = block.rows, !rows.isEmpty {
          let grid = makeNativeDocTable(rows: rows)
          stack.addArrangedSubview(grid)
          grid.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
      default:
        let lbl = NSTextField(wrappingLabelWithString: block.text ?? "")
        lbl.font = .systemFont(ofSize: 13.5)
        lbl.textColor = ink
        lbl.isSelectable = true
        stack.addArrangedSubview(lbl)
      }
    }

    paper.addSubview(stack)
    docHost.addSubview(paper)
    scroll.documentView = docHost
    bodyContainer.addSubview(scroll)

    let widthConstraint = paper.widthAnchor.constraint(equalToConstant: 560 * zoomPercent / 100.0)
    docPaperWidthConstraint = widthConstraint

    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor),

      docHost.widthAnchor.constraint(greaterThanOrEqualTo: scroll.widthAnchor),
      paper.topAnchor.constraint(equalTo: docHost.topAnchor, constant: 24),
      paper.bottomAnchor.constraint(equalTo: docHost.bottomAnchor, constant: -28),
      paper.centerXAnchor.constraint(equalTo: docHost.centerXAnchor),
      widthConstraint,

      stack.topAnchor.constraint(equalTo: paper.topAnchor, constant: 34),
      stack.bottomAnchor.constraint(equalTo: paper.bottomAnchor, constant: -34),
      stack.leadingAnchor.constraint(equalTo: paper.leadingAnchor, constant: 38),
      stack.trailingAnchor.constraint(equalTo: paper.trailingAnchor, constant: -38)
    ])
  }

  private func makeNativeDocTable(rows: [[String]]) -> NSView {
    let container = NSStackView()
    container.orientation = .vertical
    container.spacing = 0
    container.wantsLayer = true
    container.layer?.borderWidth = 1
    container.layer?.borderColor = NSColor(srgbRed: 0.86, green: 0.89, blue: 0.93, alpha: 1).cgColor
    container.layer?.cornerRadius = 6
    container.layer?.masksToBounds = true
    container.translatesAutoresizingMaskIntoConstraints = false

    let colCount = max(1, rows.map(\.count).max() ?? 1)
    for (rowIdx, row) in rows.prefix(30).enumerated() {
      let rowStack = NSStackView()
      rowStack.orientation = .horizontal
      rowStack.distribution = .fillEqually
      rowStack.spacing = 0
      rowStack.wantsLayer = true
      rowStack.layer?.backgroundColor = (rowIdx == 0
        ? NSColor(srgbRed: 0.933, green: 0.949, blue: 0.976, alpha: 1)
        : NSColor.white).cgColor
      for colIdx in 0..<colCount {
        let cellText = colIdx < row.count ? row[colIdx] : ""
        let cell = NSTextField(wrappingLabelWithString: cellText)
        cell.font = .systemFont(ofSize: 12, weight: rowIdx == 0 ? .semibold : .regular)
        cell.textColor = NSColor(srgbRed: 0.16, green: 0.22, blue: 0.31, alpha: 1)
        cell.isSelectable = true
        let wrapper = NSView()
        wrapper.wantsLayer = true
        wrapper.layer?.borderWidth = 0.5
        wrapper.layer?.borderColor = NSColor(srgbRed: 0.88, green: 0.90, blue: 0.94, alpha: 1).cgColor
        cell.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(cell)
        NSLayoutConstraint.activate([
          cell.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 6),
          cell.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -6),
          cell.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 8),
          cell.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -8)
        ])
        rowStack.addArrangedSubview(wrapper)
      }
      container.addArrangedSubview(rowStack)
      rowStack.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
    }
    return container
  }

  private func renderWorkbook(_ wb: LumenWorkbookPreview) {
    workbook = wb
    activeSheetIndex = 0

    let formulaBar = NSView()
    formulaBar.wantsLayer = true
    formulaBar.layer?.backgroundColor = NSColor(srgbRed: 0.945, green: 0.961, blue: 0.953, alpha: 1).cgColor
    formulaBar.translatesAutoresizingMaskIntoConstraints = false

    let refLbl = NSTextField(labelWithString: "A1")
    refLbl.font = .monospacedSystemFont(ofSize: 11.5, weight: .semibold)
    refLbl.textColor = NSColor(srgbRed: 0.15, green: 0.24, blue: 0.26, alpha: 1)
    refLbl.alignment = .center
    refLbl.wantsLayer = true
    refLbl.layer?.backgroundColor = NSColor.white.cgColor
    refLbl.layer?.cornerRadius = 4
    refLbl.layer?.borderWidth = 1
    refLbl.layer?.borderColor = NSColor(srgbRed: 0.83, green: 0.87, blue: 0.85, alpha: 1).cgColor
    refLbl.translatesAutoresizingMaskIntoConstraints = false
    cellRefLabel = refLbl

    let fxLbl = NSTextField(labelWithString: "ƒx")
    fxLbl.font = .systemFont(ofSize: 12, weight: .semibold)
    fxLbl.textColor = NSColor(srgbRed: 0.33, green: 0.44, blue: 0.39, alpha: 1)
    fxLbl.translatesAutoresizingMaskIntoConstraints = false

    let fField = NSTextField(labelWithString: "")
    fField.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    fField.textColor = NSColor(srgbRed: 0.15, green: 0.23, blue: 0.26, alpha: 1)
    fField.isSelectable = true
    fField.wantsLayer = true
    fField.layer?.backgroundColor = NSColor.white.cgColor
    fField.layer?.cornerRadius = 4
    fField.translatesAutoresizingMaskIntoConstraints = false
    formulaField = fField

    formulaBar.addSubview(refLbl)
    formulaBar.addSubview(fxLbl)
    formulaBar.addSubview(fField)

    let table = NSTableView()
    table.usesAlternatingRowBackgroundColors = false
    table.gridStyleMask = [.solidHorizontalGridLineMask, .solidVerticalGridLineMask]
    table.rowHeight = 28
    table.backgroundColor = .white
    table.selectionHighlightStyle = .none
    table.dataSource = self
    table.delegate = self
    table.target = self
    table.action = #selector(sheetCellClicked)
    sheetTableView = table

    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.translatesAutoresizingMaskIntoConstraints = false

    let tabBar = NSView()
    tabBar.wantsLayer = true
    tabBar.layer?.backgroundColor = NSColor(srgbRed: 0.937, green: 0.957, blue: 0.945, alpha: 1).cgColor
    tabBar.translatesAutoresizingMaskIntoConstraints = false

    let tabsStack = NSStackView()
    tabsStack.orientation = .horizontal
    tabsStack.spacing = 6
    tabsStack.translatesAutoresizingMaskIntoConstraints = false
    sheetTabsStack = tabsStack
    tabBar.addSubview(tabsStack)

    bodyContainer.addSubview(formulaBar)
    bodyContainer.addSubview(scroll)
    bodyContainer.addSubview(tabBar)

    NSLayoutConstraint.activate([
      formulaBar.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      formulaBar.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      formulaBar.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      formulaBar.heightAnchor.constraint(equalToConstant: 36),

      refLbl.leadingAnchor.constraint(equalTo: formulaBar.leadingAnchor, constant: 10),
      refLbl.centerYAnchor.constraint(equalTo: formulaBar.centerYAnchor),
      refLbl.widthAnchor.constraint(equalToConstant: 52),
      fxLbl.leadingAnchor.constraint(equalTo: refLbl.trailingAnchor, constant: 8),
      fxLbl.centerYAnchor.constraint(equalTo: formulaBar.centerYAnchor),
      fField.leadingAnchor.constraint(equalTo: fxLbl.trailingAnchor, constant: 8),
      fField.trailingAnchor.constraint(equalTo: formulaBar.trailingAnchor, constant: -10),
      fField.centerYAnchor.constraint(equalTo: formulaBar.centerYAnchor),

      scroll.topAnchor.constraint(equalTo: formulaBar.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: tabBar.topAnchor),

      tabBar.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      tabBar.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      tabBar.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor),
      tabBar.heightAnchor.constraint(equalToConstant: 36),
      tabsStack.leadingAnchor.constraint(equalTo: tabBar.leadingAnchor, constant: 12),
      tabsStack.centerYAnchor.constraint(equalTo: tabBar.centerYAnchor)
    ])

    rebuildSheetTabs()
    reloadActiveSheet()
  }

  private func rebuildSheetTabs() {
    guard let stack = sheetTabsStack, let wb = workbook else { return }
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for (idx, sheet) in wb.sheets.enumerated() {
      let btn = NSButton(title: sheet.name, target: self, action: #selector(selectSheetTab(_:)))
      btn.tag = idx
      btn.isBordered = false
      btn.wantsLayer = true
      btn.font = .systemFont(ofSize: 12, weight: idx == activeSheetIndex ? .semibold : .regular)
      btn.contentTintColor = idx == activeSheetIndex
        ? NSColor(srgbRed: 0.14, green: 0.45, blue: 0.29, alpha: 1)
        : NSColor(srgbRed: 0.33, green: 0.41, blue: 0.37, alpha: 1)
      btn.layer?.cornerRadius = 6
      btn.layer?.backgroundColor = (idx == activeSheetIndex ? NSColor.white : NSColor.clear).cgColor
      btn.translatesAutoresizingMaskIntoConstraints = false
      btn.heightAnchor.constraint(equalToConstant: 24).isActive = true
      stack.addArrangedSubview(btn)
    }
  }

  @objc private func selectSheetTab(_ sender: NSButton) {
    activeSheetIndex = sender.tag
    rebuildSheetTabs()
    reloadActiveSheet()
  }

  private func reloadActiveSheet() {
    guard let table = sheetTableView, let wb = workbook, activeSheetIndex < wb.sheets.count else { return }
    let sheet = wb.sheets[activeSheetIndex]
    while let col = table.tableColumns.last {
      table.removeTableColumn(col)
    }
    let rowNumCol = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("rowNum"))
    rowNumCol.title = ""
    rowNumCol.width = 40
    rowNumCol.minWidth = 36
    rowNumCol.maxWidth = 52
    table.addTableColumn(rowNumCol)

    let colCount = max(6, sheet.rows.map(\.count).max() ?? 6)
    for c in 0..<colCount {
      let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("c\(c)"))
      col.title = Self.columnLetter(c)
      col.width = 118
      col.minWidth = 70
      table.addTableColumn(col)
    }
    table.reloadData()
    updateFormulaBar(row: 0, col: 0)
  }

  @objc private func sheetCellClicked() {
    guard let table = sheetTableView else { return }
    let row = table.clickedRow
    let col = table.clickedColumn - 1
    guard row >= 0, col >= 0 else { return }
    updateFormulaBar(row: row, col: col)
  }

  private func updateFormulaBar(row: Int, col: Int) {
    guard let wb = workbook, activeSheetIndex < wb.sheets.count else { return }
    let sheet = wb.sheets[activeSheetIndex]
    let ref = "\(Self.columnLetter(col))\(row + 1)"
    cellRefLabel?.stringValue = ref
    if let formula = sheet.formulas?[ref], !formula.isEmpty {
      formulaField?.stringValue = formula
    } else if row < sheet.rows.count, col < sheet.rows[row].count {
      formulaField?.stringValue = sheet.rows[row][col]
    } else {
      formulaField?.stringValue = ""
    }
  }

  private static func columnLetter(_ index: Int) -> String {
    var n = index + 1
    var out = ""
    while n > 0 {
      let rem = (n - 1) % 26
      out = String(UnicodeScalar(65 + rem)!) + out
      n = (n - 1) / 26
    }
    return out
  }

  func numberOfRows(in tableView: NSTableView) -> Int {
    guard let wb = workbook, activeSheetIndex < wb.sheets.count else { return 0 }
    return max(16, wb.sheets[activeSheetIndex].rows.count)
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard let id = tableColumn?.identifier.rawValue, let wb = workbook, activeSheetIndex < wb.sheets.count else { return nil }
    let sheet = wb.sheets[activeSheetIndex]
    let field = NSTextField(labelWithString: "")
    field.lineBreakMode = .byTruncatingTail
    field.wantsLayer = true
    if id == "rowNum" {
      field.stringValue = "\(row + 1)"
      field.alignment = .center
      field.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
      field.textColor = NSColor(srgbRed: 0.45, green: 0.52, blue: 0.48, alpha: 1)
      field.layer?.backgroundColor = NSColor(srgbRed: 0.94, green: 0.96, blue: 0.95, alpha: 1).cgColor
      return field
    }
    let colIdx = Int(id.dropFirst()) ?? 0
    let val = (row < sheet.rows.count && colIdx < sheet.rows[row].count) ? sheet.rows[row][colIdx] : ""
    field.stringValue = val
    let isHeader = row == 0
    let isNumeric = !isHeader && val.first.map({ $0.isNumber || $0 == "-" || $0 == "$" }) == true
    field.alignment = isNumeric ? .right : .left
    field.font = isHeader
      ? .systemFont(ofSize: 12, weight: .semibold)
      : (isNumeric ? .monospacedDigitSystemFont(ofSize: 12, weight: .regular) : .systemFont(ofSize: 12))
    field.textColor = isHeader
      ? NSColor(srgbRed: 0.16, green: 0.37, blue: 0.27, alpha: 1)
      : NSColor(srgbRed: 0.15, green: 0.23, blue: 0.26, alpha: 1)
    field.layer?.backgroundColor = (isHeader
      ? NSColor(srgbRed: 0.894, green: 0.941, blue: 0.910, alpha: 1)
      : NSColor.white).cgColor
    return field
  }

  private func renderPresentation(_ pres: LumenPresentationPreview) {
    presentation = pres
    activeSlideIndex = 0

    let prevBtn = makePillButton(title: "‹ 上一页", target: self, action: #selector(prevSlide), palette: palette)
    let nextBtn = makePillButton(title: "下一页 ›", target: self, action: #selector(nextSlide), palette: palette)
    let counter = makeStatusLabel("1 / \(pres.slides.count)", palette: palette)
    slideCounterLabel = counter

    let navStack = NSStackView(views: [prevBtn, counter, nextBtn])
    navStack.orientation = .horizontal
    navStack.spacing = 10
    navStack.translatesAutoresizingMaskIntoConstraints = false

    let card = NSView()
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.white.cgColor
    card.layer?.cornerRadius = 12
    card.layer?.borderWidth = 1
    card.layer?.borderColor = palette.border.cgColor
    card.translatesAutoresizingMaskIntoConstraints = false

    let title = NSTextField(wrappingLabelWithString: "")
    title.font = .systemFont(ofSize: 24, weight: .bold)
    title.textColor = NSColor(srgbRed: 0.14, green: 0.20, blue: 0.30, alpha: 1)
    title.translatesAutoresizingMaskIntoConstraints = false
    slideTitleLabel = title

    let body = NSTextView()
    body.isEditable = false
    body.drawsBackground = false
    body.font = .systemFont(ofSize: 15)
    body.textColor = NSColor(srgbRed: 0.25, green: 0.32, blue: 0.42, alpha: 1)
    body.translatesAutoresizingMaskIntoConstraints = false
    slideBodyView = body

    card.addSubview(title)
    card.addSubview(body)
    bodyContainer.addSubview(card)
    bodyContainer.addSubview(navStack)

    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: bodyContainer.centerXAnchor),
      card.centerYAnchor.constraint(equalTo: bodyContainer.centerYAnchor, constant: -16),
      card.widthAnchor.constraint(lessThanOrEqualTo: bodyContainer.widthAnchor, constant: -64),
      card.widthAnchor.constraint(equalToConstant: 640),
      card.heightAnchor.constraint(equalToConstant: 390),

      title.topAnchor.constraint(equalTo: card.topAnchor, constant: 34),
      title.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 36),
      title.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -36),

      body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 18),
      body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 34),
      body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -34),
      body.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -28),

      navStack.topAnchor.constraint(equalTo: card.bottomAnchor, constant: 14),
      navStack.centerXAnchor.constraint(equalTo: bodyContainer.centerXAnchor)
    ])

    updateActiveSlide()
  }

  private func updateActiveSlide() {
    guard let pres = presentation, !pres.slides.isEmpty else { return }
    let idx = max(0, min(pres.slides.count - 1, activeSlideIndex))
    activeSlideIndex = idx
    let slide = pres.slides[idx]
    slideTitleLabel?.stringValue = slide.title ?? "第 \(slide.number) 页"
    slideBodyView?.string = slide.lines.map { "• \($0)" }.joined(separator: "\n\n")
    slideCounterLabel?.stringValue = "第 \(idx + 1) / \(pres.slides.count) 页"
  }

  @objc private func prevSlide() { _ = stepPage(-1) }
  @objc private func nextSlide() { _ = stepPage(1) }

  override func stepPage(_ delta: Int) -> Bool {
    guard let pres = presentation, !pres.slides.isEmpty else { return false }
    let next = activeSlideIndex + delta
    guard next >= 0 && next < pres.slides.count else { return false }
    activeSlideIndex = next
    updateActiveSlide()
    return true
  }

  private func renderPlainFallbackText(_ text: String) {
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    let tv = NSTextView()
    tv.isEditable = false
    tv.drawsBackground = false
    tv.textContainerInset = NSSize(width: 28, height: 24)
    tv.font = .systemFont(ofSize: 13.5)
    tv.textColor = palette.ink
    tv.string = text
    scroll.documentView = tv
    bodyContainer.addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: bodyContainer.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: bodyContainer.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: bodyContainer.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bodyContainer.bottomAnchor)
    ])
  }

  @objc private func zoomOutClicked() { zoomOut() }
  @objc private func zoomInClicked() { zoomIn() }
  @objc private func openExternal() {
    if let url = currentItem?.localURL {
      NSWorkspace.shared.open(url)
    }
  }

  override func zoomIn() {
    zoomPercent = min(180, zoomPercent + 20)
    docPaperWidthConstraint?.constant = 560 * zoomPercent / 100.0
    zoomLabel.stringValue = "\(Int(zoomPercent))%"
  }

  override func zoomOut() {
    zoomPercent = max(60, zoomPercent - 20)
    docPaperWidthConstraint?.constant = 560 * zoomPercent / 100.0
    zoomLabel.stringValue = "\(Int(zoomPercent))%"
  }

  override func resetZoom() {
    zoomPercent = 100
    docPaperWidthConstraint?.constant = 560
    zoomLabel.stringValue = "100%"
  }
}

// MARK: - 5. Native CoreGraphics Image Renderer

struct LumenImageRenderer: LumenPreviewRenderer {
  let rendererID = "native.coregraphics.image"
  let priority = 88
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .image }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenImageRendererView(palette: context.palette)
  }
}

final class LumenImageRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let zoomLabel: NSTextField
  private let scrollView = NSScrollView()
  private let imageView = NSImageView()
  private var zoomFactor: CGFloat = 1.0
  private var baseImageSize: NSSize = NSSize(width: 480, height: 320)
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("图片预览", palette: palette)
    zoomLabel = makeStatusLabel("适配", palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    let outBtn = makePillButton(title: "−", target: self, action: #selector(zoomOutClicked), palette: palette)
    let fitBtn = makePillButton(title: "适配", target: self, action: #selector(fitClicked), palette: palette)
    let inBtn = makePillButton(title: "+", target: self, action: #selector(zoomInClicked), palette: palette)
    let controls = NSStackView(views: [outBtn, zoomLabel, inBtn, fitBtn])
    controls.orientation = .horizontal
    controls.spacing = 6
    controls.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(controls)

    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.imageAlignment = .alignCenter
    imageView.wantsLayer = true
    imageView.layer?.cornerRadius = 10
    imageView.layer?.masksToBounds = true

    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.drawsBackground = false
    scrollView.allowsMagnification = true
    scrollView.minMagnification = 0.25
    scrollView.maxMagnification = 4.0
    scrollView.documentView = imageView
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      controls.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      controls.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      scrollView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  override func layout() {
    super.layout()
    if abs(zoomFactor - 1.0) < 0.01 {
      applyFitFrame()
    }
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    zoomFactor = 1.0
    zoomLabel.stringValue = "适配"

    if let cached = context.cache.image(for: item.cacheKey) {
      presentImage(cached, item: item)
      return
    }
    if let thumb = item.clipboardItem?.decodedThumbnailImage() {
      presentImage(thumb, item: item)
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let image = NSImage(contentsOf: url) else { return }
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          context.cache.storeImage(image, for: item.cacheKey)
          self.presentImage(image, item: item)
        }
      }
      return
    }
    guard let clip = item.clipboardItem else { return }
    let completion: (Result<(Data, String), Error>) -> Void = { [weak self] result in
      guard let self, self.loadGeneration == gen else { return }
      if case .success(let (data, _)) = result, let image = NSImage(data: data) {
        context.cache.storeImage(image, for: item.cacheKey)
        self.presentImage(image, item: item)
      }
    }
    if clip.kind == "file" {
      context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0, completion: completion)
    } else {
      context.store.api.fetchItemContent(id: clip.id, completion: completion)
    }
  }

  private func presentImage(_ image: NSImage, item: LumenPreviewItem) {
    imageView.image = image
    baseImageSize = image.size.width > 0 && image.size.height > 0 ? image.size : NSSize(width: 480, height: 320)
    infoLabel.stringValue = "图片 · \(Int(baseImageSize.width)) × \(Int(baseImageSize.height)) · \(item.sizeLabel)"
    applyFitFrame()
  }

  private func applyFitFrame() {
    let viewport = scrollView.contentView.bounds.size
    guard viewport.width > 40, viewport.height > 40 else { return }
    let pad: CGFloat = 36
    let scale = min((viewport.width - pad) / max(1, baseImageSize.width), (viewport.height - pad) / max(1, baseImageSize.height), 1.0)
    let w = max(60, baseImageSize.width * scale * zoomFactor)
    let h = max(60, baseImageSize.height * scale * zoomFactor)
    let canvasW = max(viewport.width, w + pad)
    let canvasH = max(viewport.height, h + pad)
    imageView.frame = NSRect(x: 0, y: 0, width: canvasW, height: canvasH)
  }

  @objc private func zoomInClicked() { zoomIn() }
  @objc private func zoomOutClicked() { zoomOut() }
  @objc private func fitClicked() { resetZoom() }

  override func zoomIn() {
    zoomFactor = min(4.0, zoomFactor + 0.25)
    scrollView.magnification = zoomFactor
    zoomLabel.stringValue = "\(Int(zoomFactor * 100))%"
  }

  override func zoomOut() {
    zoomFactor = max(0.25, zoomFactor - 0.25)
    scrollView.magnification = zoomFactor
    zoomLabel.stringValue = "\(Int(zoomFactor * 100))%"
  }

  override func resetZoom() {
    zoomFactor = 1.0
    scrollView.magnification = 1.0
    zoomLabel.stringValue = "适配"
    applyFitFrame()
  }
}

// MARK: - 6. Native CoreGraphics Color Swatch Renderer

struct LumenColorRenderer: LumenPreviewRenderer {
  let rendererID = "native.coregraphics.color"
  let priority = 86
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .color }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenColorRendererView(palette: context.palette)
  }
}

final class LumenColorRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let swatchView = NSView()
  private let hexLabel = NSTextField(labelWithString: "")
  private let rgbLabel = NSTextField(labelWithString: "")
  private let hslLabel = NSTextField(labelWithString: "")

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    swatchView.wantsLayer = true
    swatchView.layer?.cornerRadius = 18
    swatchView.layer?.cornerCurve = .continuous
    swatchView.layer?.borderWidth = 1
    swatchView.layer?.borderColor = NSColor.white.withAlphaComponent(0.28).cgColor
    swatchView.translatesAutoresizingMaskIntoConstraints = false

    hexLabel.font = .monospacedSystemFont(ofSize: 28, weight: .bold)
    hexLabel.textColor = palette.ink
    hexLabel.isSelectable = true
    hexLabel.translatesAutoresizingMaskIntoConstraints = false

    for lbl in [rgbLabel, hslLabel] {
      lbl.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
      lbl.textColor = palette.muted
      lbl.isSelectable = true
      lbl.translatesAutoresizingMaskIntoConstraints = false
    }

    let copyBtn = makePillButton(title: "复制色值", target: self, action: #selector(copySwatch), palette: palette)
    let stack = NSStackView(views: [swatchView, hexLabel, rgbLabel, hslLabel, copyBtn])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(18, after: swatchView)
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      swatchView.widthAnchor.constraint(equalToConstant: 360),
      swatchView.heightAnchor.constraint(equalToConstant: 210),
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    let raw = (item.inlineText ?? item.title).trimmingCharacters(in: .whitespacesAndNewlines)
    let color = LumenClassifier.parseHexColor(raw) ?? palette.accent
    let srgb = color.usingColorSpace(.sRGB) ?? color
    swatchView.layer?.backgroundColor = srgb.cgColor
    hexLabel.stringValue = raw.uppercased()
    let r = Int(round(srgb.redComponent * 255))
    let g = Int(round(srgb.greenComponent * 255))
    let b = Int(round(srgb.blueComponent * 255))
    rgbLabel.stringValue = "RGB(\(r), \(g), \(b))"
    var h: CGFloat = 0, s: CGFloat = 0, br: CGFloat = 0, a: CGFloat = 0
    srgb.getHue(&h, saturation: &s, brightness: &br, alpha: &a)
    hslLabel.stringValue = String(format: "HSB(%.0f°, %.0f%%, %.0f%%)", h * 360, s * 100, br * 100)
  }

  @objc private func copySwatch() { copyPrimaryContent() }
}

// MARK: - 7. Native Syntax-Highlighted Code Renderer

struct LumenCodeRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.code"
  let priority = 84
  func canRender(_ item: LumenPreviewItem) -> Bool {
    if case .code = item.kind { return true }
    return false
  }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenCodeRendererView(palette: context.palette)
  }
}

final class LumenCodeRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let scrollView = NSScrollView()
  private let textView = NSTextView()
  private var codeContent = ""
  private var language = "js"
  private var fontSize: CGFloat = 13
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette, darkOverride: true)
    infoLabel = makeStatusLabel("代码预览", palette: palette, dark: true)
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.codeBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    let copyBtn = makePillButton(title: "复制代码", target: self, action: #selector(copyCodeClicked), palette: palette, dark: true)
    let smallerBtn = makePillButton(title: "A−", target: self, action: #selector(zoomOutClicked), palette: palette, dark: true)
    let largerBtn = makePillButton(title: "A+", target: self, action: #selector(zoomInClicked), palette: palette, dark: true)

    let rightStack = NSStackView(views: [smallerBtn, largerBtn, copyBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 6
    rightStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(rightStack)

    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = true
    textView.backgroundColor = palette.codeBackground
    textView.textContainerInset = NSSize(width: 18, height: 18)
    textView.isHorizontallyResizable = true
    textView.isVerticallyResizable = true
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.widthTracksTextView = false
    textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.drawsBackground = true
    scrollView.backgroundColor = palette.codeBackground
    scrollView.documentView = textView
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      rightStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      rightStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      scrollView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    if case .code(let lang) = item.kind {
      language = lang
    }

    if let cached = context.cache.text(for: item.cacheKey) {
      applyCode(cached)
      return
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let data = try? Data(contentsOf: url)
        let text = data.flatMap { String(data: $0.prefix(128_000), encoding: .utf8) } ?? ""
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          context.cache.storeText(text, for: item.cacheKey)
          self.applyCode(text)
        }
      }
      return
    }
    if let inline = item.inlineText {
      applyCode(inline)
    }
    if let clip = item.clipboardItem {
      if clip.kind == "file" {
        context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0) { [weak self] result in
          guard let self, self.loadGeneration == gen else { return }
          if case .success(let (data, _)) = result, let text = String(data: data, encoding: .utf8) {
            context.cache.storeText(text, for: item.cacheKey)
            self.applyCode(text)
          }
        }
      } else {
        context.store.hydrateItemDetail(id: clip.id) { [weak self] detailed in
          guard let self, self.loadGeneration == gen, let full = detailed?.effectiveText else { return }
          context.cache.storeText(full, for: item.cacheKey)
          self.applyCode(full)
        }
      }
    }
  }

  private func applyCode(_ source: String) {
    codeContent = source
    let lines = source.components(separatedBy: "\n")
    let langTitle = LumenClassifier.languageDisplayName(language)
    infoLabel.stringValue = "● \(langTitle) · \(lines.count) 行 · UTF-8"

    let gutterWidth = max(3, String(lines.count).count)
    let numbered = NSMutableAttributedString()
    let gutterFont = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let gutterAttrs: [NSAttributedString.Key: Any] = [
      .font: gutterFont,
      .foregroundColor: palette.codeGutterText
    ]
    let highlightedFull = LumenSyntaxHighlighter.highlight(source, language: language, fontSize: fontSize, darkCanvas: true)
    let nsSource = source as NSString
    var cursor = 0
    for (idx, line) in lines.enumerated() {
      let prefix = String(format: "%\(gutterWidth)d   ", idx + 1)
      numbered.append(NSAttributedString(string: prefix, attributes: gutterAttrs))
      let len = (line as NSString).length
      if cursor + len <= highlightedFull.length {
        numbered.append(highlightedFull.attributedSubstring(from: NSRange(location: cursor, length: len)))
      } else {
        numbered.append(NSAttributedString(string: line, attributes: [.font: gutterFont, .foregroundColor: palette.codeBaseText]))
      }
      if idx < lines.count - 1 {
        numbered.append(NSAttributedString(string: "\n", attributes: gutterAttrs))
      }
      cursor += len + 1
      if cursor > nsSource.length { break }
    }
    textView.textStorage?.setAttributedString(numbered)
  }

  @objc private func copyCodeClicked() { copyPrimaryContent() }
  @objc private func zoomInClicked() { zoomIn() }
  @objc private func zoomOutClicked() { zoomOut() }

  override func zoomIn() {
    fontSize = min(22, fontSize + 1.5)
    applyCode(codeContent)
  }

  override func zoomOut() {
    fontSize = max(9.5, fontSize - 1.5)
    applyCode(codeContent)
  }

  override func resetZoom() {
    fontSize = 13
    applyCode(codeContent)
  }
}

// MARK: - 8. Native Collection Overview Renderer

struct LumenCollectionRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.collection"
  let priority = 82
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .collection }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenCollectionRendererView(palette: context.palette)
  }
}

final class LumenCollectionRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let scrollView = NSScrollView()
  private let stack = NSStackView()

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor

    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false

    let docView = LumenFlippedView()
    docView.translatesAutoresizingMaskIntoConstraints = false
    docView.addSubview(stack)

    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.documentView = docView
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      scrollView.topAnchor.constraint(equalTo: topAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
      docView.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
      stack.topAnchor.constraint(equalTo: docView.topAnchor, constant: 24),
      stack.leadingAnchor.constraint(equalTo: docView.leadingAnchor, constant: 28),
      stack.trailingAnchor.constraint(equalTo: docView.trailingAnchor, constant: -28),
      stack.bottomAnchor.constraint(equalTo: docView.bottomAnchor, constant: -24)
    ])
  }

  required init?(coder: NSCoder) { nil }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }

    let heading = NSTextField(labelWithString: "文件集合 · \(item.collectionChildren.count) 项")
    heading.font = .systemFont(ofSize: 18, weight: .semibold)
    heading.textColor = palette.ink
    stack.addArrangedSubview(heading)

    for (idx, child) in item.collectionChildren.enumerated() {
      let row = NSButton(title: "", target: self, action: #selector(childClicked(_:)))
      row.tag = idx
      row.isBordered = false
      row.wantsLayer = true
      row.layer?.cornerRadius = 10
      row.layer?.backgroundColor = palette.surface.cgColor
      row.layer?.borderWidth = 1
      row.layer?.borderColor = palette.border.cgColor
      row.translatesAutoresizingMaskIntoConstraints = false

      let icon = NSImageView(image: child.localURL.map { NSWorkspace.shared.icon(forFile: $0.path) } ?? LumenIcons.symbol("doc.fill", size: 18))
      icon.translatesAutoresizingMaskIntoConstraints = false
      let name = NSTextField(labelWithString: child.title)
      name.font = .systemFont(ofSize: 13, weight: .medium)
      name.textColor = palette.ink
      name.lineBreakMode = .byTruncatingMiddle
      name.translatesAutoresizingMaskIntoConstraints = false
      let meta = NSTextField(labelWithString: "\(child.kind.displayLabel) · \(child.sizeLabel)")
      meta.font = .systemFont(ofSize: 11)
      meta.textColor = palette.muted
      meta.translatesAutoresizingMaskIntoConstraints = false

      row.addSubview(icon)
      row.addSubview(name)
      row.addSubview(meta)

      NSLayoutConstraint.activate([
        row.heightAnchor.constraint(equalToConstant: 48),
        icon.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
        icon.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        icon.widthAnchor.constraint(equalToConstant: 28),
        icon.heightAnchor.constraint(equalToConstant: 28),
        name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
        name.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        meta.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 12),
        meta.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -14),
        meta.centerYAnchor.constraint(equalTo: row.centerYAnchor)
      ])
      stack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
  }

  @objc private func childClicked(_ sender: NSButton) {
    currentContext?.onSelectQueueIndex(sender.tag)
  }
}

// MARK: - 9. Native Text & Link Renderer

struct LumenTextRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.text"
  let priority = 70
  func canRender(_ item: LumenPreviewItem) -> Bool {
    item.kind == .text || item.kind == .link
  }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenTextRendererView(palette: context.palette)
  }
}

final class LumenTextRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let openLinkBtn: NSButton
  private let scrollView = NSScrollView()
  private let textView = NSTextView()
  private var fontSize: CGFloat = 15
  private var activeURL: URL?
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("文本预览", palette: palette)
    openLinkBtn = NSButton()
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    openLinkBtn.title = "打开链接"
    openLinkBtn.target = self
    openLinkBtn.action = #selector(openURLClicked)
    openLinkBtn.isBordered = false
    openLinkBtn.wantsLayer = true
    openLinkBtn.font = .systemFont(ofSize: 11.5, weight: .medium)
    openLinkBtn.contentTintColor = palette.accent
    openLinkBtn.layer?.cornerRadius = 7
    openLinkBtn.layer?.borderWidth = 1
    openLinkBtn.layer?.borderColor = palette.accentBorder.cgColor
    openLinkBtn.layer?.backgroundColor = palette.accentSoft.cgColor
    openLinkBtn.translatesAutoresizingMaskIntoConstraints = false
    openLinkBtn.heightAnchor.constraint(equalToConstant: 26).isActive = true
    openLinkBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 72).isActive = true
    openLinkBtn.isHidden = true

    let copyBtn = makePillButton(title: "复制内容", target: self, action: #selector(copyClicked), palette: palette)
    let rightStack = NSStackView(views: [openLinkBtn, copyBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 8
    rightStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(rightStack)

    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.textColor = palette.ink
    textView.font = .systemFont(ofSize: fontSize)
    textView.textContainerInset = NSSize(width: 28, height: 24)
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.textContainer?.widthTracksTextView = true

    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.documentView = textView
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      rightStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      rightStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      scrollView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration
    activeURL = nil
    openLinkBtn.isHidden = true

    if let cached = context.cache.text(for: item.cacheKey) {
      applyText(cached, isLink: item.kind == .link)
      return
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let text = (try? Data(contentsOf: url)).flatMap { String(data: $0.prefix(128_000), encoding: .utf8) } ?? ""
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          context.cache.storeText(text, for: item.cacheKey)
          self.applyText(text, isLink: false)
        }
      }
      return
    }
    if let inline = item.inlineText {
      applyText(inline, isLink: item.kind == .link)
    }
    if let clip = item.clipboardItem {
      if clip.kind == "file" {
        context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0) { [weak self] result in
          guard let self, self.loadGeneration == gen else { return }
          if case .success(let (data, _)) = result, let text = String(data: data, encoding: .utf8) {
            context.cache.storeText(text, for: item.cacheKey)
            self.applyText(text, isLink: false)
          }
        }
      } else {
        context.store.hydrateItemDetail(id: clip.id) { [weak self] detailed in
          guard let self, self.loadGeneration == gen, let full = detailed?.effectiveText else { return }
          context.cache.storeText(full, for: item.cacheKey)
          self.applyText(full, isLink: item.kind == .link)
        }
      }
    }
  }

  private func applyText(_ content: String, isLink: Bool) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.55
    textView.textStorage?.setAttributedString(NSAttributedString(
      string: content,
      attributes: [
        .font: NSFont.systemFont(ofSize: fontSize),
        .foregroundColor: palette.ink,
        .paragraphStyle: paragraph
      ]
    ))
    let lines = max(1, content.components(separatedBy: "\n").count)
    infoLabel.stringValue = "\(isLink ? "链接" : "文本") · \(content.count) 字 · \(lines) 行 · \(LumenFormatters.byteCount(Int64(content.utf8.count)))"
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    if isLink, let url = URL(string: trimmed), let scheme = url.scheme, (scheme == "http" || scheme == "https") {
      activeURL = url
      openLinkBtn.isHidden = false
    }
  }

  @objc private func openURLClicked() {
    if let url = activeURL { NSWorkspace.shared.open(url) }
  }

  @objc private func copyClicked() { copyPrimaryContent() }

  override func zoomIn() {
    fontSize = min(26, fontSize + 2)
    applyText(textView.string, isLink: activeURL != nil)
  }

  override func zoomOut() {
    fontSize = max(11, fontSize - 2)
    applyText(textView.string, isLink: activeURL != nil)
  }

  override func resetZoom() {
    fontSize = 15
    applyText(textView.string, isLink: activeURL != nil)
  }
}

// MARK: - 10. Native File Fallback Renderer

struct LumenFileFallbackRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.file.fallback"
  let priority = 0
  func canRender(_ item: LumenPreviewItem) -> Bool { true }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenFileFallbackRendererView(palette: context.palette)
  }
}

final class LumenFileFallbackRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let iconView = NSImageView()
  private let nameLabel = NSTextField(labelWithString: "")
  private let metaLabel = NSTextField(wrappingLabelWithString: "")

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.translatesAutoresizingMaskIntoConstraints = false

    nameLabel.font = .systemFont(ofSize: 18, weight: .semibold)
    nameLabel.textColor = palette.ink
    nameLabel.alignment = .center
    nameLabel.lineBreakMode = .byTruncatingMiddle
    nameLabel.translatesAutoresizingMaskIntoConstraints = false

    metaLabel.font = .systemFont(ofSize: 12.5)
    metaLabel.textColor = palette.muted
    metaLabel.alignment = .center
    metaLabel.translatesAutoresizingMaskIntoConstraints = false

    let reveal = makePillButton(title: "在访达中显示", target: self, action: #selector(revealInFinder), palette: palette)
    let open = makePillButton(title: "默认应用打开", target: self, action: #selector(openWithDefault), palette: palette)
    let copyBtn = makePillButton(title: "复制引用", target: self, action: #selector(copyClicked), palette: palette)

    let actions = NSStackView(views: [reveal, open, copyBtn])
    actions.orientation = .horizontal
    actions.spacing = 10
    actions.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [iconView, nameLabel, metaLabel, actions])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(18, after: metaLabel)
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      iconView.widthAnchor.constraint(equalToConstant: 72),
      iconView.heightAnchor.constraint(equalToConstant: 72),
      nameLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
      metaLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    if let url = item.localURL {
      iconView.image = NSWorkspace.shared.icon(forFile: url.path)
      metaLabel.stringValue = "\(url.path)\n\(item.sizeLabel) · 尚无此格式的内置渲染器，可调用系统默认应用打开。"
    } else {
      iconView.image = LumenIcons.symbol("doc.fill", size: 42)
      iconView.contentTintColor = palette.accent
      metaLabel.stringValue = "\(item.sizeLabel) · 尚无此格式的内置渲染器。"
    }
    nameLabel.stringValue = item.title
  }

  @objc private func revealInFinder() {
    if let url = currentItem?.localURL {
      NSWorkspace.shared.activateFileViewerSelecting([url])
    }
  }

  @objc private func openWithDefault() {
    if let url = currentItem?.localURL {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func copyClicked() { copyPrimaryContent() }
}

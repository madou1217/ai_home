import AppKit
import AVFoundation
import AVKit
import CoreGraphics
import CoreMedia
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

/// Interactive 66-bar CoreGraphics waveform driven exclusively by decoded PCM peaks (click & drag seek).
private final class LumenWaveformView: NSView {
  /// Neutral flat baseline until real PCM audio peaks finish decoding (never fakes waveform shapes).
  var peaks: [CGFloat] = [CGFloat](repeating: 0.16, count: 66) { didSet { needsDisplay = true } }
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
      let norm = max(0.10, min(1.0, peaks[i]))
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
  enum RepeatMode: Int {
    case off = 0
    case loopQueue = 1
    case repeatOne = 2

    var next: RepeatMode {
      RepeatMode(rawValue: (rawValue + 1) % 3) ?? .off
    }

    var symbolName: String {
      switch self {
      case .off: return "repeat"
      case .loopQueue: return "repeat"
      case .repeatOne: return "repeat.1"
      }
    }

    var label: String {
      switch self {
      case .off: return "循环：关闭"
      case .loopQueue: return "循环：列表循环"
      case .repeatOne: return "循环：单曲循环"
      }
    }
  }

  private let palette: LumenPalette
  private let coverView = LumenAlbumCoverView()
  private let titleLabel = NSTextField(labelWithString: "")
  private let subtitleLabel = NSTextField(labelWithString: "")
  private let waveformView = LumenWaveformView()
  private let nowLabel = NSTextField(labelWithString: "0:00")
  private let durationLabel = NSTextField(labelWithString: "0:00")
  private let seekSlider = NSSlider(value: 0, minValue: 0, maxValue: 1000, target: nil, action: nil)
  private let muteButton = NSButton()
  private let volumeSlider = NSSlider(value: 0.75, minValue: 0, maxValue: 1, target: nil, action: nil)
  private let repeatButton = NSButton()
  private let prevButton = NSButton()
  private let playButton = NSButton()
  private let nextButton = NSButton()
  private let statusLabel = NSTextField(labelWithString: "")

  private var activeAsset: AVURLAsset?
  private var player: AVPlayer?
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var durationSeconds: Double = 0
  private var repeatMode: RepeatMode = .off
  private var isMuted = false
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

    configureTransportButton(repeatButton, symbol: "repeat", size: 15, tip: "切换循环模式", action: #selector(toggleRepeat))
    configureTransportButton(prevButton, symbol: "backward.end.fill", size: 16, tip: "上一首", action: #selector(stepPrev))
    configureTransportButton(nextButton, symbol: "forward.end.fill", size: 16, tip: "下一首", action: #selector(stepNext))

    playButton.isBordered = false
    playButton.wantsLayer = true
    playButton.target = self
    playButton.action = #selector(playButtonClicked)
    playButton.image = LumenIcons.symbol("play.fill", size: 20, weight: .semibold)
    playButton.contentTintColor = .white
    playButton.toolTip = "播放 / 暂停 (Space)"
    playButton.layer?.cornerRadius = 26
    playButton.layer?.backgroundColor = palette.accent.cgColor
    playButton.translatesAutoresizingMaskIntoConstraints = false

    let controlsStack = NSStackView(views: [repeatButton, prevButton, playButton, nextButton])
    controlsStack.orientation = .horizontal
    controlsStack.spacing = 18
    controlsStack.alignment = .centerY
    controlsStack.translatesAutoresizingMaskIntoConstraints = false

    muteButton.isBordered = false
    muteButton.image = LumenIcons.symbol("speaker.wave.2.fill", size: 12)
    muteButton.contentTintColor = palette.muted
    muteButton.toolTip = "静音 / 取消静音"
    muteButton.target = self
    muteButton.action = #selector(toggleMute)
    muteButton.translatesAutoresizingMaskIntoConstraints = false
    muteButton.widthAnchor.constraint(equalToConstant: 22).isActive = true
    muteButton.heightAnchor.constraint(equalToConstant: 22).isActive = true

    volumeSlider.target = self
    volumeSlider.action = #selector(volumeChanged)
    volumeSlider.isContinuous = true
    volumeSlider.translatesAutoresizingMaskIntoConstraints = false
    volumeSlider.widthAnchor.constraint(equalToConstant: 118).isActive = true

    let volumeStack = NSStackView(views: [muteButton, volumeSlider])
    volumeStack.orientation = .horizontal
    volumeStack.spacing = 6
    volumeStack.alignment = .centerY
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
    updateRepeatButtonAppearance()
  }

  private func configureTransportButton(_ button: NSButton, symbol: String, size: CGFloat, tip: String, action: Selector) {
    button.isBordered = false
    button.wantsLayer = true
    button.image = LumenIcons.symbol(symbol, size: size, weight: .medium)
    button.contentTintColor = palette.ink
    button.toolTip = tip
    button.target = self
    button.action = action
    button.layer?.cornerRadius = 17
    button.translatesAutoresizingMaskIntoConstraints = false
    button.widthAnchor.constraint(equalToConstant: 34).isActive = true
    button.heightAnchor.constraint(equalToConstant: 34).isActive = true
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    // Opening Quick Look NEVER auto-plays audio (Q06, Q08, A13)
    loadTrack(item: item, context: context, autoPlay: false)
  }

  /// Reuses this single audio player across tracks in an audio collection while preserving
  /// volume, mute, and repeat mode and releasing the previous track's decoder immediately.
  func loadTrack(item: LumenPreviewItem, context: LumenPreviewContext, autoPlay: Bool) {
    stopCurrentPlaybackAndReleaseDecoder()
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration

    let hasQueue = context.queueCount > 1
    prevButton.isHidden = !hasQueue
    nextButton.isHidden = !hasQueue
    prevButton.isEnabled = hasQueue && (context.queueIndex > 0 || repeatMode == .loopQueue)
    nextButton.isEnabled = hasQueue && (context.queueIndex < context.queueCount - 1 || repeatMode == .loopQueue)

    coverView.seedIndex = item.seedIndex
    coverView.badgeText = hasQueue
      ? String(format: "TRACK %02d / %02d", context.queueIndex + 1, context.queueCount)
      : "LUMEN / AUDIO"
    titleLabel.stringValue = (item.title as NSString).deletingPathExtension
    subtitleLabel.stringValue = "\(item.subtitle) · \(item.sizeLabel)"
    statusLabel.stringValue = repeatMode == .off ? "" : repeatMode.label
    nowLabel.stringValue = "0:00"
    durationLabel.stringValue = "0:00"
    durationSeconds = 0
    seekSlider.doubleValue = 0
    waveformView.progress = 0
    waveformView.peaks = [CGFloat](repeating: 0.16, count: 66)

    let asset: AVURLAsset?
    if let localURL = item.localURL, FileManager.default.fileExists(atPath: localURL.path) {
      let localAsset = AVURLAsset(url: localURL)
      asset = localAsset
      decodeRealPCMWaveform(localURL: localURL, asset: localAsset, cacheKey: item.cacheKey, cache: context.cache, generation: gen)
    } else if let clip = item.clipboardItem,
              let streamURL = context.store.api.itemFileStreamURL(itemID: clip.id, index: item.fileIndex ?? 0) {
      let headers = context.store.api.authHeaders()
      let remoteAsset = AVURLAsset(url: streamURL, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
      asset = remoteAsset
      decodeRemotePCMWaveform(clipID: clip.id, fileIndex: item.fileIndex ?? 0, cacheKey: item.cacheKey, context: context, generation: gen)
    } else {
      asset = nil
    }

    guard let asset else {
      statusLabel.stringValue = "音频文件不可用"
      setPlayingUI(false)
      return
    }

    activeAsset = asset
    let playerItem = AVPlayerItem(asset: asset)
    let avPlayer = AVPlayer(playerItem: playerItem)
    avPlayer.volume = isMuted ? 0 : Float(volumeSlider.doubleValue)
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
      self.handleTrackEnded()
    }

    if autoPlay {
      avPlayer.play()
      setPlayingUI(true)
    } else {
      setPlayingUI(false)
    }
  }

  private func handleTrackEnded() {
    switch repeatMode {
    case .repeatOne:
      player?.seek(to: .zero)
      player?.play()
      setPlayingUI(true)
    case .loopQueue:
      guard let ctx = currentContext else { return }
      if ctx.queueCount <= 1 {
        player?.seek(to: .zero)
        player?.play()
        setPlayingUI(true)
      } else if ctx.queueIndex + 1 < ctx.queueCount {
        ctx.onStepQueue(1, true)
      } else {
        // Wrap back to first track and continue playback
        ctx.onStepQueue(-ctx.queueIndex, true)
      }
    case .off:
      guard let ctx = currentContext else {
        setPlayingUI(false)
        return
      }
      if ctx.queueIndex + 1 < ctx.queueCount {
        ctx.onStepQueue(1, true)
      } else {
        setPlayingUI(false)
      }
    }
  }

  /// Decodes real PCM samples into 66 RMS amplitude bars (AVAudioFile first, AVAssetReader PCM fallback).
  private func decodeRealPCMWaveform(localURL: URL, asset: AVAsset, cacheKey: String, cache: LumenPreviewCache, generation: Int) {
    if let cached = cache.waveform(for: cacheKey) {
      waveformView.peaks = cached
      return
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let peaks = Self.extractPCMPeaksFromFile(url: localURL) ?? Self.extractPCMPeaksViaAssetReader(asset: asset)
      guard let peaks, !peaks.isEmpty else { return }
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == generation else { return }
        cache.storeWaveform(peaks, for: cacheKey)
        self.waveformView.peaks = peaks
      }
    }
  }

  private func decodeRemotePCMWaveform(clipID: String, fileIndex: Int, cacheKey: String, context: LumenPreviewContext, generation: Int) {
    if let cached = context.cache.waveform(for: cacheKey) {
      waveformView.peaks = cached
      return
    }
    context.store.api.fetchItemFileData(id: clipID, index: fileIndex) { [weak self] result in
      guard let self, self.loadGeneration == generation else { return }
      guard case .success(let (data, _)) = result, data.count <= 24 * 1024 * 1024 else { return }
      let titleForExt = self.currentItem?.title ?? "audio.m4a"
      DispatchQueue.global(qos: .utility).async {
        let ext = URL(fileURLWithPath: titleForExt).pathExtension
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("lumen-pcm-\(UUID().uuidString).\(ext.isEmpty ? "m4a" : ext)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard (try? data.write(to: tmp)) != nil else { return }
        let peaks = Self.extractPCMPeaksFromFile(url: tmp) ?? Self.extractPCMPeaksViaAssetReader(asset: AVURLAsset(url: tmp))
        guard let peaks, !peaks.isEmpty else { return }
        DispatchQueue.main.async {
          guard self.loadGeneration == generation else { return }
          context.cache.storeWaveform(peaks, for: cacheKey)
          self.waveformView.peaks = peaks
        }
      }
    }
  }

  private static func extractPCMPeaksFromFile(url: URL) -> [CGFloat]? {
    guard let audioFile = try? AVAudioFile(forReading: url) else { return nil }
    let totalFrames = Int(audioFile.length)
    guard totalFrames > 0 else { return nil }
    let barCount = 66
    let maxFramesToRead = min(totalFrames, 44_100 * 180)
    let format = audioFile.processingFormat
    let frameChunk = max(256, maxFramesToRead / barCount)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(min(frameChunk, 16_384))) else {
      return nil
    }
    var peaks: [CGFloat] = []
    peaks.reserveCapacity(barCount)
    for i in 0..<barCount {
      let startFrame = AVAudioFramePosition(Int64(i) * Int64(totalFrames) / Int64(barCount))
      audioFile.framePosition = startFrame
      let readCount = AVAudioFrameCount(min(Int(buffer.frameCapacity), max(1, totalFrames - Int(startFrame))))
      do {
        try audioFile.read(into: buffer, frameCount: readCount)
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else {
          peaks.append(0.12)
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
        peaks.append(0.12)
      }
    }
    let peakMax = max(0.001, peaks.max() ?? 0.001)
    return peaks.map { max(0.12, pow($0 / peakMax, 0.72)) }
  }

  private static func extractPCMPeaksViaAssetReader(asset: AVAsset) -> [CGFloat]? {
    guard let track = asset.tracks(withMediaType: .audio).first,
          let reader = try? AVAssetReader(asset: asset) else { return nil }
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMBitDepthKey: 32,
      AVLinearPCMIsFloatKey: true,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }

    var buckets = [Double](repeating: 0, count: 66)
    var counts = [Int](repeating: 0, count: 66)
    let estimatedSamples = max(66, Int(CMTimeGetSeconds(asset.duration) * 44_100))
    var sampleIndex = 0
    let maxSamples = 44_100 * 180

    while reader.status == .reading && sampleIndex < maxSamples,
          let sampleBuffer = output.copyNextSampleBuffer() {
      guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
      let byteLength = CMBlockBufferGetDataLength(blockBuffer)
      guard byteLength >= 4 else { continue }
      var raw = [Float](repeating: 0, count: byteLength / 4)
      raw.withUnsafeMutableBytes { ptr in
        if let base = ptr.baseAddress {
          _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: byteLength, destination: base)
        }
      }
      let step = max(1, raw.count / 64)
      var i = 0
      while i < raw.count {
        let bucketIdx = min(65, (sampleIndex + i) * 66 / max(1, estimatedSamples))
        let v = Double(raw[i])
        buckets[bucketIdx] += v * v
        counts[bucketIdx] += 1
        i += step
      }
      sampleIndex += raw.count
    }
    reader.cancelReading()

    let rms = (0..<66).map { i -> CGFloat in
      let c = counts[i]
      guard c > 0 else { return 0.12 }
      return CGFloat(sqrt(buckets[i] / Double(c)))
    }
    let peakMax = max(0.001, rms.max() ?? 0.001)
    return rms.map { max(0.12, pow($0 / peakMax, 0.72)) }
  }

  private func updateRepeatButtonAppearance() {
    repeatButton.image = LumenIcons.symbol(repeatMode.symbolName, size: 15, weight: .medium)
    repeatButton.contentTintColor = repeatMode == .off ? palette.ink : palette.accent
    repeatButton.toolTip = repeatMode.label
    statusLabel.stringValue = repeatMode == .off ? "" : repeatMode.label
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

  @objc private func stepPrev() {
    guard let ctx = currentContext else { return }
    let shouldResume = isPlaying
    if ctx.queueIndex > 0 {
      ctx.onStepQueue(-1, shouldResume)
    } else if repeatMode == .loopQueue && ctx.queueCount > 1 {
      ctx.onStepQueue(ctx.queueCount - 1, shouldResume)
    }
  }

  @objc private func stepNext() {
    guard let ctx = currentContext else { return }
    let shouldResume = isPlaying
    if ctx.queueIndex + 1 < ctx.queueCount {
      ctx.onStepQueue(1, shouldResume)
    } else if repeatMode == .loopQueue && ctx.queueCount > 1 {
      ctx.onStepQueue(-ctx.queueIndex, shouldResume)
    }
  }

  @objc private func toggleRepeat() {
    repeatMode = repeatMode.next
    updateRepeatButtonAppearance()
    if let ctx = currentContext {
      let hasQueue = ctx.queueCount > 1
      prevButton.isEnabled = hasQueue && (ctx.queueIndex > 0 || repeatMode == .loopQueue)
      nextButton.isEnabled = hasQueue && (ctx.queueIndex < ctx.queueCount - 1 || repeatMode == .loopQueue)
    }
  }

  @objc private func toggleMute() {
    isMuted.toggle()
    player?.volume = isMuted ? 0 : Float(volumeSlider.doubleValue)
    muteButton.image = LumenIcons.symbol(isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill", size: 12)
  }

  @objc private func seekSliderChanged() {
    seekToFraction(seekSlider.doubleValue / 1000.0)
  }

  @objc private func volumeChanged() {
    if isMuted && volumeSlider.doubleValue > 0 {
      isMuted = false
      muteButton.image = LumenIcons.symbol("speaker.wave.2.fill", size: 12)
    }
    player?.volume = isMuted ? 0 : Float(volumeSlider.doubleValue)
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

  private func stopCurrentPlaybackAndReleaseDecoder() {
    loadGeneration += 1
    activeAsset?.cancelLoading()
    activeAsset = nil
    if let obs = timeObserver, let player {
      player.removeTimeObserver(obs)
    }
    timeObserver = nil
    if let obs = endObserver {
      NotificationCenter.default.removeObserver(obs)
      endObserver = nil
    }
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    isPlaying = false
  }

  override func teardown() {
    stopCurrentPlaybackAndReleaseDecoder()
  }
}

// MARK: - 3. Native AVKit / AVFoundation Video Renderer (Supports Video Queues, Never Auto-Plays)

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
  private let badgeLabel: NSTextField
  private let playerView = AVPlayerView()
  private var activeAsset: AVURLAsset?
  private var player: AVPlayer?
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("视频预览", palette: palette)
    badgeLabel = makeStatusLabel("AVKit 原生控件 · 打开不自动播放", palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  deinit {
    teardown()
  }

  private func setupUI() {
    toolbar.addSubview(infoLabel)
    toolbar.addSubview(badgeLabel)

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
      badgeLabel.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      badgeLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

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

    let queuePrefix = context.queueCount > 1 ? "视频队列 \(context.queueIndex + 1) / \(context.queueCount)" : "视频预览"
    badgeLabel.stringValue = context.queueCount > 1 ? "← → 切换视频 · Space 播放/暂停" : "AVKit 原生控件 · Space 播放/暂停"

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
    activeAsset = asset
    let avPlayer = AVPlayer(playerItem: AVPlayerItem(asset: asset))
    avPlayer.pause() // Strictly never auto-play on open (Q08, A13)
    player = avPlayer
    playerView.player = avPlayer
    infoLabel.stringValue = "\(queuePrefix) · \(item.sizeLabel)"

    asset.loadValuesAsynchronously(forKeys: ["duration", "tracks"]) { [weak self] in
      let secs = CMTimeGetSeconds(asset.duration)
      let track = asset.tracks(withMediaType: .video).first
      let dims = track?.naturalSize.applying(track?.preferredTransform ?? .identity)
      DispatchQueue.main.async {
        guard let self, self.loadGeneration == gen else { return }
        var parts: [String] = [queuePrefix]
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
    activeAsset?.cancelLoading()
    activeAsset = nil
    player?.pause()
    player?.replaceCurrentItem(with: nil)
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
  private let failureLabel = NSTextField(wrappingLabelWithString: "")
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

    failureLabel.alignment = .center
    failureLabel.font = .systemFont(ofSize: 12)
    failureLabel.textColor = palette.muted
    failureLabel.isHidden = true
    failureLabel.translatesAutoresizingMaskIntoConstraints = false

    addSubview(toolbar)
    addSubview(scrollView)
    addSubview(failureLabel)

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
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),

      failureLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      failureLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      failureLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.7)
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
    clearFailure()

    if let cached = context.cache.image(for: item.cacheKey) {
      presentImage(cached, item: item)
      return
    }
    if let thumb = item.clipboardItem?.decodedThumbnailImage() {
      presentImage(thumb, item: item)
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let image = NSImage(contentsOf: url)
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          if let image {
            context.cache.storeImage(image, for: item.cacheKey)
            self.presentImage(image, item: item)
          } else if let clip = item.clipboardItem {
            // Protected locations (another app's container) can deny a local
            // read; the server still has the bytes, so try that before failing.
            self.loadFromServer(item: item, clip: clip, context: context, gen: gen)
          } else {
            self.presentFailure("无法读取该文件，可能被系统隐私保护拦截。", item: item)
          }
        }
      }
      return
    }
    guard let clip = item.clipboardItem else {
      presentFailure("没有可预览的内容。", item: item)
      return
    }
    loadFromServer(item: item, clip: clip, context: context, gen: gen)
  }

  private func loadFromServer(item: LumenPreviewItem, clip: LumenClipboardItem, context: LumenPreviewContext, gen: Int) {
    let completion: (Result<(Data, String), Error>) -> Void = { [weak self] result in
      guard let self, self.loadGeneration == gen else { return }
      if case .success(let (data, _)) = result, let image = NSImage(data: data) {
        context.cache.storeImage(image, for: item.cacheKey)
        self.presentImage(image, item: item)
      } else {
        self.presentFailure("无法读取图片内容。", item: item)
      }
    }
    if clip.kind == "file" {
      context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0, completion: completion)
    } else {
      context.store.api.fetchItemContent(id: clip.id, completion: completion)
    }
  }

  private func presentFailure(_ message: String, item: LumenPreviewItem) {
    imageView.image = nil
    failureLabel.stringValue = message
    failureLabel.isHidden = false
    infoLabel.stringValue = "图片预览 · \(item.sizeLabel)"
  }

  private func clearFailure() {
    failureLabel.isHidden = true
  }

  private func presentImage(_ image: NSImage, item: LumenPreviewItem) {
    clearFailure()
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

// MARK: - 5B. Native Read-Only CSV Table Renderer (Q13, A30 — Max 250 Rows, Zero Execution)

struct LumenCSVDocument {
  let headers: [String]
  let rows: [[String]]
  let totalDataRowCount: Int
  let isTruncated: Bool
  let delimiter: Character

  var columnCount: Int {
    max(headers.count, rows.map(\.count).max() ?? 0)
  }
}

enum LumenCSVParser {
  static let maxDataRows = 250

  static func parse(_ rawText: String, maxDataRows: Int = LumenCSVParser.maxDataRows) -> LumenCSVDocument {
    var source = rawText
    if source.hasPrefix("\u{FEFF}") {
      source.removeFirst()
    }
    let delimiter = detectDelimiter(in: source)

    var allRows: [[String]] = []
    var currentRow: [String] = []
    var field = ""
    var inQuotes = false
    var totalRowsParsed = 0
    var truncated = false

    let chars = Array(source)
    var i = 0
    let n = chars.count

    while i < n {
      let ch = chars[i]
      if inQuotes {
        if ch == "\"" {
          if i + 1 < n && chars[i + 1] == "\"" {
            field.append("\"")
            i += 2
            continue
          }
          inQuotes = false
        } else {
          field.append(ch)
        }
      } else {
        if ch == "\"" && field.isEmpty {
          inQuotes = true
        } else if ch == delimiter {
          currentRow.append(field)
          field = ""
        } else if ch == "\r" || ch == "\n" {
          if ch == "\r" && i + 1 < n && chars[i + 1] == "\n" {
            i += 1
          }
          currentRow.append(field)
          field = ""
          if !(currentRow.count == 1 && currentRow[0].isEmpty && allRows.isEmpty) {
            totalRowsParsed += 1
            if allRows.count < maxDataRows + 1 {
              allRows.append(currentRow)
            } else {
              truncated = true
            }
          }
          currentRow = []
        } else {
          field.append(ch)
        }
      }
      i += 1
    }

    if !field.isEmpty || !currentRow.isEmpty {
      currentRow.append(field)
      totalRowsParsed += 1
      if allRows.count < maxDataRows + 1 {
        allRows.append(currentRow)
      } else {
        truncated = true
      }
    }

    // Trim trailing completely empty row if present
    while let last = allRows.last, last.allSatisfy({ $0.isEmpty }) {
      allRows.removeLast()
      totalRowsParsed = max(0, totalRowsParsed - 1)
    }

    guard let firstRow = allRows.first else {
      return LumenCSVDocument(headers: [], rows: [], totalDataRowCount: 0, isTruncated: false, delimiter: delimiter)
    }
    let dataRows = Array(allRows.dropFirst())
    let totalDataRows = max(dataRows.count, totalRowsParsed - 1)
    return LumenCSVDocument(
      headers: firstRow,
      rows: dataRows,
      totalDataRowCount: totalDataRows,
      isTruncated: truncated || totalDataRows > maxDataRows,
      delimiter: delimiter
    )
  }

  static func columnLetter(for index: Int) -> String {
    var n = index + 1
    var out = ""
    while n > 0 {
      let rem = (n - 1) % 26
      if let scalar = UnicodeScalar(65 + rem) {
        out = String(scalar) + out
      }
      n = (n - 1) / 26
    }
    return out
  }

  private static func detectDelimiter(in text: String) -> Character {
    let firstLine = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
    let tabCount = firstLine.filter { $0 == "\t" }.count
    let commaCount = firstLine.filter { $0 == "," }.count
    let semiCount = firstLine.filter { $0 == ";" }.count
    if tabCount > commaCount && tabCount > 0 { return "\t" }
    if semiCount > commaCount && commaCount == 0 && semiCount > 0 { return ";" }
    return ","
  }
}

/// Reusable read-only native `NSTableView` for CSV files and CSV members inside ZIP archives.
final class LumenCSVTableView: NSView, NSTableViewDataSource, NSTableViewDelegate {
  private let palette: LumenPalette
  private let scrollView = NSScrollView()
  private let tableView = NSTableView()
  private var doc = LumenCSVDocument(headers: [], rows: [], totalDataRowCount: 0, isTruncated: false, delimiter: ",")
  private var fontSize: CGFloat = 12

  var parsedDocument: LumenCSVDocument { doc }

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor

    tableView.backgroundColor = palette.windowBackground
    tableView.usesAlternatingRowBackgroundColors = true
    tableView.gridStyleMask = [.solidHorizontalGridLineMask, .solidVerticalGridLineMask]
    tableView.gridColor = palette.border
    tableView.rowHeight = 26
    tableView.columnAutoresizingStyle = .noColumnAutoresizing
    tableView.allowsColumnSelection = false
    tableView.allowsMultipleSelection = false
    tableView.dataSource = self
    tableView.delegate = self

    scrollView.documentView = tableView
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = true
    scrollView.backgroundColor = palette.windowBackground
    scrollView.borderType = .noBorder
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scrollView)

    NSLayoutConstraint.activate([
      scrollView.topAnchor.constraint(equalTo: topAnchor),
      scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
      scrollView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  required init?(coder: NSCoder) { nil }

  func loadCSV(text: String) {
    doc = LumenCSVParser.parse(text)
    rebuildColumns()
    tableView.reloadData()
  }

  func setFontSize(_ next: CGFloat) {
    fontSize = next
    tableView.rowHeight = max(24, round(next * 2.15))
    tableView.reloadData()
  }

  private func rebuildColumns() {
    for col in tableView.tableColumns {
      tableView.removeTableColumn(col)
    }

    // Column 0: fixed row number gutter (`#`)
    let rowCol = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("csv:row"))
    rowCol.title = "#"
    rowCol.width = 48
    rowCol.minWidth = 42
    rowCol.maxWidth = 72
    rowCol.headerCell.alignment = .right
    tableView.addTableColumn(rowCol)

    let colCount = min(64, max(1, doc.columnCount))
    for c in 0..<colCount {
      let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("csv:col:\(c)"))
      let colCode = LumenCSVParser.columnLetter(for: c)
      let headerText = c < doc.headers.count ? doc.headers[c].trimmingCharacters(in: .whitespacesAndNewlines) : ""
      col.title = headerText.isEmpty ? colCode : "\(colCode) · \(headerText)"
      let estimatedWidth = max(108, min(260, CGFloat(col.title.count) * 9.5 + 36))
      col.width = estimatedWidth
      col.minWidth = 72
      tableView.addTableColumn(col)
    }
  }

  func numberOfRows(in tableView: NSTableView) -> Int {
    doc.rows.count
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard let colID = tableColumn?.identifier.rawValue else { return nil }
    let cellID = NSUserInterfaceItemIdentifier("csvCell:\(colID == "csv:row" ? "row" : "data")")
    let label = (tableView.makeView(withIdentifier: cellID, owner: nil) as? NSTextField) ?? {
      let tf = NSTextField(labelWithString: "")
      tf.identifier = cellID
      tf.lineBreakMode = .byTruncatingTail
      tf.isSelectable = true
      return tf
    }()

    if colID == "csv:row" {
      label.font = .monospacedDigitSystemFont(ofSize: max(10.5, fontSize - 1), weight: .regular)
      label.textColor = palette.muted
      label.alignment = .right
      label.stringValue = "\(row + 1) "
      return label
    }

    guard let colIndex = Int(colID.replacingOccurrences(of: "csv:col:", with: "")),
          row < doc.rows.count else {
      label.stringValue = ""
      return label
    }

    let value = colIndex < doc.rows[row].count ? doc.rows[row][colIndex] : ""
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let isNumeric = !trimmed.isEmpty && Double(trimmed.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "%", with: "")) != nil
    label.font = .monospacedDigitSystemFont(ofSize: fontSize, weight: .regular)
    label.textColor = palette.ink
    label.alignment = isNumeric ? .right : .left
    label.stringValue = value.replacingOccurrences(of: "\n", with: " ↵ ")
    label.toolTip = value
    return label
  }
}

struct LumenCSVRenderer: LumenPreviewRenderer {
  let rendererID = "native.appkit.csv"
  let priority = 88
  func canRender(_ item: LumenPreviewItem) -> Bool { item.kind == .csv }
  func makeView(for item: LumenPreviewItem, context: LumenPreviewContext) -> LumenPreviewRendererView {
    LumenCSVRendererView(palette: context.palette)
  }
}

final class LumenCSVRendererView: LumenPreviewRendererView {
  private let palette: LumenPalette
  private let toolbar: NSView
  private let infoLabel: NSTextField
  private let tableView: LumenCSVTableView
  private var rawCSV = ""
  private var fontSize: CGFloat = 12
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette)
    infoLabel = makeStatusLabel("CSV 表格预览", palette: palette)
    tableView = LumenCSVTableView(palette: palette)
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    let smallerBtn = makePillButton(title: "A−", target: self, action: #selector(zoomOutClicked), palette: palette)
    let largerBtn = makePillButton(title: "A+", target: self, action: #selector(zoomInClicked), palette: palette)
    let copyBtn = makePillButton(title: "复制 CSV", target: self, action: #selector(copyCSVClicked), palette: palette)
    let rightStack = NSStackView(views: [smallerBtn, largerBtn, copyBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 6
    rightStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(infoLabel)
    toolbar.addSubview(rightStack)

    tableView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(toolbar)
    addSubview(tableView)

    NSLayoutConstraint.activate([
      toolbar.topAnchor.constraint(equalTo: topAnchor),
      toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
      toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
      infoLabel.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      infoLabel.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      rightStack.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -14),
      rightStack.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),

      tableView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
      tableView.leadingAnchor.constraint(equalTo: leadingAnchor),
      tableView.trailingAnchor.constraint(equalTo: trailingAnchor),
      tableView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    loadGeneration += 1
    let gen = loadGeneration

    if let cached = context.cache.text(for: item.cacheKey) {
      applyCSV(cached)
      return
    }
    if let url = item.localURL, FileManager.default.fileExists(atPath: url.path) {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let data = try? Data(contentsOf: url)
        let text = data.flatMap { String(data: $0.prefix(512_000), encoding: .utf8) } ?? ""
        DispatchQueue.main.async {
          guard let self, self.loadGeneration == gen else { return }
          context.cache.storeText(text, for: item.cacheKey)
          self.applyCSV(text)
        }
      }
      return
    }
    if let inline = item.inlineText {
      applyCSV(inline)
    }
    if let clip = item.clipboardItem {
      if clip.kind == "file" {
        context.store.api.fetchItemFileData(id: clip.id, index: item.fileIndex ?? 0) { [weak self] result in
          guard let self, self.loadGeneration == gen else { return }
          if case .success(let (data, _)) = result, let text = String(data: data.prefix(512_000), encoding: .utf8) {
            context.cache.storeText(text, for: item.cacheKey)
            self.applyCSV(text)
          }
        }
      } else {
        context.store.hydrateItemDetail(id: clip.id) { [weak self] detailed in
          guard let self, self.loadGeneration == gen, let full = detailed?.effectiveText else { return }
          context.cache.storeText(full, for: item.cacheKey)
          self.applyCSV(full)
        }
      }
    }
  }

  private func applyCSV(_ text: String) {
    rawCSV = text
    tableView.loadCSV(text: text)
    let doc = tableView.parsedDocument
    if doc.isTruncated {
      infoLabel.stringValue = "CSV 表格 · 显示前 \(doc.rows.count) 行（共 \(doc.totalDataRowCount) 行）· \(doc.columnCount) 列 · 只读"
    } else {
      infoLabel.stringValue = "CSV 表格 · \(doc.rows.count) 行 · \(doc.columnCount) 列 · 只读"
    }
  }

  @objc private func copyCSVClicked() {
    if !rawCSV.isEmpty {
      let pb = NSPasteboard.general
      pb.clearContents()
      pb.setString(rawCSV, forType: .string)
      currentContext?.onToast("已复制原始 CSV 文本")
    } else {
      copyPrimaryContent()
    }
  }

  @objc private func zoomInClicked() { zoomIn() }
  @objc private func zoomOutClicked() { zoomOut() }

  override func zoomIn() {
    fontSize = min(18, fontSize + 1.5)
    tableView.setFontSize(fontSize)
  }

  override func zoomOut() {
    fontSize = max(9.5, fontSize - 1.5)
    tableView.setFontSize(fontSize)
  }

  override func resetZoom() {
    fontSize = 12
    tableView.setFontSize(fontSize)
  }
}

// MARK: - 6. Native CoreGraphics Color Swatch Renderer (HEX / RGB / HSL One-Click Copy, Q05, A30)

private final class LumenCheckerboardSwatchView: NSView {
  var swatchColor: NSColor = .systemBlue { didSet { needsDisplay = true } }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.cornerRadius = 18
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    layer?.borderWidth = 1
    layer?.borderColor = NSColor.white.withAlphaComponent(0.28).cgColor
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let tile: CGFloat = 14
    let light = NSColor(white: 0.92, alpha: 1).cgColor
    let dark = NSColor(white: 0.78, alpha: 1).cgColor
    var y: CGFloat = 0
    var row = 0
    while y < bounds.height {
      var x: CGFloat = 0
      var col = 0
      while x < bounds.width {
        ctx.setFillColor(((row + col) % 2 == 0) ? light : dark)
        ctx.fill(CGRect(x: x, y: y, width: tile, height: tile))
        x += tile
        col += 1
      }
      y += tile
      row += 1
    }
    ctx.setFillColor(swatchColor.cgColor)
    ctx.fill(bounds)
  }
}

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
  private let swatchView = LumenCheckerboardSwatchView()
  private let overlayHexLabel = NSTextField(labelWithString: "")
  private let hexValueLabel = NSTextField(labelWithString: "")
  private let rgbValueLabel = NSTextField(labelWithString: "")
  private let hslValueLabel = NSTextField(labelWithString: "")
  private var hexString = ""
  private var rgbString = ""
  private var hslString = ""

  init(palette: LumenPalette) {
    self.palette = palette
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.windowBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    swatchView.translatesAutoresizingMaskIntoConstraints = false

    overlayHexLabel.font = .monospacedSystemFont(ofSize: 22, weight: .bold)
    overlayHexLabel.translatesAutoresizingMaskIntoConstraints = false
    swatchView.addSubview(overlayHexLabel)

    let hexRow = makeFormatRow(tag: "HEX", valueLabel: hexValueLabel, action: #selector(copyHexClicked))
    let rgbRow = makeFormatRow(tag: "RGB", valueLabel: rgbValueLabel, action: #selector(copyRGBClicked))
    let hslRow = makeFormatRow(tag: "HSL", valueLabel: hslValueLabel, action: #selector(copyHSLClicked))

    let formatsStack = NSStackView(views: [hexRow, rgbRow, hslRow])
    formatsStack.orientation = .vertical
    formatsStack.spacing = 8
    formatsStack.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView(views: [swatchView, formatsStack])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 20
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      swatchView.widthAnchor.constraint(equalToConstant: 416),
      swatchView.heightAnchor.constraint(equalToConstant: 212),
      overlayHexLabel.leadingAnchor.constraint(equalTo: swatchView.leadingAnchor, constant: 18),
      overlayHexLabel.bottomAnchor.constraint(equalTo: swatchView.bottomAnchor, constant: -16),

      formatsStack.widthAnchor.constraint(equalToConstant: 416),
      hexRow.widthAnchor.constraint(equalTo: formatsStack.widthAnchor),
      rgbRow.widthAnchor.constraint(equalTo: formatsStack.widthAnchor),
      hslRow.widthAnchor.constraint(equalTo: formatsStack.widthAnchor),

      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  private func makeFormatRow(tag: String, valueLabel: NSTextField, action: Selector) -> NSView {
    let row = NSView()
    row.wantsLayer = true
    row.layer?.cornerRadius = 10
    row.layer?.cornerCurve = .continuous
    row.layer?.backgroundColor = palette.surface.cgColor
    row.layer?.borderWidth = 1
    row.layer?.borderColor = palette.border.cgColor
    row.translatesAutoresizingMaskIntoConstraints = false

    let tagLbl = NSTextField(labelWithString: tag)
    tagLbl.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
    tagLbl.textColor = palette.muted
    tagLbl.translatesAutoresizingMaskIntoConstraints = false

    valueLabel.font = .monospacedSystemFont(ofSize: 13.5, weight: .medium)
    valueLabel.textColor = palette.ink
    valueLabel.isSelectable = true
    valueLabel.lineBreakMode = .byTruncatingTail
    valueLabel.translatesAutoresizingMaskIntoConstraints = false

    let copyBtn = makePillButton(title: "复制 \(tag)", target: self, action: action, palette: palette)
    row.addSubview(tagLbl)
    row.addSubview(valueLabel)
    row.addSubview(copyBtn)

    NSLayoutConstraint.activate([
      row.heightAnchor.constraint(equalToConstant: 42),
      tagLbl.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 14),
      tagLbl.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      tagLbl.widthAnchor.constraint(equalToConstant: 36),

      valueLabel.leadingAnchor.constraint(equalTo: tagLbl.trailingAnchor, constant: 8),
      valueLabel.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      valueLabel.trailingAnchor.constraint(lessThanOrEqualTo: copyBtn.leadingAnchor, constant: -10),

      copyBtn.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -10),
      copyBtn.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      copyBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 74)
    ])
    return row
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    let raw = (item.inlineText ?? item.title).trimmingCharacters(in: .whitespacesAndNewlines)
    let color = LumenColorMath.parseAnyColor(raw) ?? palette.accent
    let srgb = color.usingColorSpace(.sRGB) ?? color
    swatchView.swatchColor = srgb

    hexString = LumenColorMath.hexString(from: srgb)
    rgbString = LumenColorMath.rgbString(from: srgb)
    hslString = LumenColorMath.hslString(from: srgb)

    // Choose legible foreground color over swatch based on relative luminance
    let luma = 0.2126 * srgb.redComponent + 0.7152 * srgb.greenComponent + 0.0722 * srgb.blueComponent
    overlayHexLabel.textColor = (luma > 0.62 && srgb.alphaComponent > 0.5)
      ? NSColor(srgbRed: 0.11, green: 0.15, blue: 0.22, alpha: 0.92)
      : NSColor.white.withAlphaComponent(0.95)
    overlayHexLabel.stringValue = hexString

    hexValueLabel.stringValue = hexString
    rgbValueLabel.stringValue = rgbString
    hslValueLabel.stringValue = hslString
  }

  private func copyFormatValue(_ value: String, label: String, sender: NSButton) {
    guard !value.isEmpty else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(value, forType: .string)
    currentContext?.onToast("已复制 \(label)：\(value)")
    let prevTitle = sender.title
    sender.title = "已复制"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak sender] in
      sender?.title = prevTitle
    }
  }

  @objc private func copyHexClicked(_ sender: NSButton) { copyFormatValue(hexString, label: "HEX", sender: sender) }
  @objc private func copyRGBClicked(_ sender: NSButton) { copyFormatValue(rgbString, label: "RGB", sender: sender) }
  @objc private func copyHSLClicked(_ sender: NSButton) { copyFormatValue(hslString, label: "HSL", sender: sender) }
}

// MARK: - 7. Native Syntax-Highlighted Code Renderer (Q04, A29, A59)

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
  private let langGlyph = LumenIdentityGlyphView(size: 16)
  private let infoLabel: NSTextField
  private let wrapBtn: NSButton
  private let scrollView = NSScrollView()
  private let textView = NSTextView()
  private var codeContent = ""
  private var language = "unknown"
  private var fontSize: CGFloat = 13
  private var wrapLines = false
  private var loadGeneration = 0

  init(palette: LumenPalette) {
    self.palette = palette
    toolbar = makeRendererToolbar(palette: palette, darkOverride: true)
    infoLabel = makeStatusLabel("未知语言", palette: palette, dark: true)
    wrapBtn = NSButton()
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = palette.codeBackground.cgColor
    setupUI()
  }

  required init?(coder: NSCoder) { nil }

  private func setupUI() {
    langGlyph.translatesAutoresizingMaskIntoConstraints = false

    wrapBtn.title = "自动换行"
    wrapBtn.target = self
    wrapBtn.action = #selector(toggleWrapClicked)
    wrapBtn.isBordered = false
    wrapBtn.wantsLayer = true
    wrapBtn.font = .systemFont(ofSize: 11.5, weight: .medium)
    wrapBtn.contentTintColor = palette.codeBaseText
    wrapBtn.layer?.cornerRadius = 7
    wrapBtn.layer?.cornerCurve = .continuous
    wrapBtn.layer?.borderWidth = 1
    wrapBtn.layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor
    wrapBtn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.08).cgColor
    wrapBtn.translatesAutoresizingMaskIntoConstraints = false
    wrapBtn.heightAnchor.constraint(equalToConstant: 26).isActive = true
    wrapBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 66).isActive = true

    let copyBtn = makePillButton(title: "复制代码", target: self, action: #selector(copyCodeClicked), palette: palette, dark: true)
    let smallerBtn = makePillButton(title: "A−", target: self, action: #selector(zoomOutClicked), palette: palette, dark: true)
    let largerBtn = makePillButton(title: "A+", target: self, action: #selector(zoomInClicked), palette: palette, dark: true)

    let rightStack = NSStackView(views: [wrapBtn, smallerBtn, largerBtn, copyBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 6
    rightStack.translatesAutoresizingMaskIntoConstraints = false

    toolbar.addSubview(langGlyph)
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
      langGlyph.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 14),
      langGlyph.centerYAnchor.constraint(equalTo: toolbar.centerYAnchor),
      langGlyph.widthAnchor.constraint(equalToConstant: 16),
      langGlyph.heightAnchor.constraint(equalToConstant: 16),
      infoLabel.leadingAnchor.constraint(equalTo: langGlyph.trailingAnchor, constant: 8),
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
      language = LumenContentIdentityRegistry.shared.normalizeLanguageID(lang)
    } else {
      language = "unknown"
    }
    langGlyph.configure(identity: item.identity, isDark: true, size: 16)

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
    let normLang = LumenContentIdentityRegistry.shared.normalizeLanguageID(language)
    let langTitle = normLang == "unknown" ? "未知语言" : LumenContentIdentityRegistry.shared.languageDisplayName(normLang)
    let styleNote = normLang == "unknown" ? "中性样式" : "语法高亮"
    infoLabel.stringValue = "\(langTitle) · \(lines.count) 行 · \(source.count) 字符 · \(styleNote)"

    let gutterWidth = max(3, String(lines.count).count)
    let numbered = NSMutableAttributedString()
    let gutterFont = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    let gutterAttrs: [NSAttributedString.Key: Any] = [
      .font: gutterFont,
      .foregroundColor: palette.codeGutterText,
      .ligature: 0
    ]
    let highlightedFull = LumenSyntaxHighlighter.highlight(source, language: normLang, fontSize: fontSize, darkCanvas: true)
    let nsSource = source as NSString
    var cursor = 0
    for (idx, line) in lines.enumerated() {
      let prefix = String(format: "%\(gutterWidth)d   ", idx + 1)
      numbered.append(NSAttributedString(string: prefix, attributes: gutterAttrs))
      let len = (line as NSString).length
      if cursor + len <= highlightedFull.length {
        numbered.append(highlightedFull.attributedSubstring(from: NSRange(location: cursor, length: len)))
      } else {
        numbered.append(NSAttributedString(string: line, attributes: [.font: gutterFont, .foregroundColor: palette.codeBaseText, .ligature: 0]))
      }
      if idx < lines.count - 1 {
        numbered.append(NSAttributedString(string: "\n", attributes: gutterAttrs))
      }
      cursor += len + 1
      if cursor > nsSource.length { break }
    }
    textView.textStorage?.setAttributedString(numbered)
  }

  @objc private func toggleWrapClicked() {
    wrapLines.toggle()
    wrapBtn.title = wrapLines ? "取消换行" : "自动换行"
    scrollView.hasHorizontalScroller = !wrapLines
    textView.isHorizontallyResizable = !wrapLines
    textView.textContainer?.widthTracksTextView = wrapLines
    if wrapLines {
      let width = max(200, scrollView.contentSize.width - 36)
      textView.frame.size.width = scrollView.contentSize.width
      textView.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
    } else {
      textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    }
    applyCode(codeContent)
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

    let heading = NSTextField(labelWithString: "\(item.identity.displayName) · \(item.collectionChildren.count) 项")
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

      let glyph = LumenIdentityGlyphView(size: 22)
      glyph.configure(identity: child.identity, isDark: palette.isDark, size: 22)
      glyph.translatesAutoresizingMaskIntoConstraints = false
      let name = NSTextField(labelWithString: child.title)
      name.font = .systemFont(ofSize: 13, weight: .medium)
      name.textColor = palette.ink
      name.lineBreakMode = .byTruncatingMiddle
      name.translatesAutoresizingMaskIntoConstraints = false
      let meta = NSTextField(labelWithString: "\(child.identity.displayName) · \(child.sizeLabel)")
      meta.font = .systemFont(ofSize: 11)
      meta.textColor = palette.muted
      meta.translatesAutoresizingMaskIntoConstraints = false

      row.addSubview(glyph)
      row.addSubview(name)
      row.addSubview(meta)

      NSLayoutConstraint.activate([
        row.heightAnchor.constraint(equalToConstant: 48),
        glyph.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
        glyph.centerYAnchor.constraint(equalTo: row.centerYAnchor),
        glyph.widthAnchor.constraint(equalToConstant: 24),
        glyph.heightAnchor.constraint(equalToConstant: 24),
        name.leadingAnchor.constraint(equalTo: glyph.trailingAnchor, constant: 10),
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

// MARK: - 9. Native Text & Link Renderer (Q05, A30 — Line/Char Stats & Preserved Line Breaks)

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
  private var rawContent = ""
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
    openLinkBtn.title = "在浏览器打开"
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
    openLinkBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 86).isActive = true
    openLinkBtn.isHidden = true

    let smallerBtn = makePillButton(title: "A−", target: self, action: #selector(zoomOutClicked), palette: palette)
    let largerBtn = makePillButton(title: "A+", target: self, action: #selector(zoomInClicked), palette: palette)
    let copyBtn = makePillButton(title: "复制内容", target: self, action: #selector(copyClicked), palette: palette)
    let rightStack = NSStackView(views: [openLinkBtn, smallerBtn, largerBtn, copyBtn])
    rightStack.orientation = .horizontal
    rightStack.spacing = 6
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
    rawContent = content
    // Preserve exact line breaks cleanly for display without mutating original content
    let displayString = content.replacingOccurrences(of: "\r\n", with: "\n")
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineHeightMultiple = 1.55
    textView.textStorage?.setAttributedString(NSAttributedString(
      string: displayString,
      attributes: [
        .font: NSFont.systemFont(ofSize: fontSize),
        .foregroundColor: palette.ink,
        .paragraphStyle: paragraph
      ]
    ))
    let lines = max(1, displayString.components(separatedBy: "\n").count)
    let nonSpaceChars = content.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.count
    let eolTag = content.contains("\r\n") ? "CRLF" : (content.contains("\n") ? "LF" : "单行")
    infoLabel.stringValue = "\(isLink ? "链接" : "文本") · \(lines) 行 · \(content.count) 字符（非空 \(nonSpaceChars)）· \(eolTag) · \(LumenFormatters.byteCount(Int64(content.utf8.count)))"
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
  @objc private func zoomInClicked() { zoomIn() }
  @objc private func zoomOutClicked() { zoomOut() }

  override func zoomIn() {
    fontSize = min(26, fontSize + 2)
    applyText(rawContent, isLink: activeURL != nil)
  }

  override func zoomOut() {
    fontSize = max(11, fontSize - 2)
    applyText(rawContent, isLink: activeURL != nil)
  }

  override func resetZoom() {
    fontSize = 15
    applyText(rawContent, isLink: activeURL != nil)
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
  private let glyphView = LumenIdentityGlyphView(size: 56)
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
    glyphView.translatesAutoresizingMaskIntoConstraints = false

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

    let stack = NSStackView(views: [glyphView, nameLabel, metaLabel, actions])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.setCustomSpacing(18, after: metaLabel)
    stack.translatesAutoresizingMaskIntoConstraints = false

    addSubview(stack)
    NSLayoutConstraint.activate([
      glyphView.widthAnchor.constraint(equalToConstant: 56),
      glyphView.heightAnchor.constraint(equalToConstant: 56),
      nameLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
      metaLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor)
    ])
  }

  override func load(item: LumenPreviewItem, context: LumenPreviewContext) {
    super.load(item: item, context: context)
    glyphView.configure(identity: item.identity, isDark: palette.isDark, size: 56)
    if let url = item.localURL {
      metaLabel.stringValue = "\(item.identity.displayName) · \(item.sizeLabel)\n\(url.path)\n尚无此格式的内置渲染器，可调用系统默认应用打开。"
    } else {
      metaLabel.stringValue = "\(item.identity.displayName) · \(item.sizeLabel)\n尚无此格式的内置渲染器。"
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

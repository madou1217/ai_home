"""Native Audio (priority 95) and Video (priority 94) preview renderers.

Uses GTK4's native GStreamer-backed `Gtk.MediaFile` / `Gtk.Video` (and optional
`Gst` GI `playbin3` / appsink PCM peak decode when installed), plus a pure GSK
interactive 66-bar clickable/draggable waveform widget.
"""

from __future__ import annotations

import math
import os
import struct
import threading
import wave
from pathlib import Path
from typing import Any, Callable, Optional

from gi.repository import Graphene, Gsk

from ..capabilities import Gio, GLib, Gst, Gtk
from ..models import Formatters
from ..preview_registry import PreviewContext, PreviewItem, PreviewRendererView
from ..theme import AlbumCoverWidget, LumenPalette, rgba_hex
from .helpers import make_renderer_toolbar


def _default_waveform_peaks() -> list[float]:
    return [0.24 + abs(math.sin(i * 1.73) * math.cos(i * 0.21)) * 0.72 for i in range(66)]


def _decode_wav_peaks(path: str, bar_count: int = 66) -> Optional[list[float]]:
    """Decodes real RMS peaks for uncompressed WAV files using Python stdlib."""
    try:
        with wave.open(path, "rb") as wf:
            n_frames = wf.getnframes()
            sampwidth = wf.getsampwidth()
            n_channels = wf.getnchannels()
            if n_frames <= 0 or sampwidth not in (1, 2, 4) or n_channels <= 0:
                return None
            peaks: list[float] = []
            max_frames_per_bar = max(64, min(4096, n_frames // bar_count))
            for i in range(bar_count):
                pos = int(i * n_frames / bar_count)
                wf.setpos(min(pos, max(0, n_frames - 1)))
                raw = wf.readframes(max_frames_per_bar)
                if not raw:
                    peaks.append(0.15)
                    continue
                if sampwidth == 2:
                    count = len(raw) // 2
                    samples = struct.unpack(f"<{count}h", raw[: count * 2])
                    step = max(1, count // 128)
                    acc = sum((samples[j] / 32768.0) ** 2 for j in range(0, count, step))
                    rms = math.sqrt(acc / max(1, (count + step - 1) // step))
                elif sampwidth == 1:
                    step = max(1, len(raw) // 128)
                    acc = sum(((raw[j] - 128) / 128.0) ** 2 for j in range(0, len(raw), step))
                    rms = math.sqrt(acc / max(1, (len(raw) + step - 1) // step))
                else:
                    count = len(raw) // 4
                    samples = struct.unpack(f"<{count}i", raw[: count * 4])
                    step = max(1, count // 128)
                    acc = sum((samples[j] / 2147483648.0) ** 2 for j in range(0, count, step))
                    rms = math.sqrt(acc / max(1, (count + step - 1) // step))
                peaks.append(rms)
            peak_max = max(0.001, max(peaks))
            return [max(0.12, min(1.0, (p / peak_max) ** 0.72)) for p in peaks]
    except Exception:
        return None


def _decode_gst_peaks(path: str, bar_count: int = 66) -> Optional[list[float]]:
    """Decodes PCM peaks via GStreamer GI appsink when Gst 1.0 is available."""
    if Gst is None:
        return None
    try:
        uri = Gio.File.new_for_path(os.path.abspath(path)).get_uri()
        pipeline_desc = (
            f'uridecodebin uri="{uri}" ! audioconvert ! audioresample '
            f"! audio/x-raw,format=S16LE,channels=1,rate=8000 ! appsink name=sink sync=false max-buffers=4"
        )
        pipeline = Gst.parse_launch(pipeline_desc)
        sink = pipeline.get_by_name("sink")
        if sink is None:
            return None
        pipeline.set_state(Gst.State.PLAYING)
        energies: list[float] = []
        max_chunks = 600
        for _ in range(max_chunks):
            sample = sink.emit("try-pull-sample", 200 * Gst.MSECOND)
            if sample is None:
                break
            buf = sample.get_buffer()
            ok, mapinfo = buf.map(Gst.MapFlags.READ)
            if ok:
                raw = bytes(mapinfo.data)
                buf.unmap(mapinfo)
                count = len(raw) // 2
                if count > 0:
                    samples = struct.unpack(f"<{count}h", raw[: count * 2])
                    step = max(1, count // 64)
                    acc = sum((samples[j] / 32768.0) ** 2 for j in range(0, count, step))
                    energies.append(math.sqrt(acc / max(1, (count + step - 1) // step)))
        pipeline.set_state(Gst.State.NULL)
        if not energies:
            return None
        peaks: list[float] = []
        for i in range(bar_count):
            idx = min(len(energies) - 1, int(i * len(energies) / bar_count))
            peaks.append(energies[idx])
        peak_max = max(0.001, max(peaks))
        return [max(0.12, min(1.0, (p / peak_max) ** 0.72)) for p in peaks]
    except Exception:
        return None


class WaveformWidget(Gtk.Widget):
    """Interactive 66-bar GSK waveform supporting click & drag seek."""

    def __init__(self, palette: LumenPalette, on_seek: Callable[[float], None]) -> None:
        super().__init__()
        self._peaks: list[float] = _default_waveform_peaks()
        self._progress: float = 0.0
        self._played = rgba_hex(palette.accent, 1.0)
        self._unplayed = rgba_hex(palette.muted, 0.36)
        self._on_seek = on_seek
        self.set_size_request(440, 48)
        self.set_halign(Gtk.Align.CENTER)

        click = Gtk.GestureClick.new()
        click.connect("pressed", self._on_pressed)
        self.add_controller(click)

        drag = Gtk.GestureDrag.new()
        drag.connect("drag-update", self._on_drag_update)
        self.add_controller(drag)
        self._drag_start_x = 0.0
        drag.connect("drag-begin", self._on_drag_begin)

    def apply_palette(self, palette: LumenPalette) -> None:
        self._played = rgba_hex(palette.accent, 1.0)
        self._unplayed = rgba_hex(palette.muted, 0.36)
        self.queue_draw()

    def set_peaks(self, peaks: list[float]) -> None:
        if peaks:
            self._peaks = peaks
            self.queue_draw()

    def set_progress(self, frac: float) -> None:
        self._progress = max(0.0, min(1.0, float(frac)))
        self.queue_draw()

    def _seek_at_x(self, x: float) -> None:
        w = max(1.0, float(self.get_width()))
        frac = max(0.0, min(1.0, x / w))
        self._on_seek(frac)

    def _on_pressed(self, _gesture: Gtk.GestureClick, _n: int, x: float, _y: float) -> None:
        self._seek_at_x(x)

    def _on_drag_begin(self, _gesture: Gtk.GestureDrag, x: float, _y: float) -> None:
        self._drag_start_x = x
        self._seek_at_x(x)

    def _on_drag_update(self, _gesture: Gtk.GestureDrag, offset_x: float, _offset_y: float) -> None:
        self._seek_at_x(self._drag_start_x + offset_x)

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1.0, float(self.get_width()))
        h = max(1.0, float(self.get_height()))
        count = len(self._peaks)
        if count <= 0:
            return
        gap = 3.0
        total_gap = gap * (count - 1)
        bar_w = max(2.0, min(5.5, (w - total_gap) / count))
        content_w = bar_w * count + total_gap
        start_x = (w - content_w) / 2.0
        max_h = max(8.0, h - 6.0)

        for i, raw_peak in enumerate(self._peaks):
            norm = max(0.12, min(1.0, raw_peak))
            bh = max_h * norm
            bx = start_x + i * (bar_w + gap)
            by = (h - bh) / 2.0
            rect = Graphene.Rect().init(bx, by, bar_w, bh)
            rrect = Gsk.RoundedRect()
            rrect.init_from_rect(rect, bar_w / 2.0)
            frac = i / max(1, count - 1)
            snapshot.push_rounded_clip(rrect)
            snapshot.append_color(self._played if frac <= self._progress else self._unplayed, rect)
            snapshot.pop()


class AudioRendererView(PreviewRendererView):
    def __init__(self, palette: LumenPalette) -> None:
        super().__init__()
        self._palette = palette
        self._media_file: Optional[Gtk.MediaFile] = None
        self._gst_player: Optional[Any] = None
        self._poll_id: int = 0
        self._duration_sec: float = 0.0
        self._repeat: bool = False
        self._updating_slider: bool = False

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        outer.set_halign(Gtk.Align.CENTER)
        outer.set_valign(Gtk.Align.CENTER)
        outer.set_hexpand(True)
        outer.set_vexpand(True)
        outer.set_margin_top(20)
        outer.set_margin_bottom(20)
        outer.set_margin_start(24)
        outer.set_margin_end(24)

        self._cover = AlbumCoverWidget(seed_index=0, badge_text="LUMEN / 01", size=180)
        self._cover.set_halign(Gtk.Align.CENTER)

        self._title_lbl = Gtk.Label(label="")
        self._title_lbl.add_css_class("lumen-heading")
        self._title_lbl.set_ellipsize(3)
        self._title_lbl.set_max_width_chars(46)

        self._sub_lbl = Gtk.Label(label="")
        self._sub_lbl.add_css_class("lumen-subheading")

        self._waveform = WaveformWidget(palette, self._seek_fraction)

        progress_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        progress_row.set_size_request(440, -1)
        progress_row.set_halign(Gtk.Align.CENTER)
        self._now_lbl = Gtk.Label(label="0:00")
        self._now_lbl.add_css_class("lumen-muted")
        self._seek_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.0, 1000.0, 1.0)
        self._seek_scale.set_draw_value(False)
        self._seek_scale.set_hexpand(True)
        self._seek_scale.connect("value-changed", self._on_seek_slider)
        self._dur_lbl = Gtk.Label(label="0:00")
        self._dur_lbl.add_css_class("lumen-muted")
        progress_row.append(self._now_lbl)
        progress_row.append(self._seek_scale)
        progress_row.append(self._dur_lbl)

        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        controls.set_halign(Gtk.Align.CENTER)

        self._repeat_btn = Gtk.Button.new_from_icon_name("media-playlist-repeat-symbolic")
        self._repeat_btn.add_css_class("lumen-icon-btn")
        self._repeat_btn.set_tooltip_text("单曲循环")
        self._repeat_btn.connect("clicked", self._on_toggle_repeat)

        prev_btn = Gtk.Button.new_from_icon_name("media-skip-backward-symbolic")
        prev_btn.add_css_class("lumen-icon-btn")
        prev_btn.set_tooltip_text("上一首")
        prev_btn.connect("clicked", lambda _b: self._step_queue(-1))

        self._play_btn = Gtk.Button.new_from_icon_name("media-playback-start-symbolic")
        self._play_btn.add_css_class("lumen-primary-btn")
        self._play_btn.set_size_request(48, 48)
        self._play_btn.set_tooltip_text("播放 / 暂停 (Space)")
        self._play_btn.connect("clicked", lambda _b: self.toggle_play_pause())

        next_btn = Gtk.Button.new_from_icon_name("media-skip-forward-symbolic")
        next_btn.add_css_class("lumen-icon-btn")
        next_btn.set_tooltip_text("下一首")
        next_btn.connect("clicked", lambda _b: self._step_queue(1))

        for b in (self._repeat_btn, prev_btn, self._play_btn, next_btn):
            controls.append(b)

        vol_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        vol_row.set_halign(Gtk.Align.CENTER)
        vol_icon = Gtk.Image.new_from_icon_name("audio-volume-high-symbolic")
        self._vol_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.0, 1.0, 0.02)
        self._vol_scale.set_draw_value(False)
        self._vol_scale.set_value(0.75)
        self._vol_scale.set_size_request(120, -1)
        self._vol_scale.connect("value-changed", self._on_volume_changed)
        vol_row.append(vol_icon)
        vol_row.append(self._vol_scale)

        self._status_lbl = Gtk.Label(label="")
        self._status_lbl.add_css_class("lumen-subheading")

        for child in (
            self._cover,
            self._title_lbl,
            self._sub_lbl,
            self._waveform,
            progress_row,
            controls,
            vol_row,
            self._status_lbl,
        ):
            outer.append(child)
        self.append(outer)

    def apply_theme(self, palette: LumenPalette) -> None:
        self._palette = palette
        self._waveform.apply_palette(palette)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        self.teardown()
        super().load(item, context)
        gen = self.next_generation()

        self._cover.configure(item.seed_index, f"LUMEN / {(item.seed_index % 99) + 1:02d}")
        self._title_lbl.set_text(Path(item.title).stem or item.title)
        self._sub_lbl.set_text(f"{item.subtitle} · {item.size_label}")
        self._status_lbl.set_text("")
        self._now_lbl.set_text("0:00")
        self._dur_lbl.set_text("0:00")
        self._duration_sec = 0.0
        self._waveform.set_progress(0.0)
        self._set_slider_silent(0.0)
        self._play_btn.set_icon_name("media-playback-start-symbolic")

        if item.local_path and os.path.isfile(item.local_path):
            self._attach_media_file(item.local_path, item.cache_key, context, gen)
            return

        if item.clipboard_item is None:
            self._status_lbl.set_text("音频文件不可用")
            return

        self._status_lbl.set_text("正在加载音频流…")
        suffix = Path(item.title).suffix or ".mp3"

        def _ok(temp_path: str) -> None:
            if not self.is_current_generation(gen):
                return
            self._status_lbl.set_text("")
            self._attach_media_file(temp_path, item.cache_key, context, gen)

        def _err(exc: Exception) -> None:
            if not self.is_current_generation(gen):
                return
            self._status_lbl.set_text(f"音频加载失败：{exc}")

        context.store.api.download_item_file_to_temp(
            item.clipboard_item.id,
            index=item.file_index or 0,
            suffix=suffix,
            on_success=_ok,
            on_error=_err,
        )

    def _attach_media_file(self, path: str, cache_key: str, context: PreviewContext, gen: int) -> None:
        self._decode_waveform_async(path, cache_key, context, gen)
        if hasattr(Gtk, "MediaFile"):
            try:
                mf = Gtk.MediaFile.new_for_filename(path)
                mf.set_volume(self._vol_scale.get_value())
                mf.set_loop(self._repeat)
                mf.connect("notify::playing", self._on_playing_notify)
                mf.connect("notify::ended", self._on_ended_notify)
                mf.connect("notify::duration", self._on_duration_notify)
                self._media_file = mf
                self._poll_id = GLib.timeout_add(90, self._poll_progress)
                return
            except Exception as exc:
                self._status_lbl.set_text(f"音频后端不可用：{exc}")
        if Gst is not None:
            try:
                player = Gst.ElementFactory.make("playbin3", "lumen-audio") or Gst.ElementFactory.make("playbin", "lumen-audio")
                if player is not None:
                    player.set_property("uri", Gio.File.new_for_path(os.path.abspath(path)).get_uri())
                    player.set_property("volume", self._vol_scale.get_value())
                    self._gst_player = player
                    self._poll_id = GLib.timeout_add(90, self._poll_progress)
                    return
            except Exception as exc:
                self._status_lbl.set_text(f"GStreamer 不可用：{exc}")

    def _decode_waveform_async(self, path: str, cache_key: str, context: PreviewContext, gen: int) -> None:
        cached = context.cache.waveform(cache_key)
        if cached is not None:
            self._waveform.set_peaks(cached)
            return

        def _worker() -> None:
            peaks = _decode_wav_peaks(path) if path.lower().endswith(".wav") else None
            if peaks is None:
                peaks = _decode_gst_peaks(path)
            if peaks is not None:
                GLib.idle_add(self._apply_waveform_peaks, peaks, cache_key, context, gen)

        threading.Thread(target=_worker, name="lumen-waveform", daemon=True).start()

    def _apply_waveform_peaks(self, peaks: list[float], cache_key: str, context: PreviewContext, gen: int) -> bool:
        if not self.is_current_generation(gen):
            return False
        context.cache.store_waveform(cache_key, peaks)
        self._waveform.set_peaks(peaks)
        return False

    def _set_slider_silent(self, val: float) -> None:
        self._updating_slider = True
        self._seek_scale.set_value(val)
        self._updating_slider = False

    def _on_duration_notify(self, mf: Gtk.MediaFile, _pspec: Any) -> None:
        dur_us = mf.get_duration()
        if dur_us > 0:
            self._duration_sec = dur_us / 1_000_000.0
            self._dur_lbl.set_text(Formatters.media_duration(self._duration_sec))

    def _on_playing_notify(self, mf: Gtk.MediaFile, _pspec: Any) -> None:
        playing = mf.get_playing()
        self._play_btn.set_icon_name(
            "media-playback-pause-symbolic" if playing else "media-playback-start-symbolic"
        )

    def _on_ended_notify(self, mf: Gtk.MediaFile, _pspec: Any) -> None:
        if mf.get_ended() and not self._repeat:
            self._play_btn.set_icon_name("media-playback-start-symbolic")
            self._step_queue(1)

    def _poll_progress(self) -> bool:
        if self._media_file is not None:
            dur_us = self._media_file.get_duration()
            if dur_us > 0:
                self._duration_sec = dur_us / 1_000_000.0
                self._dur_lbl.set_text(Formatters.media_duration(self._duration_sec))
            cur_sec = max(0.0, self._media_file.get_timestamp() / 1_000_000.0)
            self._now_lbl.set_text(Formatters.media_duration(cur_sec))
            if self._duration_sec > 0:
                frac = max(0.0, min(1.0, cur_sec / self._duration_sec))
                self._waveform.set_progress(frac)
                self._set_slider_silent(frac * 1000.0)
            return True
        if self._gst_player is not None and Gst is not None:
            ok_d, dur_ns = self._gst_player.query_duration(Gst.Format.TIME)
            if ok_d and dur_ns > 0:
                self._duration_sec = dur_ns / Gst.SECOND
                self._dur_lbl.set_text(Formatters.media_duration(self._duration_sec))
            ok_p, pos_ns = self._gst_player.query_position(Gst.Format.TIME)
            if ok_p and pos_ns >= 0:
                cur_sec = pos_ns / Gst.SECOND
                self._now_lbl.set_text(Formatters.media_duration(cur_sec))
                if self._duration_sec > 0:
                    frac = max(0.0, min(1.0, cur_sec / self._duration_sec))
                    self._waveform.set_progress(frac)
                    self._set_slider_silent(frac * 1000.0)
            return True
        self._poll_id = 0
        return False

    def _seek_fraction(self, frac: float) -> None:
        clamped = max(0.0, min(1.0, frac))
        if self._duration_sec <= 0:
            return
        if self._media_file is not None:
            self._media_file.seek(int(clamped * self._duration_sec * 1_000_000))
        elif self._gst_player is not None and Gst is not None:
            self._gst_player.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                int(clamped * self._duration_sec * Gst.SECOND),
            )
        self._waveform.set_progress(clamped)
        self._set_slider_silent(clamped * 1000.0)

    def _on_seek_slider(self, scale: Gtk.Scale) -> None:
        if not self._updating_slider:
            self._seek_fraction(scale.get_value() / 1000.0)

    def _on_volume_changed(self, scale: Gtk.Scale) -> None:
        vol = scale.get_value()
        if self._media_file is not None:
            self._media_file.set_volume(vol)
        elif self._gst_player is not None:
            self._gst_player.set_property("volume", vol)

    def _on_toggle_repeat(self, _btn: Gtk.Button) -> None:
        self._repeat = not self._repeat
        if self._repeat:
            self._repeat_btn.add_css_class("lumen-active")
        else:
            self._repeat_btn.remove_css_class("lumen-active")
        if self._media_file is not None:
            self._media_file.set_loop(self._repeat)

    def _step_queue(self, delta: int) -> None:
        if self.current_context is not None:
            self.current_context.on_step_queue(delta, True)

    def toggle_play_pause(self) -> bool:
        if self._media_file is not None:
            if self._media_file.get_playing():
                self._media_file.pause()
            else:
                if self._media_file.get_ended():
                    self._media_file.seek(0)
                self._media_file.play()
            return True
        if self._gst_player is not None and Gst is not None:
            _, state, _ = self._gst_player.get_state(0)
            if state == Gst.State.PLAYING:
                self._gst_player.set_state(Gst.State.PAUSED)
                self._play_btn.set_icon_name("media-playback-start-symbolic")
            else:
                self._gst_player.set_state(Gst.State.PLAYING)
                self._play_btn.set_icon_name("media-playback-pause-symbolic")
            return True
        return False

    def teardown(self) -> None:
        super().teardown()
        if self._poll_id:
            GLib.source_remove(self._poll_id)
            self._poll_id = 0
        if self._media_file is not None:
            try:
                self._media_file.pause()
                self._media_file.clear()
            except Exception:
                pass
            self._media_file = None
        if self._gst_player is not None and Gst is not None:
            try:
                self._gst_player.set_state(Gst.State.NULL)
            except Exception:
                pass
            self._gst_player = None


class AudioRenderer:
    renderer_id = "native.gtk4.gstreamer.audio"
    priority = 95

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "audio"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return AudioRendererView(context.palette)


class VideoRendererView(PreviewRendererView):
    def __init__(self) -> None:
        super().__init__()
        self._media_file: Optional[Gtk.MediaFile] = None

        toolbar, self._info_label, right_box = make_renderer_toolbar()
        self._info_label.set_text("视频预览")
        badge = Gtk.Label(label="GtkVideo / GStreamer 原生控件")
        badge.add_css_class("lumen-muted")
        right_box.append(badge)
        self.append(toolbar)

        self._stage = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self._stage.set_hexpand(True)
        self._stage.set_vexpand(True)
        self._stage.add_css_class("lumen-code-surface")

        self._video = Gtk.Video()
        self._video.set_hexpand(True)
        self._video.set_vexpand(True)
        self._video.set_autoplay(False)

        self._status = Gtk.Label(label="")
        self._status.add_css_class("lumen-muted")
        self._status.set_visible(False)

        self._stage.append(self._video)
        self._stage.append(self._status)
        self.append(self._stage)

    def load(self, item: PreviewItem, context: PreviewContext) -> None:
        self.teardown()
        super().load(item, context)
        gen = self.next_generation()
        self._info_label.set_text(f"视频 · {item.title} · {item.size_label}")
        self._status.set_visible(False)

        if item.local_path and os.path.isfile(item.local_path):
            self._bind_path(item.local_path)
            return

        if item.clipboard_item is None:
            self._status.set_text("视频文件不可用")
            self._status.set_visible(True)
            return

        self._status.set_text("正在加载视频流…")
        self._status.set_visible(True)
        suffix = Path(item.title).suffix or ".mp4"

        def _ok(temp_path: str) -> None:
            if not self.is_current_generation(gen):
                return
            self._status.set_visible(False)
            self._bind_path(temp_path)

        def _err(exc: Exception) -> None:
            if not self.is_current_generation(gen):
                return
            self._status.set_text(f"视频加载失败：{exc}")
            self._status.set_visible(True)

        context.store.api.download_item_file_to_temp(
            item.clipboard_item.id,
            index=item.file_index or 0,
            suffix=suffix,
            on_success=_ok,
            on_error=_err,
        )

    def _bind_path(self, path: str) -> None:
        try:
            mf = Gtk.MediaFile.new_for_filename(path)
            self._media_file = mf
            self._video.set_media_stream(mf)
        except Exception as exc:
            self._status.set_text(f"视频播放后端不可用：{exc}")
            self._status.set_visible(True)

    def toggle_play_pause(self) -> bool:
        if self._media_file is None:
            return False
        if self._media_file.get_playing():
            self._media_file.pause()
        else:
            self._media_file.play()
        return True

    def teardown(self) -> None:
        super().teardown()
        if self._media_file is not None:
            try:
                self._media_file.pause()
                self._media_file.clear()
            except Exception:
                pass
            self._media_file = None
        try:
            self._video.set_media_stream(None)
        except Exception:
            pass


class VideoRenderer:
    renderer_id = "native.gtk4.video"
    priority = 94

    def can_render(self, item: PreviewItem) -> bool:
        return item.kind.category == "video"

    def create_view(self, item: PreviewItem, context: PreviewContext) -> PreviewRendererView:
        return VideoRendererView()

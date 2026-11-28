"""Separate native Orbit screen-edge floating rail (`LumenOrbitWindow`).

Pure native GTK4/GSK surface — zero WebKitGTK/HTML — completely separate from
the App Management Window. Uses `gtk4-layer-shell` on Wayland when available,
falling back to an undecorated keep-above skip-taskbar X11 window with OS focus
capture & restoration, interruptible GtkRevealer / spring animations, ambient
particles, release-light burst, and concurrent card removal/reflow.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Optional

from gi.repository import Graphene, Gsk

from .api import ClipboardStore
from .capabilities import Gdk, Gio, GLib, Gtk
from .config import LumenVisualPreferences
from .models import Classifier, ClipboardItem, decode_data_url_texture
from .motion import (
    CURVE_ENTER,
    CURVE_EXIT,
    InterruptibleValueAnimator,
    LumenMotion,
    RevealerTransitionController,
)
from .platform_window import PlatformOrbitWindowHelper
from .preview_registry import BoundedPreviewCache, PreviewItem
from .preview_window import LumenPreviewWindow
from .theme import (
    AlbumCoverWidget,
    ColorSwatchWidget,
    CssThemeManager,
    LumenPalette,
    SyntaxTokenizer,
    ToastBannerWidget,
    current_palette,
    make_color_stop,
    rgba,
)


@dataclass
class _Particle:
    x: float
    y: float
    vx: float
    vy: float
    radius: float
    alpha: float
    age: float
    lifetime: float


class OrbitBackdropWidget(Gtk.Widget):
    """GSK translucent glass backdrop with specular edge, spotlight, ambient particles, and bursts."""

    def __init__(self) -> None:
        super().__init__()
        self._palette: LumenPalette = current_palette()
        self._edge: str = "bottom"
        self._glow: bool = True
        self._particles_enabled: bool = True
        self._pointer_x: float = -1.0
        self._pointer_y: float = -1.0
        self._ambient: list[_Particle] = []
        self._burst: list[_Particle] = []
        self._tick_id: int = 0
        self._last_us: int = 0
        self.set_hexpand(True)
        self.set_vexpand(True)
        self.set_can_target(False)

    def configure(self, palette: LumenPalette, edge: str, prefs: LumenVisualPreferences) -> None:
        self._palette = palette
        self._edge = edge
        self._glow = prefs.glow
        motion_ok = LumenMotion.is_enabled(prefs.motion)
        self._particles_enabled = prefs.particles and motion_ok
        if self._particles_enabled:
            self._seed_ambient()
            self._ensure_tick()
        else:
            self._ambient.clear()
            self._burst.clear()
            self._stop_tick()
        self.queue_draw()

    def set_pointer(self, x: float, y: float) -> None:
        self._pointer_x = x
        self._pointer_y = y
        if self._glow:
            self.queue_draw()

    def trigger_release_burst(self, cx: float, cy: float, width: float, height: float) -> None:
        if not (self._particles_enabled and self._glow):
            return
        golden = 2.39996
        for i in range(18):
            ang = i * golden
            px = cx + ((i * 7 % 17) / 17.0 - 0.5) * width * 0.65
            py = cy + ((i * 11 % 17) / 17.0 - 0.5) * height * 0.65
            speed = 40.0 + i * 3.5
            self._burst.append(
                _Particle(
                    x=px,
                    y=py,
                    vx=math.cos(ang) * speed,
                    vy=math.sin(ang) * speed - 36.0,
                    radius=2.6 if (i % 4 == 0) else 1.7,
                    alpha=1.0,
                    age=0.0,
                    lifetime=0.46 + i * 0.01,
                )
            )
        self._ensure_tick()

    def _seed_ambient(self) -> None:
        if self._ambient:
            return
        for i in range(22):
            self._ambient.append(
                _Particle(
                    x=((i * 73) % 100) / 100.0,
                    y=((i * 41) % 100) / 100.0,
                    vx=(((i % 5) - 2) * 0.008),
                    vy=-0.010 - (i % 4) * 0.004,
                    radius=1.4 + (i % 3) * 0.7,
                    alpha=0.25 + (i % 4) * 0.14,
                    age=float(i % 7),
                    lifetime=8.0,
                )
            )

    def _ensure_tick(self) -> None:
        if self._tick_id or not self.get_mapped():
            return
        self._last_us = GLib.get_monotonic_time()
        self._tick_id = self.add_tick_callback(self._on_tick)

    def _stop_tick(self) -> None:
        if self._tick_id:
            try:
                self.remove_tick_callback(self._tick_id)
            except Exception:
                pass
            self._tick_id = 0

    def do_map(self) -> None:
        Gtk.Widget.do_map(self)
        if self._particles_enabled or self._burst:
            self._ensure_tick()

    def do_unmap(self) -> None:
        self._stop_tick()
        Gtk.Widget.do_unmap(self)

    def _on_tick(self, _widget: Gtk.Widget, _clock: object) -> bool:
        now = GLib.get_monotonic_time()
        elapsed_us = now - self._last_us
        # Throttle calm ambient drift to ~24fps to stay lightweight; full rate during bursts.
        if not self._burst and elapsed_us < 40_000:
            return True
        dt = min(0.06, max(0.004, elapsed_us / 1_000_000.0))
        self._last_us = now

        for p in self._ambient:
            p.x = (p.x + p.vx * dt) % 1.0
            p.y = (p.y + p.vy * dt) % 1.0
            p.age = (p.age + dt) % p.lifetime

        if self._burst:
            alive: list[_Particle] = []
            for p in self._burst:
                p.age += dt
                if p.age < p.lifetime:
                    p.x += p.vx * dt
                    p.y += p.vy * dt
                    p.vx *= 0.96
                    p.vy *= 0.96
                    alive.append(p)
            self._burst = alive

        self.queue_draw()
        if not self._particles_enabled and not self._burst:
            self._tick_id = 0
            return False
        return True

    def do_snapshot(self, snapshot: Gtk.Snapshot) -> None:
        w = max(1.0, float(self.get_width()))
        h = max(1.0, float(self.get_height()))
        rect = Graphene.Rect().init(0, 0, w, h)

        if self._palette.is_dark:
            top_c = rgba(0.082, 0.165, 0.278, 0.84)
            bot_c = rgba(0.055, 0.106, 0.196, 0.94)
            spot_c = rgba(0.54, 0.72, 1.0, 0.26)
            sheen_c = rgba(0.761, 0.871, 1.0, 0.75 if self._glow else 0.30)
            part_c = rgba(0.78, 0.90, 1.0, 0.60)
        else:
            top_c = rgba(0.890, 0.945, 0.996, 0.80)
            bot_c = rgba(0.678, 0.765, 0.890, 0.90)
            spot_c = rgba(0.95, 0.985, 1.0, 0.56)
            sheen_c = rgba(0.96, 0.99, 1.0, 0.90 if self._glow else 0.35)
            part_c = rgba(0.96, 0.99, 1.0, 0.80)

        snapshot.append_linear_gradient(
            rect,
            Graphene.Point().init(0, 0),
            Graphene.Point().init(0, h),
            [make_color_stop(0.0, top_c), make_color_stop(1.0, bot_c)],
        )

        if self._glow:
            if self._edge == "left":
                sx = w
                sy = self._pointer_y if self._pointer_y >= 0 else h * 0.5
            elif self._edge == "right":
                sx = 0.0
                sy = self._pointer_y if self._pointer_y >= 0 else h * 0.5
            else:
                sx = self._pointer_x if self._pointer_x >= 0 else w * 0.5
                sy = 0.0
            snapshot.append_radial_gradient(
                rect,
                Graphene.Point().init(sx, sy),
                320.0,
                220.0,
                0.0,
                1.0,
                [make_color_stop(0.0, spot_c), make_color_stop(1.0, rgba(1, 1, 1, 0.0))],
            )

        # Ambient floating particles
        if self._particles_enabled and self._ambient:
            for p in self._ambient:
                phase = math.sin(math.pi * (p.age / p.lifetime))
                alpha = max(0.0, min(1.0, p.alpha * (0.4 + 0.6 * phase)))
                pb = Gsk.PathBuilder.new()
                pb.add_circle(Graphene.Point().init(p.x * w, p.y * h), p.radius)
                snapshot.append_fill(
                    pb.to_path(),
                    Gsk.FillRule.WINDING,
                    rgba(part_c.red, part_c.green, part_c.blue, alpha),
                )

        # Release-light burst specks
        for p in self._burst:
            t = p.age / max(0.01, p.lifetime)
            alpha = (t / 0.22) if t < 0.22 else max(0.0, 1.0 - (t - 0.22) / 0.78)
            pb = Gsk.PathBuilder.new()
            pb.add_circle(Graphene.Point().init(p.x, p.y), p.radius * (1.2 - 0.6 * t))
            snapshot.append_fill(pb.to_path(), Gsk.FillRule.WINDING, rgba(0.95, 0.99, 1.0, alpha))

        # Reflective 1.5px glass edge line along exposed screen boundary
        if self._edge == "left":
            snapshot.append_color(sheen_c, Graphene.Rect().init(w - 1.5, 0, 1.5, h))
        elif self._edge == "right":
            snapshot.append_color(sheen_c, Graphene.Rect().init(0, 0, 1.5, h))
        else:
            snapshot.append_color(sheen_c, Graphene.Rect().init(0, 0, w, 1.5))


class OrbitCardWidget(Gtk.Revealer):
    """Single Orbit card wrapped in a Gtk.Revealer for smooth removal/reflow + spring lift."""

    def __init__(
        self,
        item: ClipboardItem,
        key_index: Optional[int],
        palette: LumenPalette,
        horizontal_rail: bool,
        card_w: int,
        card_h: int,
        on_select_paste: Callable[[str], None],
        on_hover_focus: Callable[[str], None],
        on_remove: Callable[[str], None],
        on_context: Callable[[str, Gtk.Widget, float, float], None],
    ) -> None:
        super().__init__()
        self.item = item
        self._key_index = key_index
        self._palette = palette
        self._horizontal = horizontal_rail
        self._visual_state = "idle"  # idle | near | hovered | selected
        self._pointer_inside = False
        self._on_select_paste = on_select_paste
        self._on_hover_focus = on_hover_focus
        self._on_remove = on_remove
        self._on_context = on_context

        self.set_transition_type(
            Gtk.RevealerTransitionType.SLIDE_LEFT if horizontal_rail else Gtk.RevealerTransitionType.SLIDE_UP
        )
        self.set_transition_duration(340)
        self.set_reveal_child(True)

        # Wrapper holds vertical lift room (+10px top, +10px bottom) so spring lift never clips
        self._slot = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._slot.set_margin_top(12)
        self._slot.set_margin_bottom(8)
        self._slot.set_margin_end(13 if horizontal_rail else 0)
        self._slot.set_margin_bottom(12 if not horizontal_rail else 8)

        self._overlay = Gtk.Overlay()
        self._card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self._card.add_css_class("lumen-orbit-card")
        self._card.set_size_request(card_w, card_h)
        self._card.set_hexpand(False)
        self._card.set_vexpand(False)

        self._lift_anim = InterruptibleValueAnimator(self._card, initial=0.0)
        self._build_content()
        self._overlay.set_child(self._card)

        # Floating top-right circular remove button revealed on hover/selection
        self._remove_btn = Gtk.Button.new_from_icon_name("window-close-symbolic")
        self._remove_btn.add_css_class("lumen-orbit-remove")
        self._remove_btn.set_tooltip_text("移除记录 (Delete)")
        self._remove_btn.set_halign(Gtk.Align.END)
        self._remove_btn.set_valign(Gtk.Align.START)
        self._remove_btn.set_margin_top(7)
        self._remove_btn.set_margin_end(7)
        self._remove_btn.set_visible(False)
        self._remove_btn.connect("clicked", lambda _b: self._on_remove(self.item.id))
        self._overlay.add_overlay(self._remove_btn)

        self._slot.append(self._overlay)
        self.set_child(self._slot)

        self._install_interactions()
        self.update_quick_key(key_index)

    def _build_content(self) -> None:
        cat = self.item.display_category
        kind = PreviewItem.classify_item(self.item)

        # Header row: source badge + source name + relative time
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=7)
        badge = ColorSwatchWidget(self._palette.source_badge_color(self.item.source_label), radius=6.0)
        badge.set_size_request(20, 20)
        badge.set_valign(Gtk.Align.CENTER)

        src_lbl = Gtk.Label(label=self.item.source_label)
        src_lbl.add_css_class("lumen-subheading")
        src_lbl.set_xalign(0.0)
        src_lbl.set_hexpand(True)
        src_lbl.set_ellipsize(3)

        self._time_lbl = Gtk.Label(label=self.item.relative_time)
        self._time_lbl.add_css_class("lumen-subheading")

        head.append(badge)
        head.append(src_lbl)
        head.append(self._time_lbl)
        self._card.append(head)

        # Title
        title = Gtk.Label(label=self.item.display_title)
        title.set_xalign(0.0)
        title.set_ellipsize(3)
        title.add_css_class("lumen-heading")
        self._card.append(title)

        # Rich content body
        body_wrap = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        body_wrap.set_vexpand(True)
        body_wrap.set_hexpand(True)

        if kind.category == "color":
            parsed = Classifier.parse_hex_color(self.item.effective_text) or (0.33, 0.43, 0.88, 1.0)
            sw = ColorSwatchWidget(radius=10.0)
            sw.set_swatch(*parsed, label=self.item.effective_text.strip().upper())
            sw.set_hexpand(True)
            sw.set_vexpand(True)
            body_wrap.append(sw)
        elif kind.category == "image":
            thumb_key = f"thumb:{self.item.id}"
            cache = BoundedPreviewCache.shared()
            tex = cache.image(thumb_key)
            if tex is None and self.item.thumbnail_data_url:
                tex = decode_data_url_texture(self.item.thumbnail_data_url)
                if tex is not None:
                    cache.store_image(thumb_key, tex)
            if tex is not None:
                pic = Gtk.Picture.new_for_paintable(tex)
                pic.set_content_fit(Gtk.ContentFit.COVER)
                pic.set_hexpand(True)
                pic.set_vexpand(True)
                body_wrap.append(pic)
            else:
                img = Gtk.Image.new_from_icon_name("image-x-generic-symbolic")
                img.set_pixel_size(32)
                img.set_vexpand(True)
                body_wrap.append(img)
        elif kind.category == "code":
            code_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            code_box.add_css_class("lumen-orbit-code-body")
            code_box.set_vexpand(True)
            code_lbl = Gtk.Label()
            code_lbl.set_xalign(0.0)
            code_lbl.set_yalign(0.0)
            code_lbl.set_wrap(True)
            code_lbl.set_lines(6)
            code_lbl.set_ellipsize(3)
            markup = SyntaxTokenizer.to_pango_markup(
                self.item.effective_text,
                kind.subtype or "js",
                dark_canvas=True,
                max_chars=240,
            )
            code_lbl.set_markup(markup)
            code_box.append(code_lbl)
            body_wrap.append(code_box)
        elif kind.category in ("audio", "video"):
            cover = AlbumCoverWidget(
                seed_index=abs(hash(self.item.id)) % 3,
                badge_text="AUDIO" if kind.category == "audio" else "VIDEO",
                size=0,
            )
            cover.set_hexpand(True)
            cover.set_vexpand(True)
            body_wrap.append(cover)
        elif kind.category in ("pdf", "office", "file", "collection"):
            sub = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            sub.add_css_class("lumen-orbit-subbox")
            sub.set_vexpand(True)
            sub.set_valign(Gtk.Align.CENTER)
            ico_name = "application-pdf-symbolic" if kind.category == "pdf" else "text-x-generic-symbolic"
            ico = Gtk.Image.new_from_icon_name(ico_name)
            ico.set_pixel_size(28)
            col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            col.set_valign(Gtk.Align.CENTER)
            col.set_hexpand(True)
            f_name = Gtk.Label(label=self.item.display_title)
            f_name.set_xalign(0.0)
            f_name.set_ellipsize(2)
            f_meta = Gtk.Label(label=f"{kind.display_label} · {self.item.formatted_size}")
            f_meta.add_css_class("lumen-subheading")
            f_meta.set_xalign(0.0)
            col.append(f_name)
            col.append(f_meta)
            sub.append(ico)
            sub.append(col)
            body_wrap.append(sub)
        elif kind.category == "link":
            sub = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            sub.add_css_class("lumen-orbit-subbox")
            sub.set_vexpand(True)
            sub.set_valign(Gtk.Align.CENTER)
            ico = Gtk.Image.new_from_icon_name("insert-link-symbolic")
            ico.set_halign(Gtk.Align.START)
            url_lbl = Gtk.Label(label=self.item.effective_text.replace("https://", "").replace("http://", ""))
            url_lbl.add_css_class("lumen-subheading")
            url_lbl.set_xalign(0.0)
            url_lbl.set_wrap(True)
            url_lbl.set_lines(3)
            url_lbl.set_ellipsize(3)
            sub.append(ico)
            sub.append(url_lbl)
            body_wrap.append(sub)
        else:
            excerpt = Gtk.Label(label=self.item.effective_text[:220])
            excerpt.set_xalign(0.0)
            excerpt.set_yalign(0.0)
            excerpt.set_wrap(True)
            excerpt.set_lines(5)
            excerpt.set_ellipsize(3)
            excerpt.add_css_class("lumen-muted")
            body_wrap.append(excerpt)

        self._card.append(body_wrap)

        # Footer row: category icon + label + pin + quick key 1-9
        foot = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        foot_ico = Gtk.Image.new_from_icon_name(cat.icon_name)
        foot_ico.set_pixel_size(12)
        foot_lbl = Gtk.Label(label=cat.label)
        foot_lbl.add_css_class("lumen-subheading")
        foot_lbl.set_xalign(0.0)
        foot_lbl.set_hexpand(True)

        self._pin_ico = Gtk.Image.new_from_icon_name("view-pin-symbolic")
        self._pin_ico.set_pixel_size(12)
        self._pin_ico.set_visible(self.item.pinned)

        self._key_badge = Gtk.Label(label="")
        self._key_badge.add_css_class("lumen-orbit-key")
        self._key_badge.set_visible(False)

        foot.append(foot_ico)
        foot.append(foot_lbl)
        foot.append(self._pin_ico)
        foot.append(self._key_badge)
        self._card.append(foot)

    def _install_interactions(self) -> None:
        motion = Gtk.EventControllerMotion.new()
        motion.connect("enter", self._on_enter)
        motion.connect("leave", self._on_leave)
        self._card.add_controller(motion)

        left_click = Gtk.GestureClick.new()
        left_click.set_button(1)
        left_click.connect("released", self._on_left_click)
        self._card.add_controller(left_click)

        right_click = Gtk.GestureClick.new()
        right_click.set_button(3)
        right_click.connect("pressed", self._on_right_click)
        self._card.add_controller(right_click)

    def _on_enter(self, _ctrl: Gtk.EventControllerMotion, _x: float, _y: float) -> None:
        self._pointer_inside = True
        self._update_remove_visibility()
        self._on_hover_focus(self.item.id)

    def _on_leave(self, _ctrl: Gtk.EventControllerMotion) -> None:
        self._pointer_inside = False
        self._update_remove_visibility()

    def _on_left_click(self, _g: Gtk.GestureClick, _n: int, _x: float, _y: float) -> None:
        self._on_select_paste(self.item.id)

    def _on_right_click(self, _g: Gtk.GestureClick, _n: int, x: float, y: float) -> None:
        self._on_context(self.item.id, self._card, x, y)

    def update_quick_key(self, idx: Optional[int]) -> None:
        self._key_index = idx
        if idx is not None and 0 <= idx < 9:
            self._key_badge.set_text(str(idx + 1))
            self._key_badge.set_visible(True)
        else:
            self._key_badge.set_visible(False)

    def set_dimensions(self, card_w: int, card_h: int, horizontal_rail: bool) -> None:
        self._horizontal = horizontal_rail
        self._card.set_size_request(card_w, card_h)
        self._slot.set_margin_end(13 if horizontal_rail else 0)
        self._slot.set_margin_bottom(8 if horizontal_rail else 12)
        self.set_transition_type(
            Gtk.RevealerTransitionType.SLIDE_LEFT if horizontal_rail else Gtk.RevealerTransitionType.SLIDE_UP
        )

    def set_visual_state(self, state: str, motion_enabled: bool) -> None:
        self._visual_state = state
        is_sel = state == "selected"
        if is_sel:
            self._card.add_css_class("lumen-selected")
        else:
            self._card.remove_css_class("lumen-selected")
        self._update_remove_visibility()

        lift_map = {"selected": 9.0, "hovered": 5.0, "near": 2.0, "idle": 0.0}
        target_lift = lift_map.get(state, 0.0) if self._horizontal else 0.0

        def _apply_lift(val: float) -> None:
            lifted = int(round(max(0.0, min(12.0, val))))
            self._slot.set_margin_top(max(2, 12 - lifted))
            self._slot.set_margin_bottom(8 + lifted)

        self._lift_anim.animate_spring(
            target_lift,
            on_update=_apply_lift,
            stiffness=280.0,
            damping=19.0,
            mass=0.85,
            enabled=motion_enabled,
        )

    def _update_remove_visibility(self) -> None:
        show = self._pointer_inside or self._visual_state == "selected"
        self._remove_btn.set_visible(show)
        self._time_lbl.set_visible(not show)

    def animate_remove(self, duration_ms: int, on_finished: Callable[[], None]) -> None:
        self._remove_btn.set_visible(False)
        self.set_sensitive(False)
        self.set_transition_duration(max(10, duration_ms))
        self.set_reveal_child(False)
        if duration_ms <= 10:
            on_finished()
            return

        def _cleanup() -> bool:
            on_finished()
            return False

        GLib.timeout_add(duration_ms + 25, _cleanup)


class LumenOrbitWindow(Gtk.Window):
    """Separate borderless floating edge-rail window for Paste Lumen V7."""

    def __init__(self, application: Optional[Gtk.Application] = None) -> None:
        super().__init__(application=application, title="Lumen Orbit")
        self.add_css_class("lumen-window")
        self.add_css_class("lumen-orbit-window")
        self.set_hide_on_close(True)

        self._store = ClipboardStore.shared()
        self._platform = PlatformOrbitWindowHelper()
        self._position: str = self._normalize_position(self._store.settings.quick_orbit_position)
        self._is_showing: bool = False
        self._cards: list[OrbitCardWidget] = []
        self._removing_ids: set[str] = set()
        self._selected_id: Optional[str] = None
        self._card_w: int = 196
        self._card_h: int = 204
        self._popover: Optional[Gtk.PopoverMenu] = None
        self._drag_start_hval: float = 0.0

        self.on_open_workspace: Optional[Callable[[], None]] = None
        self.get_own_windows: Optional[Callable[[], list[Gtk.Window]]] = None

        self._platform.prepare_before_realize(self, self._position)
        self._build_layout()
        self._install_controllers()

        self._fade_anim = InterruptibleValueAnimator(self, initial=0.0)
        self._revealer_ctrl = RevealerTransitionController(self._revealer)

        self.apply_theme()
        self._obs_id = self._store.add_observer(self._on_store_event)
        self.connect("realize", self._on_realize)
        self.connect("map", self._on_map)
        self.connect("close-request", self._on_close_request)

    @property
    def platform_backend(self) -> str:
        return self._platform.backend_name

    @property
    def position(self) -> str:
        return self._position

    @staticmethod
    def _normalize_position(raw: str) -> str:
        cleaned = (raw or "").strip().lower()
        return cleaned if cleaned in ("bottom", "left", "right") else "bottom"

    def _build_layout(self) -> None:
        self._revealer = Gtk.Revealer()
        self._revealer.set_reveal_child(False)
        self._revealer.set_hexpand(True)
        self._revealer.set_vexpand(True)

        self._overlay = Gtk.Overlay()
        self._overlay.set_hexpand(True)
        self._overlay.set_vexpand(True)

        self._backdrop = OrbitBackdropWidget()
        self._overlay.set_child(self._backdrop)

        self._rail_scroll = Gtk.ScrolledWindow()
        self._rail_scroll.set_hexpand(True)
        self._rail_scroll.set_vexpand(True)
        self._rail_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        self._rail_scroll.set_overlay_scrolling(True)

        self._rail_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self._rail_box.set_margin_start(22)
        self._rail_box.set_margin_end(22)
        self._rail_box.set_margin_top(14)
        self._rail_box.set_margin_bottom(10)
        self._rail_box.set_valign(Gtk.Align.CENTER)
        self._rail_scroll.set_child(self._rail_box)

        self._empty_lbl = Gtk.Label(label="暂无剪贴板记录")
        self._empty_lbl.add_css_class("lumen-heading")
        self._empty_lbl.set_halign(Gtk.Align.CENTER)
        self._empty_lbl.set_valign(Gtk.Align.CENTER)
        self._empty_lbl.set_visible(False)

        self._toast = ToastBannerWidget(on_undo=self._undo_last_delete)

        self._overlay.add_overlay(self._rail_scroll)
        self._overlay.add_overlay(self._empty_lbl)
        self._overlay.add_overlay(self._toast)

        self._revealer.set_child(self._overlay)
        self.set_child(self._revealer)

    def _install_controllers(self) -> None:
        key_ctrl = Gtk.EventControllerKey.new()
        key_ctrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_ctrl.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_ctrl)

        pointer = Gtk.EventControllerMotion.new()
        pointer.connect("motion", lambda _c, x, y: self._backdrop.set_pointer(x, y))
        self._overlay.add_controller(pointer)

        # Translate vertical mouse-wheel scrolling to horizontal rail pan on bottom rail.
        scroll_ctrl = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.VERTICAL)
        scroll_ctrl.connect("scroll", self._on_rail_wheel_scroll)
        self._rail_scroll.add_controller(scroll_ctrl)

        drag = Gtk.GestureDrag.new()
        drag.connect("drag-begin", self._on_drag_begin)
        drag.connect("drag-update", self._on_drag_update)
        self._rail_scroll.add_controller(drag)

        # Action group for right-click context menu
        action_group = Gio.SimpleActionGroup.new()
        for name, cb in (
            ("paste", lambda _a, p: self._paste_and_dismiss(p.get_string())),
            ("peek", lambda _a, p: self._open_quick_look(p.get_string())),
            ("pin", lambda _a, p: self._store.toggle_pin(p.get_string())),
            ("open-app", lambda _a, _p: self._open_workspace()),
            ("remove", lambda _a, p: self.remove_card_animated(p.get_string())),
        ):
            param = None if name == "open-app" else GLib.VariantType.new("s")
            act = Gio.SimpleAction.new(name, param)
            act.connect("activate", cb)
            action_group.add_action(act)
        self.insert_action_group("orbit", action_group)

    def _on_realize(self, _win: Gtk.Window) -> None:
        self._platform.apply_geometry_and_flags(self, self._position)

    def _on_map(self, _win: Gtk.Window) -> None:
        self._platform.apply_geometry_and_flags(self, self._position)

    def _on_store_event(self, event: str, _payload: object) -> None:
        if event == "items":
            if self._is_showing:
                self.sync_cards_from_store()
        elif event == "preferences":
            self.apply_theme()
        elif event == "settings":
            next_pos = self._normalize_position(self._store.settings.quick_orbit_position)
            if next_pos != self._position:
                self.set_edge_position(next_pos)

    def set_edge_position(self, next_pos: str) -> None:
        norm = self._normalize_position(next_pos)
        if norm == self._position:
            return
        self._position = norm
        self._update_orientation_and_metrics()
        self._backdrop.configure(current_palette(self._store.preferences), self._position, self._store.preferences)
        self._platform.apply_geometry_and_flags(self, self._position)
        self._update_card_visual_states()

    def apply_theme(self) -> None:
        CssThemeManager.apply_to_window(self, self._store.preferences)
        palette = current_palette(self._store.preferences)
        self._backdrop.configure(palette, self._position, self._store.preferences)

    def _transition_type_for_edge(self) -> Gtk.RevealerTransitionType:
        if self._position == "left":
            return Gtk.RevealerTransitionType.SLIDE_RIGHT
        if self._position == "right":
            return Gtk.RevealerTransitionType.SLIDE_LEFT
        return Gtk.RevealerTransitionType.SLIDE_UP

    def _update_orientation_and_metrics(self) -> None:
        geom = self._platform.compute_rail_geometry(self._position)
        horizontal = self._position == "bottom"
        if horizontal:
            self._card_h = min(226, max(164, geom.height - 44))
            self._card_w = min(214, max(172, int(round(geom.width * 0.14))))
            self._rail_box.set_orientation(Gtk.Orientation.HORIZONTAL)
            self._rail_scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
            self._rail_box.set_halign(Gtk.Align.START)
            self._rail_box.set_valign(Gtk.Align.CENTER)
        else:
            self._card_w = max(196, geom.width - 36)
            self._card_h = 182
            self._rail_box.set_orientation(Gtk.Orientation.VERTICAL)
            self._rail_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            self._rail_box.set_halign(Gtk.Align.CENTER)
            self._rail_box.set_valign(Gtk.Align.START)

        for card in self._cards:
            card.set_dimensions(self._card_w, self._card_h, horizontal)

    def toggle_rail(self) -> None:
        if self._is_showing:
            self.hide_rail(restore_focus=True)
        else:
            self.show_rail()

    def show_rail(self) -> None:
        self._store.ensure_configured_from_local()
        was_visible = self.get_visible()
        if not was_visible:
            own = self.get_own_windows() if self.get_own_windows else [self]
            self._platform.capture_foreground_focus(own)

        self._is_showing = True
        self._update_orientation_and_metrics()
        self.sync_cards_from_store()
        self._store.refresh_items()

        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)
        enter_ms = LumenMotion.enter_ms(self._store.preferences.motion)

        self._platform.apply_geometry_and_flags(self, self._position)
        if not was_visible:
            self.set_opacity(0.0 if motion_ok else 1.0)
            self._fade_anim.value = 0.0 if motion_ok else 1.0
        self.present()
        self._platform.apply_geometry_and_flags(self, self._position)

        self._revealer_ctrl.reveal(True, self._transition_type_for_edge(), enter_ms)
        self._fade_anim.animate_timed(
            1.0,
            enter_ms,
            CURVE_ENTER,
            on_update=lambda v: self.set_opacity(max(0.0, min(1.0, v))),
        )

    def hide_rail(self, restore_focus: bool = True) -> None:
        if not self._is_showing and not self.get_visible():
            return
        self._is_showing = False
        exit_ms = LumenMotion.exit_ms(self._store.preferences.motion)

        def _finish() -> None:
            if self._is_showing:
                return
            self.set_visible(False)
            self.set_opacity(1.0)
            if restore_focus:
                self._platform.restore_foreground_focus()

        self._revealer_ctrl.reveal(False, self._transition_type_for_edge(), exit_ms)
        self._fade_anim.animate_timed(
            0.0,
            exit_ms,
            CURVE_EXIT,
            on_update=lambda v: self.set_opacity(max(0.0, min(1.0, v))),
            on_done=_finish,
        )

    def sync_cards_from_store(self) -> None:
        palette = current_palette(self._store.preferences)
        horizontal = self._position == "bottom"
        # Reuse live cards by item ID & content signature to keep Orbit instant on refresh.
        active_items = [it for it in self._store.items if it.id not in self._removing_ids][:60]

        existing_by_id: dict[str, OrbitCardWidget] = {c.item.id: c for c in self._cards}
        same_order = (
            len(active_items) == len(self._cards)
            and all(
                self._cards[i].item.id == active_items[i].id
                and self._cards[i].item.pinned == active_items[i].pinned
                and self._cards[i].item.preview == active_items[i].preview
                for i in range(len(active_items))
            )
        )
        if same_order:
            self._empty_lbl.set_visible(len(self._cards) == 0)
            self._update_card_visual_states()
            return

        # Detach existing cards cleanly before re-attaching reused + new cards in order.
        for card in self._cards:
            if card.get_parent() is self._rail_box:
                self._rail_box.remove(card)

        next_cards: list[OrbitCardWidget] = []
        for idx, item in enumerate(active_items):
            reused = existing_by_id.get(item.id)
            if (
                reused is not None
                and reused.item.pinned == item.pinned
                and reused.item.preview == item.preview
                and reused.item.thumbnail_data_url == item.thumbnail_data_url
            ):
                reused.item = item
                reused.set_dimensions(self._card_w, self._card_h, horizontal)
                reused.update_quick_key(idx if idx < 9 else None)
                self._rail_box.append(reused)
                next_cards.append(reused)
                continue

            card = OrbitCardWidget(
                item=item,
                key_index=idx if idx < 9 else None,
                palette=palette,
                horizontal_rail=horizontal,
                card_w=self._card_w,
                card_h=self._card_h,
                on_select_paste=self._paste_and_dismiss,
                on_hover_focus=lambda cid: self._set_focused(cid, scroll=False),
                on_remove=self.remove_card_animated,
                on_context=self._present_context_menu,
            )
            self._rail_box.append(card)
            next_cards.append(card)

        self._cards = next_cards
        self._empty_lbl.set_visible(len(self._cards) == 0)
        valid_ids = {c.item.id for c in self._cards}
        if self._selected_id not in valid_ids:
            self._selected_id = self._cards[0].item.id if self._cards else None
        self._update_card_visual_states()

    def _set_focused(self, item_id: str, scroll: bool = False) -> None:
        self._selected_id = item_id
        self._update_card_visual_states()
        if scroll:
            self._scroll_card_into_view(item_id)

    def _update_card_visual_states(self) -> None:
        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)
        sel_idx = next((i for i, c in enumerate(self._cards) if c.item.id == self._selected_id), -1)
        for i, card in enumerate(self._cards):
            card.update_quick_key(i if i < 9 else None)
            if i == sel_idx:
                card.set_visual_state("selected", motion_ok)
            elif sel_idx >= 0 and abs(i - sel_idx) == 1:
                card.set_visual_state("near", motion_ok)
            else:
                card.set_visual_state("idle", motion_ok)

    def _scroll_card_into_view(self, item_id: str) -> None:
        idx = next((i for i, c in enumerate(self._cards) if c.item.id == item_id), -1)
        if idx < 0:
            return
        if self._position == "bottom":
            adj = self._rail_scroll.get_hadjustment()
            step = self._card_w + 13
            target = max(0.0, idx * step - 24.0)
            if target < adj.get_value():
                adj.set_value(target)
            elif (idx + 1) * step + 24.0 > adj.get_value() + adj.get_page_size():
                adj.set_value(max(0.0, (idx + 1) * step + 24.0 - adj.get_page_size()))
        else:
            adj = self._rail_scroll.get_vadjustment()
            step = self._card_h + 12
            target = max(0.0, idx * step - 16.0)
            if target < adj.get_value():
                adj.set_value(target)
            elif (idx + 1) * step + 16.0 > adj.get_value() + adj.get_page_size():
                adj.set_value(max(0.0, (idx + 1) * step + 16.0 - adj.get_page_size()))

    def remove_card_animated(self, item_id: str) -> None:
        if item_id in self._removing_ids:
            return
        idx = next((i for i, c in enumerate(self._cards) if c.item.id == item_id), -1)
        if idx < 0:
            return
        card = self._cards.pop(idx)
        self._removing_ids.add(item_id)

        if self._selected_id == item_id:
            if idx < len(self._cards):
                self._selected_id = self._cards[idx].item.id
            elif self._cards:
                self._selected_id = self._cards[-1].item.id
            else:
                self._selected_id = None

        # Trigger release-light burst at card position inside backdrop
        ok, pt = card.compute_point(self._backdrop, Graphene.Point().init(card.get_width() / 2.0, card.get_height() / 2.0))
        if ok:
            self._backdrop.trigger_release_burst(pt.x, pt.y, max(60.0, float(card.get_width())), max(60.0, float(card.get_height())))

        remove_ms = LumenMotion.remove_ms(self._store.preferences.motion)

        def _after_collapse() -> None:
            if card.get_parent() is self._rail_box:
                self._rail_box.remove(card)
            self._removing_ids.discard(item_id)
            self._empty_lbl.set_visible(len(self._cards) == 0)

        card.animate_remove(remove_ms, _after_collapse)
        self._update_card_visual_states()

        self._store.delete_item(
            item_id,
            optimistic=True,
            on_success=lambda: self._toast.show_message(
                "已移除剪贴板记录",
                show_undo=self._store.can_undo_delete,
                motion_enabled=LumenMotion.is_enabled(self._store.preferences.motion),
            ),
        )

    def _undo_last_delete(self) -> None:
        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)

        def _ok(restored: ClipboardItem) -> None:
            self._selected_id = restored.id
            self.sync_cards_from_store()
            self._toast.show_message("已恢复记录", show_undo=self._store.can_undo_delete, motion_enabled=motion_ok)

        self._store.undo_last_delete(
            on_success=_ok,
            on_error=lambda err: self._toast.show_message(str(err), motion_enabled=motion_ok),
        )

    def _paste_and_dismiss(self, item_id: str) -> None:
        motion_ok = LumenMotion.is_enabled(self._store.preferences.motion)
        self._store.copy_to_os_clipboard(
            item_id,
            on_success=lambda: self.hide_rail(restore_focus=True),
            on_error=lambda err: self._toast.show_message(f"复制失败：{err}", motion_enabled=motion_ok),
        )

    def _open_quick_look(self, item_id: str) -> None:
        item = next((it for it in self._store.items if it.id == item_id), None)
        if item is not None:
            LumenPreviewWindow.shared(self.get_application()).open_clipboard_items([item], initial_id=item.id)

    def _open_workspace(self) -> None:
        self.hide_rail(restore_focus=False)
        if self.on_open_workspace is not None:
            self.on_open_workspace()

    def _present_context_menu(self, item_id: str, anchor: Gtk.Widget, x: float, y: float) -> None:
        self._set_focused(item_id, scroll=False)
        item = next((it for it in self._store.items if it.id == item_id), None)
        pin_label = "取消固定" if (item and item.pinned) else "固定记录"

        menu = Gio.Menu.new()
        menu.append("复制到剪贴板 (↵)", f"orbit.paste('{item_id}')")
        menu.append("完整预览 (Space)", f"orbit.peek('{item_id}')")
        menu.append(pin_label, f"orbit.pin('{item_id}')")
        menu.append("在 Lumen 资料库中打开", "orbit.open-app")
        sec = Gio.Menu.new()
        sec.append("移除记录 (Del)", f"orbit.remove('{item_id}')")
        menu.append_section(None, sec)

        if self._popover is not None:
            self._popover.unparent()
        pop = Gtk.PopoverMenu.new_from_model(menu)
        pop.set_parent(anchor)
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        pop.set_pointing_to(rect)
        pop.popup()
        self._popover = pop

    def _on_rail_wheel_scroll(self, _ctrl: Gtk.EventControllerScroll, _dx: float, dy: float) -> bool:
        if self._position != "bottom":
            return False
        adj = self._rail_scroll.get_hadjustment()
        next_val = max(0.0, min(adj.get_upper() - adj.get_page_size(), adj.get_value() + dy * 56.0))
        adj.set_value(next_val)
        return True

    def _on_drag_begin(self, _g: Gtk.GestureDrag, _x: float, _y: float) -> None:
        self._drag_start_hval = self._rail_scroll.get_hadjustment().get_value()

    def _on_drag_update(self, _g: Gtk.GestureDrag, offset_x: float, _offset_y: float) -> None:
        if self._position != "bottom" or abs(offset_x) < 7.0:
            return
        adj = self._rail_scroll.get_hadjustment()
        target = max(0.0, min(adj.get_upper() - adj.get_page_size(), self._drag_start_hval - offset_x))
        adj.set_value(target)

    def _step_focus(self, delta: int) -> None:
        if not self._cards:
            return
        idx = next((i for i, c in enumerate(self._cards) if c.item.id == self._selected_id), 0)
        nxt = max(0, min(len(self._cards) - 1, idx + delta))
        self._set_focused(self._cards[nxt].item.id, scroll=True)

    def _on_key_pressed(
        self,
        _ctrl: Gtk.EventControllerKey,
        keyval: int,
        _keycode: int,
        state: Gdk.ModifierType,
    ) -> bool:
        ctrl = bool(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.META_MASK))
        if ctrl and keyval in (Gdk.KEY_z, Gdk.KEY_Z) and self._store.can_undo_delete:
            self._undo_last_delete()
            return True
        if ctrl:
            return False
        if keyval == Gdk.KEY_Escape:
            self.hide_rail(restore_focus=True)
            return True
        if keyval in (Gdk.KEY_Left, Gdk.KEY_Up):
            self._step_focus(-1)
            return True
        if keyval in (Gdk.KEY_Right, Gdk.KEY_Down):
            self._step_focus(1)
            return True
        if keyval == Gdk.KEY_Home and self._cards:
            self._set_focused(self._cards[0].item.id, scroll=True)
            return True
        if keyval == Gdk.KEY_End and self._cards:
            self._set_focused(self._cards[-1].item.id, scroll=True)
            return True
        if keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) and self._selected_id:
            self._paste_and_dismiss(self._selected_id)
            return True
        if keyval == Gdk.KEY_space and self._selected_id:
            self._open_quick_look(self._selected_id)
            return True
        if keyval in (Gdk.KEY_Delete, Gdk.KEY_BackSpace) and self._selected_id:
            self.remove_card_animated(self._selected_id)
            return True
        if Gdk.KEY_1 <= keyval <= Gdk.KEY_9:
            digit_idx = keyval - Gdk.KEY_1
            if 0 <= digit_idx < len(self._cards):
                target_id = self._cards[digit_idx].item.id
                self._set_focused(target_id, scroll=True)
                self._paste_and_dismiss(target_id)
                return True
        return False

    def _on_close_request(self, _win: Gtk.Window) -> bool:
        self.hide_rail(restore_focus=True)
        return True

    def shutdown(self) -> None:
        self._fade_anim.cancel()
        self._revealer_ctrl.cancel_pending()
        self._store.remove_observer(self._obs_id)

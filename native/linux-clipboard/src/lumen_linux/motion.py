"""Interruptible animation primitives honoring GTK reduced-motion and Adwaita.

Uses Adw.SpringAnimation / Adw.TimedAnimation when libadwaita is available, and
falls back to a GTK4 frame-clock (`add_tick_callback`) damped spring and cubic-
bezier integrator so animations remain smooth and immediately interruptible on
any GTK4 host.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional

from .capabilities import Adw, GLib, Gtk


def _cubic_bezier_sample(t: float, p1x: float, p1y: float, p2x: float, p2y: float) -> float:
    """Evaluates y(x) for cubic-bezier(p1x, p1y, p2x, p2y) at progress x = t."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0

    def _x(u: float) -> float:
        inv = 1.0 - u
        return 3.0 * inv * inv * u * p1x + 3.0 * inv * u * u * p2x + u * u * u

    def _dx(u: float) -> float:
        inv = 1.0 - u
        return 3.0 * inv * inv * p1x + 6.0 * inv * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x)

    def _y(u: float) -> float:
        inv = 1.0 - u
        return 3.0 * inv * inv * u * p1y + 3.0 * inv * u * u * p2y + u * u * u

    u = t
    for _ in range(6):
        err = _x(u) - t
        if abs(err) < 1e-5:
            break
        slope = _dx(u)
        if abs(slope) < 1e-6:
            break
        u = max(0.0, min(1.0, u - err / slope))
    return _y(u)


CURVE_ENTER = (0.19, 1.0, 0.25, 1.0)
CURVE_EXIT = (0.4, 0.0, 0.5, 1.0)
CURVE_SWITCH = (0.16, 1.0, 0.3, 1.0)


class LumenMotion:
    """Motion token resolver honoring both in-app preference and gtk-enable-animations."""

    @staticmethod
    def is_enabled(app_motion_pref: bool = True) -> bool:
        if not app_motion_pref:
            return False
        settings = Gtk.Settings.get_default()
        if settings is not None:
            try:
                if not bool(settings.get_property("gtk-enable-animations")):
                    return False
            except Exception:
                pass
        return True

    @classmethod
    def enter_ms(cls, app_motion_pref: bool = True) -> int:
        return 380 if cls.is_enabled(app_motion_pref) else 10

    @classmethod
    def exit_ms(cls, app_motion_pref: bool = True) -> int:
        return 220 if cls.is_enabled(app_motion_pref) else 10

    @classmethod
    def switch_ms(cls, app_motion_pref: bool = True) -> int:
        return 280 if cls.is_enabled(app_motion_pref) else 10

    @classmethod
    def remove_ms(cls, app_motion_pref: bool = True) -> int:
        return 340 if cls.is_enabled(app_motion_pref) else 10

    @classmethod
    def hover_ms(cls, app_motion_pref: bool = True) -> int:
        return 200 if cls.is_enabled(app_motion_pref) else 10


class InterruptibleValueAnimator:
    """Drives a scalar property with interruptible spring or cubic-bezier motion.

    Every new animation snapshots the live current value (and velocity when using
    springs), increments `token` so stale completion callbacks become no-ops, and
    never leaves orphan tick callbacks after widget unrealize/destroy.
    """

    def __init__(self, widget: Gtk.Widget, initial: float = 0.0) -> None:
        self._widget = widget
        self.value: float = float(initial)
        self._velocity: float = 0.0
        self._token: int = 0
        self._tick_id: int = 0
        self._adw_anim: Optional[Any] = None
        self._timeout_id: int = 0

    def cancel(self) -> None:
        self._token += 1
        if self._adw_anim is not None:
            try:
                self._adw_anim.pause()
            except Exception:
                pass
            self._adw_anim = None
        if self._tick_id:
            try:
                self._widget.remove_tick_callback(self._tick_id)
            except Exception:
                pass
            self._tick_id = 0
        if self._timeout_id:
            GLib.source_remove(self._timeout_id)
            self._timeout_id = 0

    def set_immediate(self, target: float, on_update: Callable[[float], None]) -> None:
        self.cancel()
        self.value = float(target)
        self._velocity = 0.0
        on_update(self.value)

    def animate_timed(
        self,
        target: float,
        duration_ms: int,
        curve: tuple[float, float, float, float],
        on_update: Callable[[float], None],
        on_done: Optional[Callable[[], None]] = None,
    ) -> int:
        self.cancel()
        token = self._token
        start_val = self.value
        end_val = float(target)

        if duration_ms <= 10 or abs(end_val - start_val) < 1e-4:
            self.value = end_val
            self._velocity = 0.0
            on_update(end_val)
            if on_done is not None:
                on_done()
            return token

        if Adw is not None and self._widget.get_mapped():
            try:
                anim_target = Adw.CallbackAnimationTarget.new(lambda v: self._apply_adw_value(token, v, on_update))
                anim = Adw.TimedAnimation.new(self._widget, start_val, end_val, duration_ms, anim_target)
                anim.set_easing(Adw.Easing.EASE_OUT_CUBIC if curve == CURVE_ENTER else Adw.Easing.EASE_IN_OUT_CUBIC)

                def _on_done(_anim: Any) -> None:
                    if self._token != token:
                        return
                    self.value = end_val
                    self._adw_anim = None
                    if on_done is not None:
                        on_done()

                anim.connect("done", _on_done)
                self._adw_anim = anim
                anim.play()
                return token
            except Exception:
                pass

        # Pure GTK4 frame-clock fallback (works both mapped and unmapped).
        duration_us = max(1, duration_ms) * 1000
        start_us = GLib.get_monotonic_time()
        p1x, p1y, p2x, p2y = curve

        if self._widget.get_mapped():
            def _tick(_w: Gtk.Widget, clock: Any) -> bool:
                if self._token != token:
                    self._tick_id = 0
                    return False
                elapsed = max(0, GLib.get_monotonic_time() - start_us)
                progress = min(1.0, elapsed / duration_us)
                eased = _cubic_bezier_sample(progress, p1x, p1y, p2x, p2y)
                self.value = start_val + (end_val - start_val) * eased
                on_update(self.value)
                if progress >= 1.0:
                    self._tick_id = 0
                    self.value = end_val
                    if on_done is not None:
                        on_done()
                    return False
                return True

            self._tick_id = self._widget.add_tick_callback(_tick)
        else:
            def _timer() -> bool:
                if self._token != token:
                    self._timeout_id = 0
                    return False
                elapsed = max(0, GLib.get_monotonic_time() - start_us)
                progress = min(1.0, elapsed / duration_us)
                eased = _cubic_bezier_sample(progress, p1x, p1y, p2x, p2y)
                self.value = start_val + (end_val - start_val) * eased
                on_update(self.value)
                if progress >= 1.0:
                    self._timeout_id = 0
                    self.value = end_val
                    if on_done is not None:
                        on_done()
                    return False
                return True

            self._timeout_id = GLib.timeout_add(16, _timer)
        return token

    def animate_spring(
        self,
        target: float,
        on_update: Callable[[float], None],
        on_done: Optional[Callable[[], None]] = None,
        stiffness: float = 280.0,
        damping: float = 19.0,
        mass: float = 0.85,
        enabled: bool = True,
    ) -> int:
        self.cancel()
        token = self._token
        start_val = self.value
        end_val = float(target)

        if not enabled or abs(end_val - start_val) < 1e-3:
            self.value = end_val
            self._velocity = 0.0
            on_update(end_val)
            if on_done is not None:
                on_done()
            return token

        if Adw is not None and self._widget.get_mapped():
            try:
                damping_ratio = min(1.5, max(0.3, damping / (2.0 * math.sqrt(stiffness * mass))))
                params = Adw.SpringParams.new(damping_ratio, mass, stiffness)
                anim_target = Adw.CallbackAnimationTarget.new(lambda v: self._apply_adw_value(token, v, on_update))
                anim = Adw.SpringAnimation.new(self._widget, start_val, end_val, params, anim_target)
                anim.set_initial_velocity(self._velocity)

                def _on_done(_anim: Any) -> None:
                    if self._token != token:
                        return
                    self.value = end_val
                    self._velocity = 0.0
                    self._adw_anim = None
                    if on_done is not None:
                        on_done()

                anim.connect("done", _on_done)
                self._adw_anim = anim
                anim.play()
                return token
            except Exception:
                pass

        last_us = [GLib.get_monotonic_time()]

        def _step_physics() -> bool:
            if self._token != token:
                return False
            now_us = GLib.get_monotonic_time()
            dt = min(0.032, max(0.004, (now_us - last_us[0]) / 1_000_000.0))
            last_us[0] = now_us

            # Sub-step for numerical stability across varying refresh rates.
            sub_dt = dt / 2.0
            for _ in range(2):
                force = -stiffness * (self.value - end_val) - damping * self._velocity
                accel = force / mass
                self._velocity += accel * sub_dt
                self.value += self._velocity * sub_dt

            settled = abs(self.value - end_val) < 0.08 and abs(self._velocity) < 0.25
            if settled:
                self.value = end_val
                self._velocity = 0.0
            on_update(self.value)
            if settled:
                self._tick_id = 0
                self._timeout_id = 0
                if on_done is not None:
                    on_done()
                return False
            return True

        if self._widget.get_mapped():
            self._tick_id = self._widget.add_tick_callback(lambda _w, _c: _step_physics())
        else:
            self._timeout_id = GLib.timeout_add(16, _step_physics)
        return token

    def _apply_adw_value(self, token: int, value: float, on_update: Callable[[float], None]) -> None:
        if self._token != token:
            return
        self.value = float(value)
        on_update(self.value)


class RevealerTransitionController:
    """Coordinates interruptible Gtk.Revealer show/hide with monotonic token guards."""

    def __init__(self, revealer: Gtk.Revealer) -> None:
        self._revealer = revealer
        self._token = 0
        self._done_timeout_id = 0

    @property
    def token(self) -> int:
        return self._token

    def cancel_pending(self) -> None:
        self._token += 1
        if self._done_timeout_id:
            GLib.source_remove(self._done_timeout_id)
            self._done_timeout_id = 0

    def reveal(
        self,
        show: bool,
        transition_type: Gtk.RevealerTransitionType,
        duration_ms: int,
        on_complete: Optional[Callable[[], None]] = None,
    ) -> int:
        self.cancel_pending()
        token = self._token
        self._revealer.set_transition_type(transition_type)
        self._revealer.set_transition_duration(max(0, int(duration_ms)))
        self._revealer.set_reveal_child(show)
        if on_complete is not None:
            wait = max(10, int(duration_ms)) if duration_ms > 10 else 10

            def _finish() -> bool:
                self._done_timeout_id = 0
                if self._token == token:
                    on_complete()
                return False

            self._done_timeout_id = GLib.timeout_add(wait, _finish)
        return token

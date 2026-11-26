#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <gio/gio.h>
#include <glib-unix.h>
#include <gtk/gtk.h>
#include <pango/pango.h>

#if defined(HAVE_X11) && defined(GDK_WINDOWING_X11)
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <gdk/x11/gdkx.h>
#define LAUNCHER_USE_X11 1
#else
#define LAUNCHER_USE_X11 0
#endif

/* =========================================================================
 * Constants
 * ========================================================================= */

#define PANEL_WIDTH 720
#define PANEL_HEIGHT 540
#define MAX_VISIBLE_STAGGER 8
#define ANIM_TICK_MS 30
#define ENTER_DURATION_MS 180
#define STAGGER_STEP_MS 12
#define STAGGER_ROW_FADE_MS 120
#define EXIT_DURATION_MS 110
#define ERROR_DURATION_MS 1800
#define FOCUS_GRACE_US (300 * 1000)
#define OPEN_SAFETY_TIMEOUT_MS 8000
#define SOCKET_CLIENT_TIMEOUT_MS 500
#define MAX_ACCEPTS_PER_TICK 16

/* 与 application/launcher/rank.go 同步 (§6) */
#define SCORE_EXACT_NAME 1000
#define SCORE_NAME_PREFIX_BASE 900
#define SCORE_NAME_PREFIX_MAX_PEN 50
#define SCORE_WORD_PREFIX 800
#define SCORE_ACRONYM 750
#define SCORE_SUBSTRING_BASE 700
#define SCORE_SUBSTRING_MAX_PEN 100
#define SCORE_ALIAS 650
#define SCORE_SUBSEQUENCE_BASE 600
#define SCORE_SUBSEQ_MAX_PEN 150
#define SCORE_SUBTITLE_ONLY 300
#define FRECENCY_BOOST_CAP 700
#define FRECENCY_EFFECTIVE_BOOST_CAP 150
#define FRECENCY_SCORE_CEILING (SCORE_EXACT_NAME - 1)

static const char *LAUNCHER_CSS =
    "window.launcher-window {\n"
    "  background-color: transparent;\n"
    "  background-image: none;\n"
    "  box-shadow: none;\n"
    "}\n"
    ".launcher-frame {\n"
    "  background: linear-gradient(158deg, rgba(16, 23, 39, 0.98) 0%, rgba(11, 16, 30, 0.99) 55%, rgba(8, 11, 21, 0.99) 100%);\n"
    "  border-radius: 18px;\n"
    "  border: 1px solid rgba(98, 237, 255, 0.36);\n"
    "  box-shadow: inset 0 1px 0 rgba(98, 237, 255, 0.24), inset 0 0 32px rgba(98, 237, 255, 0.05);\n"
    "  color: #e8edf8;\n"
    "}\n"
    ".launcher-header {\n"
    "  padding: 14px 20px 4px 20px;\n"
    "}\n"
    ".launcher-eyebrow {\n"
    "  font-family: monospace;\n"
    "  font-size: 11px;\n"
    "  font-weight: 700;\n"
    "  letter-spacing: 2.2px;\n"
    "  color: #62edff;\n"
    "}\n"
    ".launcher-eyebrow-dot {\n"
    "  min-width: 7px;\n"
    "  min-height: 7px;\n"
    "  border-radius: 999px;\n"
    "  background-color: #62edff;\n"
    "  box-shadow: 0 0 8px rgba(98, 237, 255, 0.65);\n"
    "}\n"
    ".launcher-count {\n"
    "  font-family: monospace;\n"
    "  font-size: 11px;\n"
    "  color: #8493ae;\n"
    "  padding: 2px 8px;\n"
    "  border-radius: 999px;\n"
    "  background-color: rgba(98, 237, 255, 0.07);\n"
    "  border: 1px solid rgba(98, 237, 255, 0.16);\n"
    "}\n"
    ".launcher-search-wrap {\n"
    "  padding: 4px 20px 10px 20px;\n"
    "  border-bottom: 1px solid rgba(98, 237, 255, 0.14);\n"
    "}\n"
    "entry.launcher-search {\n"
    "  font-size: 20pt;\n"
    "  font-weight: 500;\n"
    "  color: #e8edf8;\n"
    "  caret-color: #62edff;\n"
    "  background: transparent;\n"
    "  background-color: transparent;\n"
    "  border: none;\n"
    "  box-shadow: none;\n"
    "  outline: none;\n"
    "  padding: 4px 0;\n"
    "  min-height: 40px;\n"
    "}\n"
    "entry.launcher-search:focus-within {\n"
    "  outline: none;\n"
    "  box-shadow: none;\n"
    "  border: none;\n"
    "}\n"
    "entry.launcher-search > image {\n"
    "  color: #62edff;\n"
    "  margin-right: 10px;\n"
    "  opacity: 0.85;\n"
    "}\n"
    "entry.launcher-search > text > placeholder {\n"
    "  color: #5c6c8a;\n"
    "}\n"
    ".launcher-inline-error {\n"
    "  font-size: 12px;\n"
    "  color: #ff8ca0;\n"
    "  padding: 4px 20px 2px 20px;\n"
    "}\n"
    "scrolledwindow.launcher-scroll {\n"
    "  background: transparent;\n"
    "}\n"
    "scrolledwindow.launcher-scroll > viewport {\n"
    "  background: transparent;\n"
    "}\n"
    "list.launcher-list {\n"
    "  background: transparent;\n"
    "  padding: 6px 12px;\n"
    "}\n"
    "list.launcher-list > row.launcher-row {\n"
    "  background: transparent;\n"
    "  border-radius: 12px;\n"
    "  border: 1px solid transparent;\n"
    "  padding: 5px 12px;\n"
    "  margin: 1px 0;\n"
    "  transition: background-color 120ms ease, border-color 120ms ease;\n"
    "}\n"
    "list.launcher-list > row.launcher-row:hover {\n"
    "  background: rgba(98, 237, 255, 0.08);\n"
    "  border: 1px solid rgba(98, 237, 255, 0.18);\n"
    "}\n"
    "list.launcher-list > row.launcher-row:selected {\n"
    "  background: linear-gradient(95deg, rgba(98, 237, 255, 0.18) 0%, rgba(177, 139, 255, 0.14) 100%);\n"
    "  border: 1px solid rgba(98, 237, 255, 0.42);\n"
    "}\n"
    "list.launcher-list > row.launcher-row:selected:hover {\n"
    "  background: linear-gradient(95deg, rgba(98, 237, 255, 0.22) 0%, rgba(177, 139, 255, 0.16) 100%);\n"
    "  border: 1px solid rgba(98, 237, 255, 0.50);\n"
    "}\n"
    ".row-icon-wrap {\n"
    "  min-width: 40px;\n"
    "  min-height: 40px;\n"
    "  border-radius: 10px;\n"
    "  background-color: rgba(255, 255, 255, 0.05);\n"
    "  border: 1px solid rgba(255, 255, 255, 0.07);\n"
    "}\n"
    ".row-name {\n"
    "  font-size: 15pt;\n"
    "  font-weight: 600;\n"
    "  color: #e8edf8;\n"
    "}\n"
    ".row-subtitle {\n"
    "  font-size: 12pt;\n"
    "  color: #8493ae;\n"
    "}\n"
    ".row-return {\n"
    "  font-family: monospace;\n"
    "  font-size: 12px;\n"
    "  font-weight: 700;\n"
    "  color: #62edff;\n"
    "  background-color: rgba(98, 237, 255, 0.14);\n"
    "  border: 1px solid rgba(98, 237, 255, 0.40);\n"
    "  border-radius: 7px;\n"
    "  padding: 2px 8px;\n"
    "  opacity: 0;\n"
    "  transition: opacity 120ms ease;\n"
    "}\n"
    "list.launcher-list > row.launcher-row:selected .row-return {\n"
    "  opacity: 1;\n"
    "}\n"
    ".launcher-empty-title {\n"
    "  font-size: 15px;\n"
    "  font-weight: 600;\n"
    "  color: #a9b6cf;\n"
    "}\n"
    ".launcher-empty-hint {\n"
    "  font-size: 12px;\n"
    "  color: #687894;\n"
    "}\n"
    ".launcher-footer {\n"
    "  padding: 8px 20px 10px 20px;\n"
    "  border-top: 1px solid rgba(98, 237, 255, 0.13);\n"
    "}\n"
    ".launcher-kbd {\n"
    "  font-family: monospace;\n"
    "  font-size: 11px;\n"
    "  font-weight: 600;\n"
    "  color: #c7d5ec;\n"
    "  background-color: rgba(255, 255, 255, 0.06);\n"
    "  border: 1px solid rgba(132, 147, 174, 0.28);\n"
    "  border-radius: 5px;\n"
    "  padding: 1px 6px;\n"
    "}\n"
    ".launcher-kbd-label {\n"
    "  font-size: 11px;\n"
    "  color: #8493ae;\n"
    "  margin-right: 10px;\n"
    "}\n"
    ".launcher-status-note {\n"
    "  font-size: 11px;\n"
    "  color: #8493ae;\n"
    "}\n";

/* =========================================================================
 * Data Structures
 * ========================================================================= */

typedef enum {
  MATCH_NONE = 0,
  MATCH_NAME = 1,
  MATCH_ALIAS = 2,
  MATCH_SUBTITLE = 3
} MatchSource;

typedef struct {
  char *id;
  char *name;
  char *subtitle;
  char *icon;
  char *kind;
  char *path;
  gboolean terminal;
  char **aliases;
  gsize alias_count;
  int boost;
  gsize catalog_index;
} AppItem;

typedef struct {
  const AppItem *app;
  int score;
  MatchSource source;
  gboolean *matched_runes; /* length == name_rune_len when source == MATCH_NAME */
  gsize matched_rune_len;
} FilteredItem;

typedef enum {
  ANIM_NONE = 0,
  ANIM_ENTER = 1,
  ANIM_EXIT = 2
} AnimMode;

typedef struct {
  GtkApplication *app;
  GtkWidget *window;
  GtkWidget *revealer;
  GtkWidget *frame;
  GtkWidget *search_entry;
  GtkWidget *count_label;
  GtkWidget *inline_error_label;
  GtkWidget *content_stack;
  GtkWidget *scrolled;
  GtkWidget *list_box;
  GtkWidget *empty_title_label;
  GtkWidget *status_note_label;

  GPtrArray *apps;         /* AppItem* */
  GPtrArray *staging_apps; /* AppItem* accumulated until END */
  GPtrArray *filtered;     /* FilteredItem* */
  int selected_index;
  gboolean syncing_selection;

  /* Animation state */
  AnimMode anim_mode;
  gint64 anim_start_us;
  guint anim_timer_id;
  gint64 last_show_us;
  int target_x;
  int target_y;
  gboolean has_x11_pos;
  gboolean is_visible;

  /* Row stagger widgets (borrowed refs owned by list_box) */
  GtkWidget *stagger_rows[MAX_VISIBLE_STAGGER];
  int stagger_count;
  gint64 stagger_start_us;

  /* Inline error auto-hide timer */
  guint error_timer_id;

  /* Pending open hide fallback timer */
  guint pending_open_timer_id;
  char *pending_open_name;

  /* Stdin / control socket / X11 grab */
  GIOChannel *stdin_channel;
  guint stdin_watch_id;
  GString *stdin_buf;

  int lock_fd;
  int sock_fd;
  gboolean sock_bound;
  char *sock_path;
  GIOChannel *sock_channel;
  guint sock_watch_id;

#if LAUNCHER_USE_X11
  Display *grab_dpy;
  KeyCode space_keycode;
  GIOChannel *x11_channel;
  guint x11_watch_id;
  gboolean x11_grabbed;
#endif

  gboolean quit_sent;
  gboolean shutting_down;
} LauncherState;

/* Forward declarations */
static void launcher_show(LauncherState *st);
static void launcher_hide(LauncherState *st, gboolean notify_daemon);
static void launcher_toggle(LauncherState *st);
static void launcher_quit(LauncherState *st, gboolean notify_daemon);
static void rebuild_filtered_list(LauncherState *st, gboolean animate_rows,
                                  gboolean preserve_selection);

/* =========================================================================
 * Protocol Helpers (stdio)
 * ========================================================================= */

static void write_daemon_line(const char *line) {
  if (!line) {
    return;
  }
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

#if LAUNCHER_USE_X11
static void write_daemon_status(const char *message) {
  if (!message || message[0] == '\0') {
    write_daemon_line("status\t");
    return;
  }
  char *b64 = g_base64_encode((const guchar *)message, strlen(message));
  char *line = g_strdup_printf("status\t%s", b64);
  write_daemon_line(line);
  g_free(line);
  g_free(b64);
}
#endif

static char *decode_base64_utf8(const char *b64) {
  if (!b64 || b64[0] == '\0') {
    return g_strdup("");
  }
  gsize out_len = 0;
  guchar *raw = g_base64_decode(b64, &out_len);
  if (!raw) {
    return g_strdup("");
  }
  char *str = g_malloc(out_len + 1);
  if (out_len > 0) {
    memcpy(str, raw, out_len);
  }
  str[out_len] = '\0';
  g_free(raw);
  if (!g_utf8_validate(str, (gssize)out_len, NULL)) {
    char *valid = g_utf8_make_valid(str, (gssize)out_len);
    g_free(str);
    return valid;
  }
  return str;
}

/* =========================================================================
 * App & Filter Memory Management
 * ========================================================================= */

static void app_item_free(gpointer data) {
  AppItem *item = (AppItem *)data;
  if (!item) {
    return;
  }
  g_free(item->id);
  g_free(item->name);
  g_free(item->subtitle);
  g_free(item->icon);
  g_free(item->kind);
  g_free(item->path);
  if (item->aliases) {
    for (gsize i = 0; i < item->alias_count; i++) {
      g_free(item->aliases[i]);
    }
    g_free(item->aliases);
  }
  g_free(item);
}

static void filtered_item_free(gpointer data) {
  FilteredItem *fi = (FilteredItem *)data;
  if (!fi) {
    return;
  }
  g_free(fi->matched_runes);
  g_free(fi);
}

/* =========================================================================
 * §6 Search & Ranking Engine (synced with application/launcher/rank.go)
 * ========================================================================= */

static char *normalize_query_utf8(const char *s) {
  if (!s) {
    return g_strdup("");
  }
  char *trimmed = g_strdup(s);
  g_strstrip(trimmed);
  if (trimmed[0] == '\0') {
    return trimmed;
  }
  char *lower = g_utf8_strdown(trimmed, -1);
  g_free(trimmed);
  return lower;
}

static gboolean is_word_separator(gunichar r) {
  return g_unichar_isspace(r) || r == '-' || r == '_' || r == '/';
}

static gboolean has_rune_prefix(const gunichar *text, gsize tlen,
                                const gunichar *prefix, gsize plen) {
  if (plen == 0 || plen > tlen) {
    return FALSE;
  }
  for (gsize i = 0; i < plen; i++) {
    if (text[i] != prefix[i]) {
      return FALSE;
    }
  }
  return TRUE;
}

static gssize index_runes(const gunichar *text, gsize tlen,
                          const gunichar *needle, gsize nlen) {
  if (nlen == 0 || nlen > tlen) {
    return -1;
  }
  gsize limit = tlen - nlen;
  for (gsize i = 0; i <= limit; i++) {
    gboolean ok = TRUE;
    for (gsize j = 0; j < nlen; j++) {
      if (text[i + j] != needle[j]) {
        ok = FALSE;
        break;
      }
    }
    if (ok) {
      return (gssize)i;
    }
  }
  return -1;
}

static gboolean subsequence_match(const gunichar *text, gsize tlen,
                                  const gunichar *query, gsize qlen,
                                  int *out_gaps, gsize *out_positions) {
  if (qlen == 0 || qlen > tlen) {
    return FALSE;
  }
  gsize qi = 0;
  gssize prev = -1;
  int gaps = 0;
  for (gsize ti = 0; ti < tlen; ti++) {
    if (text[ti] == query[qi]) {
      if (prev >= 0) {
        gaps += (int)(ti - (gsize)prev - 1);
      }
      if (out_positions) {
        out_positions[qi] = ti;
      }
      prev = (gssize)ti;
      qi++;
      if (qi == qlen) {
        if (out_gaps) {
          *out_gaps = gaps;
        }
        return TRUE;
      }
    }
  }
  return FALSE;
}

typedef struct {
  gsize start;
  gsize len;
} WordSpan;

static gsize split_words(const gunichar *runes, gsize len, WordSpan *out_spans,
                         gsize max_spans) {
  gsize count = 0;
  gssize start = -1;
  for (gsize i = 0; i < len; i++) {
    if (is_word_separator(runes[i])) {
      if (start >= 0 && count < max_spans) {
        out_spans[count].start = (gsize)start;
        out_spans[count].len = i - (gsize)start;
        count++;
      }
      start = -1;
      continue;
    }
    if (start < 0) {
      start = (gssize)i;
    }
  }
  if (start >= 0 && count < max_spans) {
    out_spans[count].start = (gsize)start;
    out_spans[count].len = len - (gsize)start;
    count++;
  }
  return count;
}

static gboolean alias_matches_query(const char *alias_raw,
                                    const gunichar *q_runes, gsize q_len) {
  char *norm = normalize_query_utf8(alias_raw);
  if (norm[0] == '\0') {
    g_free(norm);
    return FALSE;
  }
  glong a_len_l = 0;
  gunichar *a_runes = g_utf8_to_ucs4_fast(norm, -1, &a_len_l);
  g_free(norm);
  if (!a_runes || a_len_l <= 0) {
    g_free(a_runes);
    return FALSE;
  }
  gsize a_len = (gsize)a_len_l;
  gboolean matched = FALSE;
  if (has_rune_prefix(a_runes, a_len, q_runes, q_len) ||
      index_runes(a_runes, a_len, q_runes, q_len) >= 0) {
    matched = TRUE;
  } else {
    WordSpan spans[64];
    gsize wcount = split_words(a_runes, a_len, spans, G_N_ELEMENTS(spans));
    if (wcount > 0) {
      gunichar initials[64];
      for (gsize i = 0; i < wcount; i++) {
        if (has_rune_prefix(a_runes + spans[i].start, spans[i].len, q_runes,
                            q_len)) {
          matched = TRUE;
          break;
        }
        initials[i] = a_runes[spans[i].start];
      }
      if (!matched && index_runes(initials, wcount, q_runes, q_len) >= 0) {
        matched = TRUE;
      }
    }
    if (!matched) {
      matched = subsequence_match(a_runes, a_len, q_runes, q_len, NULL, NULL);
    }
  }
  g_free(a_runes);
  return matched;
}

static void mark_range(gboolean *mask, gsize mask_len, gsize start, gsize len) {
  for (gsize i = 0; i < len && (start + i) < mask_len; i++) {
    mask[start + i] = TRUE;
  }
}

static int effective_boost(int base_score, int raw_boost) {
  if (raw_boost <= 0) {
    return 0;
  }
  int headroom = FRECENCY_SCORE_CEILING - base_score;
  if (headroom <= 0) {
    return 0;
  }
  int eff = raw_boost;
  if (eff > FRECENCY_EFFECTIVE_BOOST_CAP) {
    eff = FRECENCY_EFFECTIVE_BOOST_CAP;
  }
  if (eff > headroom) {
    eff = headroom;
  }
  return eff;
}

static FilteredItem *score_app_item(const AppItem *app, const char *q_norm,
                                    const gunichar *q_runes, gsize q_len) {
  int best = 0;
  MatchSource best_source = MATCH_NONE;
  gboolean *best_mask = NULL;
  gsize name_rune_len = 0;

  /* Map each character of app->name (not name_lower) to its lowercased rune
   * so match positions align 1:1 with original display runes. */
  glong orig_len_l = 0;
  gunichar *orig_runes = g_utf8_to_ucs4_fast(app->name, -1, &orig_len_l);
  gunichar *n_runes = NULL;
  if (orig_runes && orig_len_l > 0) {
    /* Trim leading/trailing spaces on normalized name matching rank.go */
    gsize start_trim = 0;
    gsize end_trim = (gsize)orig_len_l;
    while (start_trim < end_trim && g_unichar_isspace(orig_runes[start_trim])) {
      start_trim++;
    }
    while (end_trim > start_trim &&
           g_unichar_isspace(orig_runes[end_trim - 1])) {
      end_trim--;
    }
    gsize trimmed_len = end_trim - start_trim;
    name_rune_len = (gsize)orig_len_l;
    if (trimmed_len > 0) {
      n_runes = g_new(gunichar, trimmed_len);
      for (gsize i = 0; i < trimmed_len; i++) {
        n_runes[i] = g_unichar_tolower(orig_runes[start_trim + i]);
      }

      /* 1. Exact name match (1000) */
      if (trimmed_len == q_len &&
          has_rune_prefix(n_runes, trimmed_len, q_runes, q_len)) {
        best = SCORE_EXACT_NAME;
        best_source = MATCH_NAME;
        g_free(best_mask);
        best_mask = g_new0(gboolean, name_rune_len);
        mark_range(best_mask, name_rune_len, start_trim, trimmed_len);
      }

      /* 2. Name prefix (900 - min(nameLen - queryLen, 50)) */
      if (has_rune_prefix(n_runes, trimmed_len, q_runes, q_len)) {
        int pen = (int)(trimmed_len - q_len);
        if (pen > SCORE_NAME_PREFIX_MAX_PEN) {
          pen = SCORE_NAME_PREFIX_MAX_PEN;
        }
        if (pen < 0) {
          pen = 0;
        }
        int sc = SCORE_NAME_PREFIX_BASE - pen;
        if (sc > best) {
          best = sc;
          best_source = MATCH_NAME;
          g_free(best_mask);
          best_mask = g_new0(gboolean, name_rune_len);
          mark_range(best_mask, name_rune_len, start_trim, q_len);
        }
      }

      /* 3 & 4. Word prefix (800) and Acronym (750) */
      WordSpan spans[64];
      gsize wcount =
          split_words(n_runes, trimmed_len, spans, G_N_ELEMENTS(spans));
      if (wcount > 0) {
        gunichar initials[64];
        for (gsize i = 0; i < wcount; i++) {
          initials[i] = n_runes[spans[i].start];
          if (has_rune_prefix(n_runes + spans[i].start, spans[i].len, q_runes,
                              q_len)) {
            if (SCORE_WORD_PREFIX > best) {
              best = SCORE_WORD_PREFIX;
              best_source = MATCH_NAME;
              g_free(best_mask);
              best_mask = g_new0(gboolean, name_rune_len);
              mark_range(best_mask, name_rune_len, start_trim + spans[i].start,
                         q_len);
            }
          }
        }
        gssize acr_idx = index_runes(initials, wcount, q_runes, q_len);
        if (acr_idx >= 0 && SCORE_ACRONYM > best) {
          best = SCORE_ACRONYM;
          best_source = MATCH_NAME;
          g_free(best_mask);
          best_mask = g_new0(gboolean, name_rune_len);
          for (gsize k = 0; k < q_len && ((gsize)acr_idx + k) < wcount; k++) {
            gsize pos = start_trim + spans[(gsize)acr_idx + k].start;
            if (pos < name_rune_len) {
              best_mask[pos] = TRUE;
            }
          }
        }
      }

      /* 5. Substring (700 - min(pos, 100)) */
      gssize sub_idx = index_runes(n_runes, trimmed_len, q_runes, q_len);
      if (sub_idx >= 0) {
        int pen = (int)sub_idx;
        if (pen > SCORE_SUBSTRING_MAX_PEN) {
          pen = SCORE_SUBSTRING_MAX_PEN;
        }
        int sc = SCORE_SUBSTRING_BASE - pen;
        if (sc > best) {
          best = sc;
          best_source = MATCH_NAME;
          g_free(best_mask);
          best_mask = g_new0(gboolean, name_rune_len);
          mark_range(best_mask, name_rune_len, start_trim + (gsize)sub_idx,
                     q_len);
        }
      }

      /* 6. Subsequence (600 - min(gaps, 150)) */
      gsize *positions = g_new(gsize, q_len);
      int gaps = 0;
      if (subsequence_match(n_runes, trimmed_len, q_runes, q_len, &gaps,
                            positions)) {
        int pen = gaps;
        if (pen > SCORE_SUBSEQ_MAX_PEN) {
          pen = SCORE_SUBSEQ_MAX_PEN;
        }
        int sc = SCORE_SUBSEQUENCE_BASE - pen;
        if (sc > best) {
          best = sc;
          best_source = MATCH_NAME;
          g_free(best_mask);
          best_mask = g_new0(gboolean, name_rune_len);
          for (gsize k = 0; k < q_len; k++) {
            gsize pos = start_trim + positions[k];
            if (pos < name_rune_len) {
              best_mask[pos] = TRUE;
            }
          }
        }
      }
      g_free(positions);
    }
  }
  g_free(n_runes);
  g_free(orig_runes);

  /* 6b. Alias match (flat 650, max with name score; do NOT highlight name!) */
  for (gsize i = 0; i < app->alias_count; i++) {
    if (alias_matches_query(app->aliases[i], q_runes, q_len)) {
      if (SCORE_ALIAS > best) {
        best = SCORE_ALIAS;
        best_source = MATCH_ALIAS;
        g_free(best_mask);
        best_mask = NULL;
      }
      break;
    }
  }

  /* 7. Subtitle-only match (300) */
  if (best == 0 && app->subtitle && app->subtitle[0] != '\0') {
    char *sub_norm = normalize_query_utf8(app->subtitle);
    if (sub_norm[0] != '\0' && strstr(sub_norm, q_norm) != NULL) {
      best = SCORE_SUBTITLE_ONLY;
      best_source = MATCH_SUBTITLE;
    }
    g_free(sub_norm);
  }

  if (best <= 0) {
    g_free(best_mask);
    return NULL;
  }

  FilteredItem *fi = g_new0(FilteredItem, 1);
  fi->app = app;
  fi->score = best + effective_boost(best, app->boost);
  fi->source = best_source;
  if (best_source == MATCH_NAME && best_mask) {
    fi->matched_runes = best_mask;
    fi->matched_rune_len = name_rune_len;
  } else {
    g_free(best_mask);
  }
  return fi;
}

static gint compare_filtered_items(gconstpointer a_ptr, gconstpointer b_ptr) {
  const FilteredItem *a = *(const FilteredItem *const *)a_ptr;
  const FilteredItem *b = *(const FilteredItem *const *)b_ptr;
  if (a->score != b->score) {
    return (a->score > b->score) ? -1 : 1;
  }
  if (a->app->catalog_index != b->app->catalog_index) {
    return (a->app->catalog_index < b->app->catalog_index) ? -1 : 1;
  }
  return strcmp(a->app->id, b->app->id);
}

static char *build_highlighted_name_markup(const FilteredItem *fi) {
  const char *name = fi->app->name ? fi->app->name : "";
  if (fi->source != MATCH_NAME || !fi->matched_runes ||
      fi->matched_rune_len == 0) {
    return g_markup_escape_text(name, -1);
  }
  GString *out = g_string_sized_new(strlen(name) + 64);
  const char *p = name;
  gsize idx = 0;
  gboolean in_span = FALSE;
  while (*p != '\0') {
    const char *next = g_utf8_next_char(p);
    gboolean hi = (idx < fi->matched_rune_len) ? fi->matched_runes[idx] : FALSE;
    if (hi && !in_span) {
      g_string_append(out, "<span foreground=\"#62edff\" weight=\"bold\">");
      in_span = TRUE;
    } else if (!hi && in_span) {
      g_string_append(out, "</span>");
      in_span = FALSE;
    }
    char *esc = g_markup_escape_text(p, (gssize)(next - p));
    g_string_append(out, esc);
    g_free(esc);
    p = next;
    idx++;
  }
  if (in_span) {
    g_string_append(out, "</span>");
  }
  return g_string_free(out, FALSE);
}

/* =========================================================================
 * Icon Resolution
 * ========================================================================= */

static GtkWidget *create_app_icon_widget(const char *icon_spec) {
  GtkWidget *img = NULL;
  if (icon_spec && icon_spec[0] == '/' &&
      g_file_test(icon_spec, G_FILE_TEST_IS_REGULAR)) {
    img = gtk_image_new_from_file(icon_spec);
  } else {
    GdkDisplay *display = gdk_display_get_default();
    GtkIconTheme *theme =
        display ? gtk_icon_theme_get_for_display(display) : NULL;
    const char *fallbacks[] = {"application-x-executable", NULL};
    const char *lookup_name =
        (icon_spec && icon_spec[0] != '\0') ? icon_spec
                                            : "application-x-executable";
    if (theme) {
      GtkIconPaintable *paintable = gtk_icon_theme_lookup_icon(
          theme, lookup_name, fallbacks, 48, 1, GTK_TEXT_DIR_NONE, 0);
      if (paintable) {
        img = gtk_image_new_from_paintable(GDK_PAINTABLE(paintable));
        g_object_unref(paintable);
      }
    }
    if (!img) {
      img = gtk_image_new_from_icon_name("application-x-executable");
    }
  }
  gtk_image_set_pixel_size(GTK_IMAGE(img), 36);
  gtk_widget_set_size_request(img, 36, 36);
  gtk_widget_set_hexpand(img, FALSE);
  gtk_widget_set_vexpand(img, FALSE);
  gtk_widget_set_halign(img, GTK_ALIGN_CENTER);
  gtk_widget_set_valign(img, GTK_ALIGN_CENTER);

  GtkWidget *wrap = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_add_css_class(wrap, "row-icon-wrap");
  gtk_widget_set_size_request(wrap, 40, 40);
  gtk_widget_set_overflow(wrap, GTK_OVERFLOW_HIDDEN);
  gtk_widget_set_hexpand(wrap, FALSE);
  gtk_widget_set_vexpand(wrap, FALSE);
  gtk_widget_set_halign(wrap, GTK_ALIGN_START);
  gtk_widget_set_valign(wrap, GTK_ALIGN_CENTER);
  gtk_widget_set_margin_start(img, 2);
  gtk_widget_set_margin_end(img, 2);
  gtk_box_append(GTK_BOX(wrap), img);
  return wrap;
}

/* =========================================================================
 * Inline Error & Status Helpers
 * ========================================================================= */

static gboolean clear_inline_error_cb(gpointer user_data) {
  LauncherState *st = (LauncherState *)user_data;
  st->error_timer_id = 0;
  gtk_label_set_text(GTK_LABEL(st->inline_error_label), "");
  gtk_widget_set_visible(st->inline_error_label, FALSE);
  return G_SOURCE_REMOVE;
}

static void show_inline_error(LauncherState *st, const char *message) {
  if (st->error_timer_id != 0) {
    g_source_remove(st->error_timer_id);
    st->error_timer_id = 0;
  }
  if (!message || message[0] == '\0') {
    gtk_label_set_text(GTK_LABEL(st->inline_error_label), "");
    gtk_widget_set_visible(st->inline_error_label, FALSE);
    return;
  }
  gtk_label_set_text(GTK_LABEL(st->inline_error_label), message);
  gtk_widget_set_visible(st->inline_error_label, TRUE);
  st->error_timer_id =
      g_timeout_add(ERROR_DURATION_MS, clear_inline_error_cb, st);
}

/* =========================================================================
 * X11 Positioning, Focus, and Global Hotkey Grab
 * ========================================================================= */

#if LAUNCHER_USE_X11
static volatile gboolean g_x11_bad_access = FALSE;

static int x11_grab_error_handler(Display *dpy, XErrorEvent *ev) {
  (void)dpy;
  if (ev && ev->error_code == BadAccess) {
    g_x11_bad_access = TRUE;
  }
  return 0;
}

static int x11_focus_error_handler(Display *dpy, XErrorEvent *ev) {
  (void)dpy;
  (void)ev;
  return 0;
}

static void x11_compute_target_position(LauncherState *st) {
  st->has_x11_pos = FALSE;
  if (!st->grab_dpy) {
    return;
  }
  int screen = DefaultScreen(st->grab_dpy);
  int scr_w = DisplayWidth(st->grab_dpy, screen);
  int scr_h = DisplayHeight(st->grab_dpy, screen);
  int mon_x = 0;
  int mon_y = 0;
  int mon_w = scr_w;
  int mon_h = scr_h;

  /* Pick monitor containing cursor via GDK if available */
  Window root = DefaultRootWindow(st->grab_dpy);
  Window root_ret = None;
  Window child_ret = None;
  int ptr_x = scr_w / 2;
  int ptr_y = scr_h / 2;
  int win_x = 0;
  int win_y = 0;
  unsigned int mask_ret = 0;
  XQueryPointer(st->grab_dpy, root, &root_ret, &child_ret, &ptr_x, &ptr_y,
                &win_x, &win_y, &mask_ret);

  GdkDisplay *gdk_dpy = gdk_display_get_default();
  if (gdk_dpy) {
    GListModel *monitors = gdk_display_get_monitors(gdk_dpy);
    if (monitors) {
      guint n = g_list_model_get_n_items(monitors);
      for (guint i = 0; i < n; i++) {
        GdkMonitor *mon = GDK_MONITOR(g_list_model_get_item(monitors, i));
        if (!mon) {
          continue;
        }
        GdkRectangle geom;
        gdk_monitor_get_geometry(mon, &geom);
        g_object_unref(mon);
        if (ptr_x >= geom.x && ptr_x < geom.x + geom.width &&
            ptr_y >= geom.y && ptr_y < geom.y + geom.height) {
          mon_x = geom.x;
          mon_y = geom.y;
          mon_w = geom.width;
          mon_h = geom.height;
          break;
        }
      }
    }
  }

  int tx = mon_x + (mon_w - PANEL_WIDTH) / 2;
  int ty = mon_y + (mon_h * 18) / 100;
  if (tx < mon_x) {
    tx = mon_x;
  }
  if (ty + PANEL_HEIGHT > mon_y + mon_h) {
    ty = mon_y + (mon_h - PANEL_HEIGHT) / 2;
  }
  if (ty < mon_y) {
    ty = mon_y;
  }
  st->target_x = tx;
  st->target_y = ty;
  st->has_x11_pos = TRUE;
}

static void x11_apply_window_position(LauncherState *st, int dy,
                                      gboolean raise_and_focus) {
  if (!st->has_x11_pos || !st->window) {
    return;
  }
  GtkNative *native = GTK_NATIVE(st->window);
  GdkSurface *surface = native ? gtk_native_get_surface(native) : NULL;
  if (!surface) {
    return;
  }
  G_GNUC_BEGIN_IGNORE_DEPRECATIONS
  if (!GDK_IS_X11_SURFACE(surface)) {
    return;
  }
  GdkDisplay *gdk_dpy = gdk_surface_get_display(surface);
  if (!gdk_dpy || !GDK_IS_X11_DISPLAY(gdk_dpy)) {
    return;
  }
  Display *xdpy = gdk_x11_display_get_xdisplay(gdk_dpy);
  Window xid = gdk_x11_surface_get_xid(surface);
  G_GNUC_END_IGNORE_DEPRECATIONS
  if (!xdpy || xid == None) {
    return;
  }
  XMoveWindow(xdpy, xid, st->target_x, st->target_y + dy);
  if (raise_and_focus) {
    Atom wm_state = XInternAtom(xdpy, "_NET_WM_STATE", False);
    Atom state_above = XInternAtom(xdpy, "_NET_WM_STATE_ABOVE", False);
    Atom state_skip_tb = XInternAtom(xdpy, "_NET_WM_STATE_SKIP_TASKBAR", False);
    Atom state_skip_pg = XInternAtom(xdpy, "_NET_WM_STATE_SKIP_PAGER", False);
    Window root = DefaultRootWindow(xdpy);

    XEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.xclient.type = ClientMessage;
    ev.xclient.window = xid;
    ev.xclient.message_type = wm_state;
    ev.xclient.format = 32;
    ev.xclient.data.l[0] = 1; /* _NET_WM_STATE_ADD */
    ev.xclient.data.l[1] = (long)state_above;
    ev.xclient.data.l[2] = (long)state_skip_tb;
    XSendEvent(xdpy, root, False,
               SubstructureRedirectMask | SubstructureNotifyMask, &ev);

    ev.xclient.data.l[1] = (long)state_skip_pg;
    ev.xclient.data.l[2] = 0;
    XSendEvent(xdpy, root, False,
               SubstructureRedirectMask | SubstructureNotifyMask, &ev);

    XRaiseWindow(xdpy, xid);

    Atom net_active = XInternAtom(xdpy, "_NET_ACTIVE_WINDOW", False);
    memset(&ev, 0, sizeof(ev));
    ev.xclient.type = ClientMessage;
    ev.xclient.window = xid;
    ev.xclient.message_type = net_active;
    ev.xclient.format = 32;
    ev.xclient.data.l[0] = 1;
    ev.xclient.data.l[1] = CurrentTime;
    XSendEvent(xdpy, root, False,
               SubstructureRedirectMask | SubstructureNotifyMask, &ev);

    XFlush(xdpy);

    /* Fallback direct focus for WM-less X11 (e.g. bare Xvfb) on our dedicated
     * grab_dpy connection so we never disturb GDK's X11 error trap. */
    if (st->grab_dpy) {
      XErrorHandler prev = XSetErrorHandler(x11_focus_error_handler);
      XSetInputFocus(st->grab_dpy, xid, RevertToPointerRoot, CurrentTime);
      XSync(st->grab_dpy, False);
      XSetErrorHandler(prev);
    }
  }
  XFlush(xdpy);
}

static gboolean x11_grab_io_cb(GIOChannel *source, GIOCondition cond,
                               gpointer user_data) {
  (void)source;
  LauncherState *st = (LauncherState *)user_data;
  if (!st || !st->grab_dpy) {
    return G_SOURCE_REMOVE;
  }
  if (cond & (G_IO_ERR | G_IO_HUP)) {
    return G_SOURCE_REMOVE;
  }
  while (XPending(st->grab_dpy) > 0) {
    XEvent ev;
    XNextEvent(st->grab_dpy, &ev);
    if (ev.type == KeyPress && ev.xkey.keycode == st->space_keycode &&
        (ev.xkey.state & Mod1Mask) != 0) {
      launcher_toggle(st);
    }
  }
  return G_SOURCE_CONTINUE;
}

static void x11_setup_hotkey(LauncherState *st) {
  const char *display_env = g_getenv("DISPLAY");
  if (!display_env || display_env[0] == '\0') {
    return;
  }
  st->grab_dpy = XOpenDisplay(NULL);
  if (!st->grab_dpy) {
    const char *msg =
        "无法连接 X11 Display，跳过 Alt+Space 抓取，可用 aih launch toggle 绑定";
    write_daemon_status(msg);
    return;
  }
  Window root = DefaultRootWindow(st->grab_dpy);
  st->space_keycode = XKeysymToKeycode(st->grab_dpy, XK_space);
  if (st->space_keycode == 0) {
    const char *msg =
        "无法解析 Space 键码，跳过 Alt+Space 抓取，可用 aih launch toggle 绑定";
    write_daemon_status(msg);
    return;
  }

  g_x11_bad_access = FALSE;
  XErrorHandler prev = XSetErrorHandler(x11_grab_error_handler);
  XGrabKey(st->grab_dpy, st->space_keycode, Mod1Mask, root, False,
           GrabModeAsync, GrabModeAsync);
  XSync(st->grab_dpy, False);

  if (g_x11_bad_access) {
    XSetErrorHandler(prev);
    const char *msg = "Alt+Space 被窗口管理器占用，可用 aih launch toggle 绑定";
    write_daemon_status(msg);
    gtk_label_set_text(GTK_LABEL(st->status_note_label),
                       "Alt+Space 被占用 · 用 aih launch toggle");
    gtk_widget_set_visible(st->status_note_label, TRUE);
    return;
  }

  /* Also grab with CapsLock / NumLock combinations cleanly */
  const unsigned int extra_masks[] = {
      Mod1Mask | LockMask,
      Mod1Mask | Mod2Mask,
      Mod1Mask | LockMask | Mod2Mask,
  };
  for (gsize i = 0; i < G_N_ELEMENTS(extra_masks); i++) {
    XGrabKey(st->grab_dpy, st->space_keycode, extra_masks[i], root, False,
             GrabModeAsync, GrabModeAsync);
  }
  XSync(st->grab_dpy, False);
  XSetErrorHandler(prev);

  XSelectInput(st->grab_dpy, root, KeyPressMask);
  XFlush(st->grab_dpy);

  st->x11_grabbed = TRUE;
  write_daemon_status("");

  int xfd = ConnectionNumber(st->grab_dpy);
  st->x11_channel = g_io_channel_unix_new(xfd);
  st->x11_watch_id =
      g_io_add_watch(st->x11_channel, G_IO_IN | G_IO_ERR | G_IO_HUP,
                     x11_grab_io_cb, st);
}

static void x11_cleanup_hotkey(LauncherState *st) {
  if (st->x11_watch_id != 0) {
    g_source_remove(st->x11_watch_id);
    st->x11_watch_id = 0;
  }
  if (st->x11_channel) {
    g_io_channel_unref(st->x11_channel);
    st->x11_channel = NULL;
  }
  if (st->grab_dpy) {
    if (st->x11_grabbed && st->space_keycode != 0) {
      Window root = DefaultRootWindow(st->grab_dpy);
      XUngrabKey(st->grab_dpy, st->space_keycode, AnyModifier, root);
      XSync(st->grab_dpy, False);
    }
    XCloseDisplay(st->grab_dpy);
    st->grab_dpy = NULL;
    st->x11_grabbed = FALSE;
  }
}
#endif

/* =========================================================================
 * Animations (180ms enter + 12ms row stagger, 110ms exit, 30ms tick)
 * ========================================================================= */

static double ease_out_cubic(double t) {
  if (t <= 0.0) {
    return 0.0;
  }
  if (t >= 1.0) {
    return 1.0;
  }
  double inv = 1.0 - t;
  return 1.0 - inv * inv * inv;
}

static double ease_in_quad(double t) {
  if (t <= 0.0) {
    return 0.0;
  }
  if (t >= 1.0) {
    return 1.0;
  }
  return t * t;
}

static void stop_animation(LauncherState *st) {
  if (st->anim_timer_id != 0) {
    g_source_remove(st->anim_timer_id);
    st->anim_timer_id = 0;
  }
  st->anim_mode = ANIM_NONE;
}

static gboolean anim_tick_cb(gpointer user_data) {
  LauncherState *st = (LauncherState *)user_data;
  gint64 now = g_get_monotonic_time();

  if (st->anim_mode == ANIM_ENTER) {
    double elapsed_ms = (double)(now - st->anim_start_us) / 1000.0;
    double win_t = elapsed_ms / (double)ENTER_DURATION_MS;
    if (win_t > 1.0) {
      win_t = 1.0;
    }
    double win_eased = ease_out_cubic(win_t);
    gtk_widget_set_opacity(st->window, win_eased);
    int dy = (int)lround((1.0 - win_eased) * 10.0);
#if LAUNCHER_USE_X11
    if (st->has_x11_pos) {
      x11_apply_window_position(st, dy, FALSE);
    }
#else
    (void)dy;
#endif

    double row_elapsed_ms = (double)(now - st->stagger_start_us) / 1000.0;
    gboolean rows_done = TRUE;
    for (int i = 0; i < st->stagger_count; i++) {
      GtkWidget *row = st->stagger_rows[i];
      if (!row) {
        continue;
      }
      double delay = (double)(i * STAGGER_STEP_MS);
      double rt = (row_elapsed_ms - delay) / (double)STAGGER_ROW_FADE_MS;
      if (rt < 1.0) {
        rows_done = FALSE;
      }
      if (rt < 0.0) {
        rt = 0.0;
      } else if (rt > 1.0) {
        rt = 1.0;
      }
      gtk_widget_set_opacity(row, ease_out_cubic(rt));
    }

    if (win_t >= 1.0 && rows_done) {
      gtk_widget_set_opacity(st->window, 1.0);
#if LAUNCHER_USE_X11
      if (st->has_x11_pos) {
        x11_apply_window_position(st, 0, FALSE);
      }
#endif
      for (int i = 0; i < st->stagger_count; i++) {
        if (st->stagger_rows[i]) {
          gtk_widget_set_opacity(st->stagger_rows[i], 1.0);
        }
      }
      st->anim_timer_id = 0;
      st->anim_mode = ANIM_NONE;
      return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
  }

  if (st->anim_mode == ANIM_EXIT) {
    double elapsed_ms = (double)(now - st->anim_start_us) / 1000.0;
    double t = elapsed_ms / (double)EXIT_DURATION_MS;
    if (t >= 1.0) {
      gtk_widget_set_opacity(st->window, 0.0);
      gtk_widget_set_visible(st->window, FALSE);
      st->is_visible = FALSE;
      st->anim_timer_id = 0;
      st->anim_mode = ANIM_NONE;
      return G_SOURCE_REMOVE;
    }
    double eased = ease_in_quad(t);
    gtk_widget_set_opacity(st->window, 1.0 - eased);
    int dy = (int)lround(eased * 6.0);
#if LAUNCHER_USE_X11
    if (st->has_x11_pos) {
      x11_apply_window_position(st, dy, FALSE);
    }
#else
    (void)dy;
#endif
    return G_SOURCE_CONTINUE;
  }

  st->anim_timer_id = 0;
  return G_SOURCE_REMOVE;
}

static void start_row_stagger(LauncherState *st) {
  st->stagger_start_us = g_get_monotonic_time();
  for (int i = 0; i < st->stagger_count; i++) {
    if (st->stagger_rows[i]) {
      gtk_widget_set_opacity(st->stagger_rows[i], 0.0);
    }
  }
  if (st->anim_mode == ANIM_NONE && st->is_visible && st->stagger_count > 0) {
    st->anim_mode = ANIM_ENTER;
    st->anim_start_us = g_get_monotonic_time() - (ENTER_DURATION_MS * 1000);
    st->anim_timer_id = g_timeout_add(ANIM_TICK_MS, anim_tick_cb, st);
  }
}

/* =========================================================================
 * List Rendering & Selection
 * ========================================================================= */

static void scroll_selected_row_into_view(LauncherState *st) {
  if (st->selected_index < 0 ||
      (guint)st->selected_index >= st->filtered->len) {
    return;
  }
  GtkListBoxRow *row =
      gtk_list_box_get_row_at_index(GTK_LIST_BOX(st->list_box), st->selected_index);
  if (!row) {
    return;
  }
  GtkAdjustment *vadj =
      gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(st->scrolled));
  if (!vadj) {
    return;
  }
  graphene_rect_t bounds;
  if (!gtk_widget_compute_bounds(GTK_WIDGET(row), st->list_box, &bounds)) {
    return;
  }
  double row_top = (double)bounds.origin.y;
  double row_bottom = row_top + (double)bounds.size.height;
  double view_top = gtk_adjustment_get_value(vadj);
  double view_height = gtk_adjustment_get_page_size(vadj);
  if (view_height <= 0.0) {
    return;
  }
  if (row_top < view_top) {
    gtk_adjustment_set_value(vadj, row_top);
  } else if (row_bottom > view_top + view_height) {
    gtk_adjustment_set_value(vadj, row_bottom - view_height);
  }
}

static void select_row_index(LauncherState *st, int idx) {
  if (st->filtered->len == 0) {
    st->selected_index = -1;
    st->syncing_selection = TRUE;
    gtk_list_box_unselect_all(GTK_LIST_BOX(st->list_box));
    st->syncing_selection = FALSE;
    return;
  }
  if (idx < 0) {
    idx = 0;
  }
  if ((guint)idx >= st->filtered->len) {
    idx = (int)st->filtered->len - 1;
  }
  st->selected_index = idx;
  GtkListBoxRow *row =
      gtk_list_box_get_row_at_index(GTK_LIST_BOX(st->list_box), idx);
  if (row) {
    st->syncing_selection = TRUE;
    gtk_list_box_select_row(GTK_LIST_BOX(st->list_box), row);
    st->syncing_selection = FALSE;
    scroll_selected_row_into_view(st);
  }
}

static void clear_list_box(LauncherState *st) {
  st->stagger_count = 0;
  memset(st->stagger_rows, 0, sizeof(st->stagger_rows));
  GtkWidget *child = gtk_widget_get_first_child(st->list_box);
  while (child) {
    GtkWidget *next = gtk_widget_get_next_sibling(child);
    gtk_list_box_remove(GTK_LIST_BOX(st->list_box), child);
    child = next;
  }
}

static void rebuild_filtered_list(LauncherState *st, gboolean animate_rows,
                                  gboolean preserve_selection) {
  char *prev_selected_id = NULL;
  if (preserve_selection && st->selected_index >= 0 &&
      (guint)st->selected_index < st->filtered->len) {
    const FilteredItem *cur = (const FilteredItem *)g_ptr_array_index(
        st->filtered, (guint)st->selected_index);
    if (cur && cur->app && cur->app->id) {
      prev_selected_id = g_strdup(cur->app->id);
    }
  }

  const char *raw_query = gtk_editable_get_text(GTK_EDITABLE(st->search_entry));
  char *q_norm = normalize_query_utf8(raw_query);

  g_ptr_array_set_size(st->filtered, 0);

  if (q_norm[0] == '\0') {
    for (guint i = 0; i < st->apps->len; i++) {
      const AppItem *app = (const AppItem *)g_ptr_array_index(st->apps, i);
      FilteredItem *fi = g_new0(FilteredItem, 1);
      fi->app = app;
      fi->score = 0;
      fi->source = MATCH_NONE;
      g_ptr_array_add(st->filtered, fi);
    }
  } else {
    glong q_len_l = 0;
    gunichar *q_runes = g_utf8_to_ucs4_fast(q_norm, -1, &q_len_l);
    if (q_runes && q_len_l > 0) {
      for (guint i = 0; i < st->apps->len; i++) {
        const AppItem *app = (const AppItem *)g_ptr_array_index(st->apps, i);
        FilteredItem *fi =
            score_app_item(app, q_norm, q_runes, (gsize)q_len_l);
        if (fi) {
          g_ptr_array_add(st->filtered, fi);
        }
      }
      g_ptr_array_sort(st->filtered, compare_filtered_items);
    }
    g_free(q_runes);
  }

  /* Update right-side header count */
  char *count_text = NULL;
  if (q_norm[0] == '\0') {
    count_text = g_strdup_printf("%u 个应用", st->apps->len);
  } else {
    count_text = g_strdup_printf("%u / %u", st->filtered->len, st->apps->len);
  }
  gtk_label_set_text(GTK_LABEL(st->count_label), count_text);
  g_free(count_text);

  clear_list_box(st);

  if (st->filtered->len == 0) {
    if (st->apps->len == 0) {
      gtk_label_set_text(GTK_LABEL(st->empty_title_label), "没有找到应用");
    } else {
      gtk_label_set_text(GTK_LABEL(st->empty_title_label), "没有匹配的应用");
    }
    gtk_stack_set_visible_child_name(GTK_STACK(st->content_stack), "empty");
    st->selected_index = -1;
    g_free(prev_selected_id);
    g_free(q_norm);
    return;
  }

  gtk_stack_set_visible_child_name(GTK_STACK(st->content_stack), "list");

  int restored_index = 0;
  gint64 now_us = g_get_monotonic_time();
  gboolean in_enter_anim = (st->anim_mode == ANIM_ENTER);
  double row_elapsed_ms = (double)(now_us - st->stagger_start_us) / 1000.0;

  for (guint i = 0; i < st->filtered->len; i++) {
    const FilteredItem *fi =
        (const FilteredItem *)g_ptr_array_index(st->filtered, i);
    if (prev_selected_id && fi->app->id &&
        strcmp(fi->app->id, prev_selected_id) == 0) {
      restored_index = (int)i;
    }

    GtkWidget *row_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    gtk_widget_set_hexpand(row_box, TRUE);
    gtk_widget_set_halign(row_box, GTK_ALIGN_FILL);
    gtk_widget_set_valign(row_box, GTK_ALIGN_CENTER);

    GtkWidget *icon_wrap = create_app_icon_widget(fi->app->icon);
    gtk_box_append(GTK_BOX(row_box), icon_wrap);

    GtkWidget *text_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 1);
    gtk_widget_set_hexpand(text_box, TRUE);
    gtk_widget_set_halign(text_box, GTK_ALIGN_FILL);
    gtk_widget_set_valign(text_box, GTK_ALIGN_CENTER);

    GtkWidget *name_lbl = gtk_label_new(NULL);
    gtk_widget_add_css_class(name_lbl, "row-name");
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_widget_set_halign(name_lbl, GTK_ALIGN_FILL);
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0f);
    gtk_label_set_ellipsize(GTK_LABEL(name_lbl), PANGO_ELLIPSIZE_END);
    char *markup = build_highlighted_name_markup(fi);
    gtk_label_set_markup(GTK_LABEL(name_lbl), markup);
    g_free(markup);
    gtk_box_append(GTK_BOX(text_box), name_lbl);

    const char *sub_str = (fi->app->subtitle && fi->app->subtitle[0] != '\0')
                              ? fi->app->subtitle
                              : (fi->app->path ? fi->app->path : "");
    GtkWidget *sub_lbl = gtk_label_new(sub_str);
    gtk_widget_add_css_class(sub_lbl, "row-subtitle");
    gtk_widget_set_hexpand(sub_lbl, TRUE);
    gtk_widget_set_halign(sub_lbl, GTK_ALIGN_FILL);
    gtk_label_set_xalign(GTK_LABEL(sub_lbl), 0.0f);
    gtk_label_set_ellipsize(GTK_LABEL(sub_lbl), PANGO_ELLIPSIZE_END);
    gtk_box_append(GTK_BOX(text_box), sub_lbl);

    gtk_box_append(GTK_BOX(row_box), text_box);

    GtkWidget *ret_lbl = gtk_label_new("↵");
    gtk_widget_add_css_class(ret_lbl, "row-return");
    gtk_widget_set_hexpand(ret_lbl, FALSE);
    gtk_widget_set_halign(ret_lbl, GTK_ALIGN_END);
    gtk_widget_set_valign(ret_lbl, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(row_box), ret_lbl);

    GtkWidget *row = gtk_list_box_row_new();
    gtk_widget_add_css_class(row, "launcher-row");
    gtk_widget_set_hexpand(row, TRUE);
    gtk_widget_set_halign(row, GTK_ALIGN_FILL);
    gtk_widget_set_focusable(row, FALSE);
    gtk_list_box_row_set_child(GTK_LIST_BOX_ROW(row), row_box);
    gtk_list_box_append(GTK_LIST_BOX(st->list_box), row);

    if (i < MAX_VISIBLE_STAGGER) {
      if (in_enter_anim) {
        /* Sync new row opacity with the in-flight entrance stagger so END
         * refresh never flashes opaque and then drops back on the next tick. */
        double delay = (double)(i * STAGGER_STEP_MS);
        double rt = (row_elapsed_ms - delay) / (double)STAGGER_ROW_FADE_MS;
        if (rt < 0.0) {
          rt = 0.0;
        } else if (rt > 1.0) {
          rt = 1.0;
        }
        gtk_widget_set_opacity(row, ease_out_cubic(rt));
      }
      st->stagger_rows[st->stagger_count++] = row;
    }
  }

  select_row_index(st, restored_index);

  if (animate_rows && st->is_visible && !in_enter_anim) {
    start_row_stagger(st);
  }
  g_free(prev_selected_id);
  g_free(q_norm);
}

/* =========================================================================
 * Open Action & Pending Hide
 * ========================================================================= */

static void cancel_pending_open(LauncherState *st) {
  if (st->pending_open_timer_id != 0) {
    g_source_remove(st->pending_open_timer_id);
    st->pending_open_timer_id = 0;
  }
  g_clear_pointer(&st->pending_open_name, g_free);
}

static gboolean pending_open_timeout_cb(gpointer user_data) {
  LauncherState *st = (LauncherState *)user_data;
  st->pending_open_timer_id = 0;
  char *msg = NULL;
  if (st->pending_open_name && st->pending_open_name[0] != '\0') {
    msg = g_strdup_printf("打开 %s 超时", st->pending_open_name);
  } else {
    msg = g_strdup("打开应用超时");
  }
  g_clear_pointer(&st->pending_open_name, g_free);
  show_inline_error(st, msg);
  g_free(msg);
  return G_SOURCE_REMOVE;
}

static void open_item_at_index(LauncherState *st, int index) {
  if (index < 0 || (guint)index >= st->filtered->len) {
    return;
  }
  const FilteredItem *fi =
      (const FilteredItem *)g_ptr_array_index(st->filtered, (guint)index);
  if (!fi || !fi->app || !fi->app->id || fi->app->id[0] == '\0') {
    return;
  }
  cancel_pending_open(st);
  st->pending_open_name = g_strdup(fi->app->name ? fi->app->name : fi->app->id);

  char *line = g_strdup_printf("open\t%s", fi->app->id);
  write_daemon_line(line);
  g_free(line);

  /* Wait for launcherd's open-ok or open-error; 8s safety timeout prevents
   * leaving pending state stuck if the daemon fails to respond. */
  st->pending_open_timer_id = g_timeout_add(
      OPEN_SAFETY_TIMEOUT_MS, pending_open_timeout_cb, st);
}

/* =========================================================================
 * Show / Hide / Toggle / Quit
 * ========================================================================= */

static void launcher_show(LauncherState *st) {
  if (st->shutting_down) {
    return;
  }
  if (st->is_visible && gtk_widget_get_visible(st->window) &&
      st->anim_mode != ANIM_EXIT) {
    st->last_show_us = g_get_monotonic_time();
    gtk_window_present(GTK_WINDOW(st->window));
#if LAUNCHER_USE_X11
    if (st->has_x11_pos) {
      x11_apply_window_position(st, 0, TRUE);
    }
#endif
    gtk_widget_grab_focus(st->search_entry);
    return;
  }
  stop_animation(st);
  cancel_pending_open(st);
  show_inline_error(st, NULL);

  gtk_editable_set_text(GTK_EDITABLE(st->search_entry), "");
  st->is_visible = TRUE;
  st->last_show_us = g_get_monotonic_time();

  rebuild_filtered_list(st, FALSE, FALSE);
  write_daemon_line("refresh");

#if LAUNCHER_USE_X11
  x11_compute_target_position(st);
#endif

  if (st->revealer) {
    if (st->has_x11_pos) {
      gtk_revealer_set_transition_duration(GTK_REVEALER(st->revealer), 0);
      gtk_revealer_set_reveal_child(GTK_REVEALER(st->revealer), TRUE);
    } else {
      gtk_revealer_set_transition_duration(GTK_REVEALER(st->revealer), 0);
      gtk_revealer_set_reveal_child(GTK_REVEALER(st->revealer), FALSE);
    }
  }

  gtk_widget_set_opacity(st->window, 0.0);
  gtk_widget_set_visible(st->window, TRUE);
  gtk_window_present(GTK_WINDOW(st->window));

#if LAUNCHER_USE_X11
  if (st->has_x11_pos) {
    x11_apply_window_position(st, 10, TRUE);
  }
#endif
  if (st->revealer && !st->has_x11_pos) {
    gtk_revealer_set_transition_duration(GTK_REVEALER(st->revealer),
                                         ENTER_DURATION_MS);
    gtk_revealer_set_reveal_child(GTK_REVEALER(st->revealer), TRUE);
  }

  gtk_widget_grab_focus(st->search_entry);

  st->anim_mode = ANIM_ENTER;
  st->anim_start_us = g_get_monotonic_time();
  st->stagger_start_us = st->anim_start_us;
  for (int i = 0; i < st->stagger_count; i++) {
    if (st->stagger_rows[i]) {
      gtk_widget_set_opacity(st->stagger_rows[i], 0.0);
    }
  }
  st->anim_timer_id = g_timeout_add(ANIM_TICK_MS, anim_tick_cb, st);
}

static void launcher_hide(LauncherState *st, gboolean notify_daemon) {
  if (!st->is_visible && st->anim_mode != ANIM_ENTER) {
    return;
  }
  if (st->anim_mode == ANIM_EXIT) {
    return;
  }
  cancel_pending_open(st);
  stop_animation(st);
  if (notify_daemon) {
    write_daemon_line("hide");
  }
  st->anim_mode = ANIM_EXIT;
  st->anim_start_us = g_get_monotonic_time();
  st->anim_timer_id = g_timeout_add(ANIM_TICK_MS, anim_tick_cb, st);
}

static void launcher_toggle(LauncherState *st) {
  if (st->is_visible && st->anim_mode != ANIM_EXIT) {
    launcher_hide(st, TRUE);
  } else {
    launcher_show(st);
  }
}

static void launcher_quit(LauncherState *st, gboolean notify_daemon) {
  if (st->shutting_down) {
    return;
  }
  st->shutting_down = TRUE;
  stop_animation(st);
  cancel_pending_open(st);
  if (st->error_timer_id != 0) {
    g_source_remove(st->error_timer_id);
    st->error_timer_id = 0;
  }
  if (notify_daemon && !st->quit_sent) {
    st->quit_sent = TRUE;
    write_daemon_line("quit");
  }
  if (st->app) {
    g_application_quit(G_APPLICATION(st->app));
  }
}

/* =========================================================================
 * Stdin Protocol Parsing
 * ========================================================================= */

static void handle_launch1_line(LauncherState *st, const char *line) {
  char **parts = g_strsplit(line, "\t", -1);
  gsize count = g_strv_length(parts);
  if (count < 8) {
    g_strfreev(parts);
    return;
  }
  AppItem *item = g_new0(AppItem, 1);
  item->id = decode_base64_utf8(parts[1]);
  item->name = decode_base64_utf8(parts[2]);
  item->subtitle = decode_base64_utf8(parts[3]);
  item->icon = decode_base64_utf8(parts[4]);
  item->kind = decode_base64_utf8(parts[5]);
  item->terminal = (strcmp(parts[6], "1") == 0);
  item->path = decode_base64_utf8(parts[7]);
  item->catalog_index = st->staging_apps->len;

  /* Optional 9th column: base64 aliases separated by ASCII US (0x1f) */
  if (count >= 9 && parts[8][0] != '\0') {
    char *decoded_aliases = decode_base64_utf8(parts[8]);
    if (decoded_aliases && decoded_aliases[0] != '\0') {
      char **alist = g_strsplit(decoded_aliases, "\x1f", -1);
      gsize alen = g_strv_length(alist);
      if (alen > 0) {
        item->aliases = g_new0(char *, alen);
        for (gsize i = 0; i < alen; i++) {
          if (alist[i][0] != '\0') {
            item->aliases[item->alias_count++] = g_strdup(alist[i]);
          }
        }
      }
      g_strfreev(alist);
    }
    g_free(decoded_aliases);
  }

  /* Optional 10th column: transient §6 frecency boost integer */
  if (count >= 10 && parts[9][0] != '\0') {
    gint64 parsed = g_ascii_strtoll(parts[9], NULL, 10);
    if (parsed > 0) {
      if (parsed > FRECENCY_BOOST_CAP) {
        parsed = FRECENCY_BOOST_CAP;
      }
      item->boost = (int)parsed;
    }
  }

  g_strfreev(parts);

  if (item->id[0] == '\0' || item->name[0] == '\0') {
    app_item_free(item);
    return;
  }
  g_ptr_array_add(st->staging_apps, item);
}

static void process_stdin_line(LauncherState *st, const char *raw_line) {
  if (!raw_line) {
    return;
  }
  gsize len = strlen(raw_line);
  while (len > 0 && (raw_line[len - 1] == '\r' || raw_line[len - 1] == '\n')) {
    len--;
  }
  char *line = g_strndup(raw_line, len);

  if (g_str_has_prefix(line, "LAUNCH1\t")) {
    handle_launch1_line(st, line);
  } else if (strcmp(line, "END") == 0) {
    GPtrArray *old = st->apps;
    st->apps = st->staging_apps;
    st->staging_apps = g_ptr_array_new_with_free_func(app_item_free);
    /* Rebuild BEFORE unreffing old apps so preserve_selection can safely read
     * the previous FilteredItem->app->id before st->filtered is replaced.
     * Keep selection at index 0 unless the user already moved down from row 0. */
    rebuild_filtered_list(st, FALSE, st->selected_index > 0);
    g_ptr_array_unref(old);
  } else if (strcmp(line, "open-ok") == 0 ||
             g_str_has_prefix(line, "open-ok\t")) {
    cancel_pending_open(st);
    launcher_hide(st, TRUE);
  } else if (g_str_has_prefix(line, "open-error\t")) {
    char *msg = decode_base64_utf8(line + strlen("open-error\t"));
    char *display_msg = NULL;
    if (st->pending_open_name && st->pending_open_name[0] != '\0') {
      if (msg && msg[0] != '\0') {
        display_msg =
            g_strdup_printf("无法打开 %s：%s", st->pending_open_name, msg);
      } else {
        display_msg = g_strdup_printf("无法打开 %s", st->pending_open_name);
      }
    } else if (msg && msg[0] != '\0') {
      display_msg = g_strdup_printf("无法打开应用：%s", msg);
    } else {
      display_msg = g_strdup("无法打开应用");
    }
    cancel_pending_open(st);
    show_inline_error(st, display_msg);
    g_free(display_msg);
    g_free(msg);
  } else if (strcmp(line, "show") == 0) {
    launcher_show(st);
  } else if (strcmp(line, "hide") == 0) {
    launcher_hide(st, TRUE);
  } else if (strcmp(line, "toggle") == 0) {
    launcher_toggle(st);
  } else if (strcmp(line, "quit") == 0) {
    launcher_quit(st, FALSE);
  }

  g_free(line);
}

static gboolean stdin_io_cb(GIOChannel *source, GIOCondition cond,
                            gpointer user_data) {
  LauncherState *st = (LauncherState *)user_data;
  if (cond & G_IO_IN) {
    char chunk[4096];
    for (;;) {
      gsize bytes_read = 0;
      GError *err = NULL;
      GIOStatus status =
          g_io_channel_read_chars(source, chunk, sizeof(chunk), &bytes_read, &err);
      if (err) {
        g_error_free(err);
      }
      if (bytes_read > 0) {
        g_string_append_len(st->stdin_buf, chunk, (gssize)bytes_read);
        char *nl = NULL;
        while ((nl = strchr(st->stdin_buf->str, '\n')) != NULL) {
          gsize line_len = (gsize)(nl - st->stdin_buf->str);
          char *line = g_strndup(st->stdin_buf->str, line_len);
          g_string_erase(st->stdin_buf, 0, (gssize)(line_len + 1));
          process_stdin_line(st, line);
          g_free(line);
          if (st->shutting_down) {
            return G_SOURCE_REMOVE;
          }
        }
      }
      if (status == G_IO_STATUS_AGAIN) {
        break;
      }
      if (status == G_IO_STATUS_EOF || status == G_IO_STATUS_ERROR) {
        launcher_quit(st, FALSE);
        return G_SOURCE_REMOVE;
      }
    }
  }
  if (cond & (G_IO_HUP | G_IO_ERR)) {
    launcher_quit(st, FALSE);
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

static void setup_stdin_watch(LauncherState *st) {
  st->stdin_buf = g_string_sized_new(1024);
  st->stdin_channel = g_io_channel_unix_new(STDIN_FILENO);
  g_io_channel_set_encoding(st->stdin_channel, NULL, NULL);
  g_io_channel_set_buffered(st->stdin_channel, FALSE);
  g_io_channel_set_flags(st->stdin_channel, G_IO_FLAG_NONBLOCK, NULL);
  st->stdin_watch_id = g_io_add_watch(
      st->stdin_channel, G_IO_IN | G_IO_HUP | G_IO_ERR, stdin_io_cb, st);
}

/* =========================================================================
 * Control Unix Socket ($AIH_LAUNCH_SOCKET)
 * ========================================================================= */

static gboolean is_owned_runtime_dir(const char *path) {
  if (!path || path[0] == '\0') {
    return FALSE;
  }
  struct stat sb;
  if (stat(path, &sb) != 0) {
    return FALSE;
  }
  return S_ISDIR(sb.st_mode) && sb.st_uid == getuid();
}

static char *resolve_socket_path(void) {
  const char *env_sock = g_getenv("AIH_LAUNCH_SOCKET");
  if (env_sock && env_sock[0] != '\0') {
    return g_strdup(env_sock);
  }
  const char *xdg_rt = g_getenv("XDG_RUNTIME_DIR");
  if (is_owned_runtime_dir(xdg_rt)) {
    return g_build_filename(xdg_rt, "aih-launch.sock", NULL);
  }
  const char *ai_home = g_getenv("AIH_HOME_DIR");
  if (ai_home && ai_home[0] != '\0') {
    return g_build_filename(ai_home, "run", "launcher", "linux",
                            "aih-launch.sock", NULL);
  }
  const char *home = g_get_home_dir();
  return g_build_filename(home, ".ai_home", "run", "launcher", "linux",
                          "aih-launch.sock", NULL);
}

typedef struct {
  LauncherState *st;
  int fd;
  GIOChannel *channel;
  guint watch_id;
  guint timeout_id;
  char buf[256];
  gsize len;
} SocketClientCtx;

static void socket_client_close(SocketClientCtx *cctx) {
  if (!cctx) {
    return;
  }
  if (cctx->timeout_id != 0) {
    g_source_remove(cctx->timeout_id);
    cctx->timeout_id = 0;
  }
  if (cctx->watch_id != 0) {
    g_source_remove(cctx->watch_id);
    cctx->watch_id = 0;
  }
  if (cctx->channel) {
    /* close_on_unref=TRUE ensures GLib closes the fd only after the GSource
     * finishes releasing its watch reference. */
    g_io_channel_unref(cctx->channel);
    cctx->channel = NULL;
    cctx->fd = -1;
  } else if (cctx->fd >= 0) {
    close(cctx->fd);
    cctx->fd = -1;
  }
  g_free(cctx);
}

static void socket_client_dispatch_and_close(SocketClientCtx *cctx) {
  LauncherState *st = cctx->st;
  cctx->buf[cctx->len] = '\0';
  g_strstrip(cctx->buf);

  int action = 0; /* 1=toggle, 2=show, 3=hide */
  const char *reply = "ok\n";
  if (strcmp(cctx->buf, "toggle") == 0) {
    action = 1;
  } else if (strcmp(cctx->buf, "show") == 0) {
    action = 2;
  } else if (strcmp(cctx->buf, "hide") == 0) {
    action = 3;
  } else if (strcmp(cctx->buf, "ping") == 0) {
    reply = "pong\n";
  } else {
    reply = "err\n";
  }

  /* Acknowledge and close the client socket BEFORE presenting GTK window so
   * first-frame GPU/Mesa initialization never causes caller read timeouts. */
  ssize_t ignored = write(cctx->fd, reply, strlen(reply));
  (void)ignored;
  socket_client_close(cctx);

  if (action == 1) {
    launcher_toggle(st);
  } else if (action == 2) {
    launcher_show(st);
  } else if (action == 3) {
    launcher_hide(st, TRUE);
  }
}

static gboolean socket_client_timeout_cb(gpointer user_data) {
  SocketClientCtx *cctx = (SocketClientCtx *)user_data;
  cctx->timeout_id = 0;
  socket_client_close(cctx);
  return G_SOURCE_REMOVE;
}

static gboolean socket_client_io_cb(GIOChannel *source, GIOCondition cond,
                                    gpointer user_data) {
  (void)source;
  SocketClientCtx *cctx = (SocketClientCtx *)user_data;
  if (cond & G_IO_IN) {
    gsize space = (sizeof(cctx->buf) - 1) - cctx->len;
    if (space > 0) {
      ssize_t n = read(cctx->fd, cctx->buf + cctx->len, space);
      if (n > 0) {
        cctx->len += (gsize)n;
        cctx->buf[cctx->len] = '\0';
        if (strchr(cctx->buf, '\n') != NULL || cctx->len >= sizeof(cctx->buf) - 1) {
          cctx->watch_id = 0;
          socket_client_dispatch_and_close(cctx);
          return G_SOURCE_REMOVE;
        }
        return G_SOURCE_CONTINUE;
      }
      if (n == 0) {
        cctx->watch_id = 0;
        if (cctx->len > 0) {
          socket_client_dispatch_and_close(cctx);
        } else {
          socket_client_close(cctx);
        }
        return G_SOURCE_REMOVE;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
        return G_SOURCE_CONTINUE;
      }
    }
  }
  cctx->watch_id = 0;
  if (cctx->len > 0) {
    socket_client_dispatch_and_close(cctx);
  } else {
    socket_client_close(cctx);
  }
  return G_SOURCE_REMOVE;
}

static gboolean socket_accept_cb(GIOChannel *source, GIOCondition cond,
                                 gpointer user_data) {
  (void)source;
  LauncherState *st = (LauncherState *)user_data;
  if (cond & (G_IO_ERR | G_IO_HUP)) {
    return G_SOURCE_REMOVE;
  }
  for (int count = 0; count < MAX_ACCEPTS_PER_TICK; count++) {
    int cfd = accept4(st->sock_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (cfd < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        break;
      }
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    SocketClientCtx *cctx = g_new0(SocketClientCtx, 1);
    cctx->st = st;
    cctx->fd = cfd;
    cctx->channel = g_io_channel_unix_new(cfd);
    g_io_channel_set_close_on_unref(cctx->channel, TRUE);
    g_io_channel_set_encoding(cctx->channel, NULL, NULL);
    g_io_channel_set_buffered(cctx->channel, FALSE);
    cctx->watch_id = g_io_add_watch(
        cctx->channel, G_IO_IN | G_IO_HUP | G_IO_ERR, socket_client_io_cb, cctx);
    cctx->timeout_id =
        g_timeout_add(SOCKET_CLIENT_TIMEOUT_MS, socket_client_timeout_cb, cctx);
  }
  return G_SOURCE_CONTINUE;
}

static void notify_existing_socket_show(const char *sock_path) {
  if (!sock_path || sock_path[0] == '\0') {
    return;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  if (strlen(sock_path) >= sizeof(addr.sun_path)) {
    return;
  }
  int cfd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (cfd < 0) {
    return;
  }
  struct timeval tv;
  tv.tv_sec = 0;
  tv.tv_usec = SOCKET_CLIENT_TIMEOUT_MS * 1000;
  if (setsockopt(cfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv)) != 0) {
    /* best effort timeout */
  }
  if (setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) != 0) {
    /* best effort timeout */
  }

  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, sock_path, sizeof(addr.sun_path) - 1);
  if (connect(cfd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
    static const char msg[] = "show\n";
    size_t total = sizeof(msg) - 1;
    size_t sent = 0;
    while (sent < total) {
      ssize_t n = send(cfd, msg + sent, total - sent, MSG_NOSIGNAL);
      if (n > 0) {
        sent += (size_t)n;
      } else if (n < 0 && errno == EINTR) {
        continue;
      } else {
        break;
      }
    }
    char reply[32];
    ssize_t rn = recv(cfd, reply, sizeof(reply), 0);
    (void)rn;
  }
  close(cfd);
}

/* Acquires exclusive non-blocking flock on <socket>.lock before any unlink/bind.
 * Returns:
 *   1 if lock acquired (st->lock_fd >= 0),
 *   0 if another instance holds the lock (best-effort show sent; caller exits 0),
 *  -1 on unexpected filesystem/lock error.
 */
static int acquire_singleton_lock(LauncherState *st) {
  st->lock_fd = -1;
  if (!st->sock_path || st->sock_path[0] == '\0') {
    st->sock_path = resolve_socket_path();
  }
  if (!st->sock_path || st->sock_path[0] == '\0') {
    return -1;
  }
  char *dir = g_path_get_dirname(st->sock_path);
  if (dir && dir[0] != '\0') {
    g_mkdir_with_parents(dir, 0700);
  }
  g_free(dir);

  char *lock_path = g_strdup_printf("%s.lock", st->sock_path);
  mode_t prev_umask = umask(0077);
  int fd = open(lock_path, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  umask(prev_umask);
  g_free(lock_path);
  if (fd < 0) {
    return -1;
  }
  if (fchmod(fd, 0600) != 0) {
    /* best effort permission tightening */
  }

  int rc = -1;
  do {
    rc = flock(fd, LOCK_EX | LOCK_NB);
  } while (rc != 0 && errno == EINTR);

  if (rc == 0) {
    st->lock_fd = fd;
    return 1;
  }

  int saved_errno = errno;
  close(fd);
  if (saved_errno == EWOULDBLOCK || saved_errno == EAGAIN) {
    notify_existing_socket_show(st->sock_path);
    return 0;
  }
  return -1;
}

static void release_singleton_lock(LauncherState *st) {
  if (st->lock_fd >= 0) {
    int fd = st->lock_fd;
    st->lock_fd = -1;
    if (flock(fd, LOCK_UN) != 0) {
      /* best effort unlock before close */
    }
    close(fd);
  }
}

static void setup_control_socket(LauncherState *st) {
  st->sock_fd = -1;
  st->sock_bound = FALSE;
  if (st->lock_fd < 0) {
    return;
  }
  if (!st->sock_path || st->sock_path[0] == '\0') {
    st->sock_path = resolve_socket_path();
  }
  if (!st->sock_path || st->sock_path[0] == '\0') {
    return;
  }
  char *dir = g_path_get_dirname(st->sock_path);
  if (dir && dir[0] != '\0') {
    g_mkdir_with_parents(dir, 0700);
  }
  g_free(dir);

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  if (strlen(st->sock_path) >= sizeof(addr.sun_path)) {
    return;
  }

  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    return;
  }

  /* Safe to unlink any stale socket path only after holding <socket>.lock. */
  unlink(st->sock_path);
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, st->sock_path, sizeof(addr.sun_path) - 1);

  mode_t prev_umask = umask(0077);
  int bind_rc = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
  umask(prev_umask);
  if (bind_rc != 0) {
    close(fd);
    return;
  }
  st->sock_bound = TRUE;
  if (chmod(st->sock_path, 0600) != 0) {
    /* best effort permission tightening */
  }
  if (listen(fd, 8) != 0) {
    close(fd);
    unlink(st->sock_path);
    st->sock_bound = FALSE;
    return;
  }

  st->sock_fd = fd;
  st->sock_channel = g_io_channel_unix_new(fd);
  st->sock_watch_id = g_io_add_watch(
      st->sock_channel, G_IO_IN | G_IO_ERR | G_IO_HUP, socket_accept_cb, st);
}

static void cleanup_control_socket(LauncherState *st) {
  if (st->sock_watch_id != 0) {
    g_source_remove(st->sock_watch_id);
    st->sock_watch_id = 0;
  }
  if (st->sock_channel) {
    g_io_channel_unref(st->sock_channel);
    st->sock_channel = NULL;
  }
  if (st->sock_fd >= 0) {
    close(st->sock_fd);
    st->sock_fd = -1;
  }
  if (st->sock_path) {
    if (st->sock_bound && st->lock_fd >= 0) {
      unlink(st->sock_path);
    }
    st->sock_bound = FALSE;
    g_clear_pointer(&st->sock_path, g_free);
  }
  release_singleton_lock(st);
}

/* =========================================================================
 * GTK Signal Callbacks
 * ========================================================================= */

static void on_search_changed(GtkEditable *editable, gpointer user_data) {
  (void)editable;
  LauncherState *st = (LauncherState *)user_data;
  rebuild_filtered_list(st, TRUE, FALSE);
}

static void on_search_stop(GtkSearchEntry *entry, gpointer user_data) {
  (void)entry;
  LauncherState *st = (LauncherState *)user_data;
  launcher_hide(st, TRUE);
}

static void on_search_activate(GtkSearchEntry *entry, gpointer user_data) {
  (void)entry;
  LauncherState *st = (LauncherState *)user_data;
  if (st->selected_index >= 0) {
    open_item_at_index(st, st->selected_index);
  }
}

static void on_list_row_selected(GtkListBox *box, GtkListBoxRow *row,
                                 gpointer user_data) {
  (void)box;
  LauncherState *st = (LauncherState *)user_data;
  if (st->syncing_selection) {
    return;
  }
  if (row) {
    st->selected_index = gtk_list_box_row_get_index(row);
  }
}

static void on_list_row_activated(GtkListBox *box, GtkListBoxRow *row,
                                  gpointer user_data) {
  (void)box;
  LauncherState *st = (LauncherState *)user_data;
  if (!row) {
    return;
  }
  int idx = gtk_list_box_row_get_index(row);
  select_row_index(st, idx);
  open_item_at_index(st, idx);
}

static gboolean on_window_key_pressed(GtkEventControllerKey *controller,
                                      guint keyval, guint keycode,
                                      GdkModifierType state,
                                      gpointer user_data) {
  (void)controller;
  (void)keycode;
  LauncherState *st = (LauncherState *)user_data;

  /* Allow Alt+Space inside the window to toggle closed even when grab wasn't active */
  if (keyval == GDK_KEY_space && (state & GDK_ALT_MASK) != 0) {
    launcher_hide(st, TRUE);
    return TRUE;
  }

  switch (keyval) {
  case GDK_KEY_Escape:
    launcher_hide(st, TRUE);
    return TRUE;
  case GDK_KEY_Down:
  case GDK_KEY_KP_Down:
    if (st->filtered->len > 0) {
      int next = st->selected_index + 1;
      if ((guint)next >= st->filtered->len) {
        next = (int)st->filtered->len - 1;
      }
      select_row_index(st, next);
    }
    return TRUE;
  case GDK_KEY_Up:
  case GDK_KEY_KP_Up:
    if (st->filtered->len > 0) {
      int prev = st->selected_index - 1;
      if (prev < 0) {
        prev = 0;
      }
      select_row_index(st, prev);
    }
    return TRUE;
  case GDK_KEY_Return:
  case GDK_KEY_KP_Enter:
    if (st->selected_index >= 0) {
      open_item_at_index(st, st->selected_index);
    }
    return TRUE;
  default:
    return FALSE;
  }
}

static void on_window_active_changed(GObject *obj, GParamSpec *pspec,
                                     gpointer user_data) {
  (void)pspec;
  LauncherState *st = (LauncherState *)user_data;
  if (!st->is_visible || st->anim_mode == ANIM_EXIT) {
    return;
  }
  gboolean active = gtk_window_is_active(GTK_WINDOW(obj));
  if (!active) {
    gint64 now = g_get_monotonic_time();
    if (now - st->last_show_us >= FOCUS_GRACE_US) {
      launcher_hide(st, TRUE);
    }
  }
}

static gboolean on_unix_signal(gpointer user_data) {
  LauncherState *st = (LauncherState *)user_data;
  launcher_quit(st, TRUE);
  return G_SOURCE_REMOVE;
}

/* =========================================================================
 * UI Construction
 * ========================================================================= */

static GtkWidget *build_kbd_hint(const char *key_text, const char *desc_text) {
  GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 5);
  GtkWidget *kbd = gtk_label_new(key_text);
  gtk_widget_add_css_class(kbd, "launcher-kbd");
  GtkWidget *desc = gtk_label_new(desc_text);
  gtk_widget_add_css_class(desc, "launcher-kbd-label");
  gtk_box_append(GTK_BOX(box), kbd);
  gtk_box_append(GTK_BOX(box), desc);
  return box;
}

static void apply_css_theme(void) {
  GtkCssProvider *provider = gtk_css_provider_new();
#if GTK_CHECK_VERSION(4, 12, 0)
  gtk_css_provider_load_from_string(provider, LAUNCHER_CSS);
#else
  gtk_css_provider_load_from_data(provider, LAUNCHER_CSS, -1);
#endif
  GdkDisplay *display = gdk_display_get_default();
  if (display) {
    gtk_style_context_add_provider_for_display(
        display, GTK_STYLE_PROVIDER(provider),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
  }
  g_object_unref(provider);
}

static void build_window(LauncherState *st) {
  apply_css_theme();

  st->window = gtk_application_window_new(st->app);
  gtk_widget_add_css_class(st->window, "launcher-window");
  gtk_window_set_title(GTK_WINDOW(st->window), "AIH Launch");
  gtk_window_set_decorated(GTK_WINDOW(st->window), FALSE);
  gtk_window_set_resizable(GTK_WINDOW(st->window), FALSE);
  gtk_window_set_default_size(GTK_WINDOW(st->window), PANEL_WIDTH, PANEL_HEIGHT);
  gtk_window_set_hide_on_close(GTK_WINDOW(st->window), TRUE);

  st->frame = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_widget_add_css_class(st->frame, "launcher-frame");
  gtk_widget_set_size_request(st->frame, PANEL_WIDTH, PANEL_HEIGHT);
  gtk_widget_set_overflow(st->frame, GTK_OVERFLOW_HIDDEN);

  st->revealer = gtk_revealer_new();
  gtk_revealer_set_transition_type(GTK_REVEALER(st->revealer),
                                   GTK_REVEALER_TRANSITION_TYPE_SLIDE_DOWN);
  gtk_revealer_set_transition_duration(GTK_REVEALER(st->revealer),
                                       ENTER_DURATION_MS);
  gtk_revealer_set_reveal_child(GTK_REVEALER(st->revealer), TRUE);
  gtk_revealer_set_child(GTK_REVEALER(st->revealer), st->frame);
  gtk_window_set_child(GTK_WINDOW(st->window), st->revealer);

  /* Header: eyebrow + result count */
  GtkWidget *header = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
  gtk_widget_add_css_class(header, "launcher-header");

  GtkWidget *dot = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_add_css_class(dot, "launcher-eyebrow-dot");
  gtk_widget_set_valign(dot, GTK_ALIGN_CENTER);
  gtk_box_append(GTK_BOX(header), dot);

  GtkWidget *eyebrow = gtk_label_new("AIH LAUNCH");
  gtk_widget_add_css_class(eyebrow, "launcher-eyebrow");
  gtk_widget_set_hexpand(eyebrow, TRUE);
  gtk_label_set_xalign(GTK_LABEL(eyebrow), 0.0f);
  gtk_box_append(GTK_BOX(header), eyebrow);

  st->count_label = gtk_label_new("0 个应用");
  gtk_widget_add_css_class(st->count_label, "launcher-count");
  gtk_box_append(GTK_BOX(header), st->count_label);

  gtk_box_append(GTK_BOX(st->frame), header);

  /* Search Row */
  GtkWidget *search_wrap = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_add_css_class(search_wrap, "launcher-search-wrap");

  st->search_entry = gtk_search_entry_new();
  gtk_widget_add_css_class(st->search_entry, "launcher-search");
  gtk_widget_set_hexpand(st->search_entry, TRUE);
#if GTK_CHECK_VERSION(4, 10, 0)
  gtk_search_entry_set_placeholder_text(GTK_SEARCH_ENTRY(st->search_entry),
                                        "搜索应用…");
#else
  g_object_set(st->search_entry, "placeholder-text", "搜索应用…", NULL);
#endif
#if GTK_CHECK_VERSION(4, 8, 0)
  gtk_search_entry_set_search_delay(GTK_SEARCH_ENTRY(st->search_entry), 0);
#endif
  gtk_box_append(GTK_BOX(search_wrap), st->search_entry);
  gtk_box_append(GTK_BOX(st->frame), search_wrap);

  /* Inline error line (no large Alert container) */
  st->inline_error_label = gtk_label_new("");
  gtk_widget_add_css_class(st->inline_error_label, "launcher-inline-error");
  gtk_label_set_xalign(GTK_LABEL(st->inline_error_label), 0.0f);
  gtk_label_set_ellipsize(GTK_LABEL(st->inline_error_label),
                          PANGO_ELLIPSIZE_END);
  gtk_widget_set_visible(st->inline_error_label, FALSE);
  gtk_box_append(GTK_BOX(st->frame), st->inline_error_label);

  /* Content stack: list vs compact inline empty state */
  st->content_stack = gtk_stack_new();
  gtk_widget_set_hexpand(st->content_stack, TRUE);
  gtk_widget_set_vexpand(st->content_stack, TRUE);
  gtk_widget_set_halign(st->content_stack, GTK_ALIGN_FILL);
  gtk_stack_set_transition_type(GTK_STACK(st->content_stack),
                                GTK_STACK_TRANSITION_TYPE_NONE);

  st->scrolled = gtk_scrolled_window_new();
  gtk_widget_add_css_class(st->scrolled, "launcher-scroll");
  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(st->scrolled),
                                 GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
  gtk_widget_set_hexpand(st->scrolled, TRUE);
  gtk_widget_set_vexpand(st->scrolled, TRUE);
  gtk_widget_set_halign(st->scrolled, GTK_ALIGN_FILL);

  st->list_box = gtk_list_box_new();
  gtk_widget_add_css_class(st->list_box, "launcher-list");
  gtk_widget_set_hexpand(st->list_box, TRUE);
  gtk_widget_set_halign(st->list_box, GTK_ALIGN_FILL);
  gtk_list_box_set_selection_mode(GTK_LIST_BOX(st->list_box),
                                  GTK_SELECTION_SINGLE);
  gtk_list_box_set_activate_on_single_click(GTK_LIST_BOX(st->list_box), TRUE);
  gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(st->scrolled),
                                st->list_box);
  gtk_stack_add_named(GTK_STACK(st->content_stack), st->scrolled, "list");

  GtkWidget *empty_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
  gtk_widget_set_halign(empty_box, GTK_ALIGN_CENTER);
  gtk_widget_set_valign(empty_box, GTK_ALIGN_CENTER);
  st->empty_title_label = gtk_label_new("没有找到应用");
  gtk_widget_add_css_class(st->empty_title_label, "launcher-empty-title");
  GtkWidget *empty_hint = gtk_label_new("输入应用名称、缩写或路径关键词");
  gtk_widget_add_css_class(empty_hint, "launcher-empty-hint");
  gtk_box_append(GTK_BOX(empty_box), st->empty_title_label);
  gtk_box_append(GTK_BOX(empty_box), empty_hint);
  gtk_stack_add_named(GTK_STACK(st->content_stack), empty_box, "empty");

  gtk_box_append(GTK_BOX(st->frame), st->content_stack);

  /* Footer kbd hints */
  GtkWidget *footer = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 4);
  gtk_widget_add_css_class(footer, "launcher-footer");
  gtk_box_append(GTK_BOX(footer), build_kbd_hint("↑↓", "选择"));
  gtk_box_append(GTK_BOX(footer), build_kbd_hint("↵", "打开"));
  gtk_box_append(GTK_BOX(footer), build_kbd_hint("Esc", "关闭"));
  gtk_box_append(GTK_BOX(footer), build_kbd_hint("Alt+Space", "切换"));

  GtkWidget *spacer = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  gtk_widget_set_hexpand(spacer, TRUE);
  gtk_box_append(GTK_BOX(footer), spacer);

  st->status_note_label = gtk_label_new("");
  gtk_widget_add_css_class(st->status_note_label, "launcher-status-note");
  gtk_label_set_ellipsize(GTK_LABEL(st->status_note_label),
                          PANGO_ELLIPSIZE_END);
  gtk_widget_set_visible(st->status_note_label, FALSE);
  gtk_box_append(GTK_BOX(footer), st->status_note_label);

  gtk_box_append(GTK_BOX(st->frame), footer);

  /* Connect UI signals */
  g_signal_connect(st->search_entry, "changed", G_CALLBACK(on_search_changed),
                   st);
  g_signal_connect(st->search_entry, "stop-search", G_CALLBACK(on_search_stop),
                   st);
  if (g_signal_lookup("activate", GTK_TYPE_SEARCH_ENTRY) != 0) {
    g_signal_connect(st->search_entry, "activate",
                     G_CALLBACK(on_search_activate), st);
  }
  g_signal_connect(st->list_box, "row-selected",
                   G_CALLBACK(on_list_row_selected), st);
  g_signal_connect(st->list_box, "row-activated",
                   G_CALLBACK(on_list_row_activated), st);
  g_signal_connect(st->window, "notify::is-active",
                   G_CALLBACK(on_window_active_changed), st);

  /* Bubble-phase key controller lets IME handle Esc/Return/Arrows while
   * composing, and catches them when IME does not consume them. */
  GtkEventController *key_ctrl = gtk_event_controller_key_new();
  gtk_event_controller_set_propagation_phase(key_ctrl, GTK_PHASE_BUBBLE);
  g_signal_connect(key_ctrl, "key-pressed", G_CALLBACK(on_window_key_pressed),
                   st);
  gtk_widget_add_controller(st->window, key_ctrl);
}

static void on_app_activate(GtkApplication *app, gpointer user_data) {
  (void)app;
  LauncherState *st = (LauncherState *)user_data;
  if (st->window) {
    return;
  }

  /* Keep GTK main loop alive while launcher panel stays hidden in background */
  g_application_hold(G_APPLICATION(st->app));

  build_window(st);
  setup_stdin_watch(st);
  setup_control_socket(st);
#if LAUNCHER_USE_X11
  x11_setup_hotkey(st);
#endif

  g_unix_signal_add(SIGINT, on_unix_signal, st);
  g_unix_signal_add(SIGTERM, on_unix_signal, st);

  /* Request initial catalog immediately on startup (§8.4) */
  write_daemon_line("refresh");
}

/* =========================================================================
 * Entry Point
 * ========================================================================= */

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;

  signal(SIGPIPE, SIG_IGN);

  /* Force X11 GDK backend when DISPLAY is present so XGrabKey works cleanly */
  const char *display_env = g_getenv("DISPLAY");
  if (display_env && display_env[0] != '\0') {
    g_setenv("GDK_BACKEND", "x11", TRUE);
  }

  LauncherState st;
  memset(&st, 0, sizeof(st));
  st.lock_fd = -1;
  st.sock_fd = -1;
  st.sock_bound = FALSE;
  st.selected_index = -1;

  st.sock_path = resolve_socket_path();
  int lock_rc = acquire_singleton_lock(&st);
  if (lock_rc == 0) {
    g_clear_pointer(&st.sock_path, g_free);
    return 0;
  }
  if (lock_rc < 0) {
    fprintf(stderr, "aih-launch-ui: failed to acquire singleton lock for %s\n",
            st.sock_path ? st.sock_path : "(null)");
    g_clear_pointer(&st.sock_path, g_free);
    return 1;
  }

  st.apps = g_ptr_array_new_with_free_func(app_item_free);
  st.staging_apps = g_ptr_array_new_with_free_func(app_item_free);
  st.filtered = g_ptr_array_new_with_free_func(filtered_item_free);

  st.app = gtk_application_new("dev.aih.launch.ui", G_APPLICATION_NON_UNIQUE);
  g_signal_connect(st.app, "activate", G_CALLBACK(on_app_activate), &st);

  int exit_code = g_application_run(G_APPLICATION(st.app), 0, NULL);

  stop_animation(&st);
  cancel_pending_open(&st);
  if (st.error_timer_id != 0) {
    g_source_remove(st.error_timer_id);
    st.error_timer_id = 0;
  }
#if LAUNCHER_USE_X11
  x11_cleanup_hotkey(&st);
#endif
  cleanup_control_socket(&st);
  if (st.stdin_watch_id != 0) {
    g_source_remove(st.stdin_watch_id);
    st.stdin_watch_id = 0;
  }
  if (st.stdin_channel) {
    g_io_channel_unref(st.stdin_channel);
    st.stdin_channel = NULL;
  }
  if (st.stdin_buf) {
    g_string_free(st.stdin_buf, TRUE);
    st.stdin_buf = NULL;
  }
  g_ptr_array_unref(st.filtered);
  g_ptr_array_unref(st.staging_apps);
  g_ptr_array_unref(st.apps);
  g_object_unref(st.app);

  return exit_code;
}

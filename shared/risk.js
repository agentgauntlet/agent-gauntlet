// Weighted risk scoring. Replaces the binary hard/soft system with a
// 0–100 score; the score determines an action (allow / step_up / block).
// Tunable: bump weights, change tier thresholds.

const SIGNAL_WEIGHTS = {
  // ---- HTTP-header signals ----
  no_user_agent:                   90,
  headless_in_ua:                  85,
  non_browser_http_client:         90,
  no_accept_language:              10,
  no_accept_encoding:              10,
  chrome_ua_missing_client_hints:  15,

  // ---- TLS / JA3 signals ----
  zero_ciphers:                    80,
  few_ciphers:                     15,
  no_sni:                          25,
  no_alpn:                         20,
  unusual_alpn:                    15,
  no_grease:                       15,
  no_supported_versions:           20,
  no_signature_algorithms:         15,

  // ---- Browser environment fingerprint ----
  no_fingerprint_object:           80,
  navigator_webdriver:             80,
  headless_chrome_notif_mismatch:  70,
  zero_screen:                     80,
  software_webgl_renderer:         15,
  webgl_missing:                   20,
  zero_plugins_desktop_chrome:     15,
  chrome_object_missing:           20,
  default_headless_viewport:       25,
  no_canvas_hash:                  20,
  no_audio_hash:                   15,
  raf_unthrottled:                 20,

  // ---- Behavioral telemetry ----
  too_fast:                        25,
  low_mouse_activity:              25,
  low_mouse_entropy:               20,
  no_scroll_low_activity:          15,
  synthetic_click_dwell:           60,
  uniform_mouse_velocity:          50,
  straight_line_cursor:            50,
  synthetic_scroll_pattern:        40,
  superhuman_reaction_time:        60,
  uniform_keystroke_timing:        30,

  // ---- Challenge / state-machine failures ----
  // These also indicate failure to reason; weight high because each is a
  // direct, observed wrong action.
  honeypot_filled:                100,
  clicked_decoy_step1:            100,
  wrong_item_step1:               100,
  wrong_shipping_step2:           100,
  clicked_recommended_decoy:      100,
  unknown_button:                  80,
  stepup_failed:                   90,
};

// Tunable thresholds.
const THRESHOLDS = {
  STEP_UP: 30,
  BLOCK:   70,
};

function computeRisk(signals) {
  let raw = 0;
  const breakdown = [];
  for (const sig of signals || []) {
    const w = SIGNAL_WEIGHTS[sig];
    if (w == null) {
      // Unknown signal — small penalty so we notice in logs.
      breakdown.push({ signal: sig, weight: 5 });
      raw += 5;
    } else {
      breakdown.push({ signal: sig, weight: w });
      raw += w;
    }
  }
  const score = Math.min(100, raw);
  let tier, action;
  if (score >= THRESHOLDS.BLOCK) {
    tier = 'high'; action = 'block';
  } else if (score >= THRESHOLDS.STEP_UP) {
    tier = 'medium'; action = 'step_up';
  } else {
    tier = 'low'; action = 'allow';
  }
  return { score, raw, tier, action, breakdown };
}

module.exports = { SIGNAL_WEIGHTS, THRESHOLDS, computeRisk };

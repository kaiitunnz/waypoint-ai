const modes = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
];
const entry = (
  id: string,
  transport: string,
  transportCaps: Record<string, boolean>,
  agentCaps: Record<string, unknown> = {},
) => ({
  id,
  label: id,
  transport_id: transport,
  default_transport: transport,
  supported_transports: [transport],
  agent_capabilities: { permission_modes: modes, ...agentCaps },
  transport_capabilities: { is_structured: true, ...transportCaps },
});
export const metadataWire = {
  authenticated: true,
  default_backend: "codex",
  launch_targets: [{ id: "box", name: "Box", supported_backends: ["codex"] }],
  backends: [
    {
      ...entry(
        "codex",
        "codex_app_server",
        {
          supports_set_model_inline: true,
          supports_set_effort_inline: true,
          supports_set_permission_mode_inline: true,
        },
        { supports_custom_cli_args: true, supports_config_overrides: true },
      ),
      supported_transports: ["codex_app_server", "tmux"],
    },
    {
      ...entry(
        "claude_code",
        "claude_cli",
        {
          supports_set_model_inline: true,
          supports_set_effort_with_restart: true,
          supports_set_permission_mode_inline: true,
        },
        { supports_custom_cli_args: true },
      ),
      supported_transports: ["claude_cli", "claude_tty", "tmux"],
    },
    entry("claude_tty", "claude_tty", {
      supports_set_model_with_restart: true,
      supports_set_effort_with_restart: true,
      supports_set_permission_mode_with_restart: true,
      settings_change_interrupts_turn: true,
    }),
    entry("opencode", "opencode_http", {
      supports_set_model_inline: true,
      supports_set_effort_inline: true,
      supports_set_permission_mode_inline: true,
    }),
    entry("tmux", "tmux", { is_structured: false, live_terminal: true }),
  ],
};
export const option = (id: string) => ({
  id,
  supports_launch_settings_with_restart: true,
  supports_account_profile_with_restart: true,
  supports_custom_args: true,
  supports_config_overrides: true,
});
export const launchWire = (overrides: Record<string, unknown> = {}) => ({
  backend: "codex",
  transport: "codex_app_server",
  launch_target_id: null,
  account_profile_id: "work",
  account_profile_label: "Work",
  account_profiles: [
    { id: "work", label: "Work", config_dir_key: "w" },
    { id: "home", label: "Home", config_dir_key: "h" },
  ],
  args: ["--fast"],
  config_overrides: [],
  launch_env_keys: ["API_TOKEN", "CODEX_HOME", "WAYPOINT_SESSION_ID"],
  protected_launch_env_keys: ["WAYPOINT_SESSION_ID", "CODEX_HOME"],
  config_dir_env_var: "CODEX_HOME",
  supports_custom_args: true,
  supports_config_overrides: true,
  supports_account_profile_with_restart: true,
  supports_launch_settings_with_restart: true,
  transport_options: [option("codex_app_server"), option("tmux")],
  supports_transport_switch_with_restart: true,
  requires_restart: true,
  ...overrides,
});
export const sessionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "s1",
  backend: "codex",
  transport: "codex_app_server",
  source: "managed",
  title: "Garden",
  cwd: "/work/garden",
  status: "idle",
  last_event_at: "2026-10-25T00:00:00Z",
  model: "gpt-a",
  resolved_model: "gpt-a-2026",
  effort: "low",
  permission_mode: "default",
  account_profile_id: "work",
  account_profile_label: "Work",
  usage_limit_source: "plugin",
  args: ["--fast"],
  config_overrides: [],
  launch_target_id: null,
  ...overrides,
});

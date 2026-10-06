# Color standard zsh prompts without replacing user-defined prompt layouts.
# Dedicated indexed colors let xterm apply theme changes to existing prompts.
function _nexus_color_prompt() {
  emulate -L zsh
  case "$PROMPT" in
    '%n@%m %1~ %# ' | '%n@%m %~ %# ' | '%m%# ')
      # Keep brace-containing color escapes outside parameter substitutions.
      local username='%F{252}%n%f' hostname='%F{253}%m%f'
      local short_directory='%F{254}%1~%f' directory='%F{254}%~%f'
      local symbol='%F{255}%#%f'
      if [[ -n "$NEXUS_SPOOF_USER_HOST" ]]; then
        # Settings validation limits this to literal hostname-safe characters.
        username="%F{252}${NEXUS_SPOOF_USER_HOST%@*}%f"
        hostname="%F{253}${NEXUS_SPOOF_USER_HOST#*@}%f"
      fi
      PROMPT="${PROMPT//'%n'/$username}"
      PROMPT="${PROMPT//'%m'/$hostname}"
      PROMPT="${PROMPT//'%1~'/$short_directory}"
      PROMPT="${PROMPT//'%~'/$directory}"
      PROMPT="${PROMPT//'%#'/$symbol}"
      ;;
  esac
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _nexus_color_prompt
_nexus_color_prompt

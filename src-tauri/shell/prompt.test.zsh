#!/bin/zsh -f
export TERM=xterm-256color
PROMPT='%n@%m %1~ %# '
source "${0:A:h}/prompt.zsh"
expected='%F{252}%n%f@%F{253}%m%f %F{254}%1~%f %F{255}%#%f '
[[ "$PROMPT" == "$expected" ]] || { print -u2 -r -- "$PROMPT"; exit 1; }
# Repeated prompt draws must not nest escape sequences.
_nexus_color_prompt
[[ "$PROMPT" == "$expected" ]] || exit 1
PROMPT='custom %n: %~ > '
_nexus_color_prompt
[[ "$PROMPT" == 'custom %n: %~ > ' ]] || exit 1
PROMPT='%n@%m %~ %# '
_nexus_color_prompt
[[ "$PROMPT" == '%F{252}%n%f@%F{253}%m%f %F{254}%~%f %F{255}%#%f ' ]] || exit 1
# ANSI escapes must not count toward the displayed prompt width.
rendered=$(print -P -- "$PROMPT")
[[ "$rendered" == *$'\e[38;5;252m'* && "$rendered" == *$'\e[38;5;255m'* ]] || exit 1
print 'Prompt coloring tests passed'

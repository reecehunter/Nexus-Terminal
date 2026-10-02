# Use ANSI palette colors so theme edits update highlighting without shell restarts.
# An installed syntax highlighter remains authoritative.
if (( ! $+functions[_zsh_highlight] && ! $+functions[_fast_highlight] )); then
  autoload -Uz add-zle-hook-widget
  typeset -ga _nexus_highlight_regions
  function _nexus_highlight() {
    emulate -L zsh
    setopt extendedglob
    local token word style region
    local -i offset=0 start end command_position=1 redirect_target=0
    local -a tokens retained
    # Remove only our previous entries, preserving autosuggestions and other widgets.
    for region in "${region_highlight[@]}"; do
      (( ${_nexus_highlight_regions[(Ie)$region]} )) || retained+=("$region")
    done
    region_highlight=("${retained[@]}")
    _nexus_highlight_regions=()
    (( ${#BUFFER} > 16384 )) && return
    tokens=("${(@z)BUFFER}")
    for token in "${tokens[@]}"; do
      # The tokenizer can yield an empty token while the command line is blank.
      [[ -z "$token" ]] && continue
      # Locate the exact token without evaluating command substitutions or globs.
      start=$offset
      while (( start + ${#token} <= ${#BUFFER} )) && [[ "${BUFFER[$((start + 1)),$((start + ${#token}))]}" != "$token" ]]; do
        # zsh's tokenizer represents a command-separating newline as a semicolon.
        [[ "$token" == ';' && "${BUFFER[$((start + 1))]}" == $'\n' ]] && break
        (( start++ ))
      done
      end=$((start + ${#token}))
      (( end > ${#BUFFER} )) && continue
      offset=$end
      word="${(Q)token}"
      style=''
      if [[ "$token" == ('|'|'||'|'&&'|';'|'&'|'('|')') ]]; then
        style='fg=magenta'
        command_position=1
      elif [[ "$token" == ('>'|'>>'|'<'|'<<'|'<<<'|'>&'|'<&') ]]; then
        style='fg=magenta'
        redirect_target=1
      elif (( redirect_target )); then
        style='fg=cyan'
        redirect_target=0
      elif (( command_position )) && [[ "$token" == [A-Za-z_][A-Za-z0-9_]#=* ]]; then
        style='fg=magenta'
      elif (( command_position )); then
        # Empty quoted commands are invalid; never use them as array subscripts.
        # reswords is an indexed array, so match its values instead of evaluating
        # user input as an arithmetic subscript.
        if [[ -n "$word" ]] && { (( $+commands[$word] || $+builtins[$word] || $+aliases[$word] || $+functions[$word] || ${reswords[(Ie)$word]} )) || [[ -x "$word" && ! -d "$word" ]]; }; then
          style='fg=green'
        else
          style='fg=red'
        fi
        # Command wrappers leave the next word in command position.
        [[ "$word" == (sudo|command|builtin|exec|noglob) ]] || command_position=0
      elif [[ "$token" == [\"\']* ]]; then
        style='fg=yellow'
      elif [[ "$token" == -* ]]; then
        style='fg=blue'
      elif [[ "$token" == *'$'* ]]; then
        style='fg=magenta'
      elif [[ -e "$word" || "$token" == ('./'*|'../'*|'/'*|'~/'*) ]]; then
        style='fg=cyan'
      fi
      if [[ -n "$style" ]]; then
        region="$start $end $style"
        region_highlight+=("$region")
        _nexus_highlight_regions+=("$region")
      fi
    done
  }
  add-zle-hook-widget line-pre-redraw _nexus_highlight
fi

# Honor NO_COLOR and existing user aliases. Color only when stdout is a terminal.
if [[ -z ${NO_COLOR+x} ]] && (( ! $+aliases[ls] && ! $+functions[ls] )); then
  if [[ "$OSTYPE" == darwin* ]]; then
    alias ls='ls -G'
  else
    alias ls='ls --color=auto'
  fi
fi

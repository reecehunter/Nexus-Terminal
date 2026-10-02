#!/bin/zsh -f
# Run with /bin/zsh -f src-tauri/shell/highlight.test.zsh.
source "${0:A:h}/highlight.zsh"
function assert_region() {
  if (( ! ${region_highlight[(Ie)$1]} )); then
    print -u2 -- "Missing region: $1; got: ${(j:; :)region_highlight}"
    exit 1
  fi
}
BUFFER='echo --help "hello world" | cat /tmp'
region_highlight=('0 1 bold')
_nexus_highlight
assert_region '0 4 fg=green'
assert_region '5 11 fg=blue'
assert_region '12 25 fg=yellow'
assert_region '26 27 fg=magenta'
assert_region '28 31 fg=green'
assert_region '32 36 fg=cyan'
assert_region '0 1 bold'
# A redraw must replace old entries without duplicating them.
_nexus_highlight
(( ${#region_highlight} == 7 )) || exit 1
BUFFER='nexus_nonexistent_command --flag'
_nexus_highlight
assert_region '0 25 fg=red'
assert_region '26 32 fg=blue'
BUFFER='echo "λ🙂" && printf "%s" *.txt > /tmp/result'
_nexus_highlight
assert_region '5 9 fg=yellow'
assert_region '10 12 fg=magenta'
assert_region '13 19 fg=green'
BUFFER='FOO=bar echo $HOME'
_nexus_highlight
assert_region '0 7 fg=magenta'
assert_region '8 12 fg=green'
assert_region '13 18 fg=magenta'
# Highlighting must never execute user input.
BUFFER='echo $(print NEXUS_HIGHLIGHT_EXECUTED >&2)'
_nexus_highlight
BUFFER='echo "unfinished'
_nexus_highlight
BUFFER='echo first
printf second'
_nexus_highlight
assert_region '11 17 fg=green'
# Blank prompts and empty quoted command names previously raised math errors.
for BUFFER in '' '   ' '""' "''" '1+' 'if'; do
  errors=$(_nexus_highlight 2>&1)
  [[ -z "$errors" ]] || { print -u2 -- "$errors"; exit 1; }
done
BUFFER=''
region_highlight=()
_nexus_highlight
(( ${#region_highlight} == 0 )) || exit 1
BUFFER='if'
_nexus_highlight
assert_region '0 2 fg=green'
print 'Syntax highlighting tests passed'

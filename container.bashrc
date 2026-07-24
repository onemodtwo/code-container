# container.bashrc — Runtime shell environment for code-container
# Mounted at /etc/container.bashrc; edits take effect without rebuild.

# --- Colored prompt ---
__container_prompt() {
  local reset='\[\033[0m\]'
  local green='\[\033[0;32m\]'
  local yellow='\[\033[0;33m\]'
  local blue='\[\033[0;34m\]'
  local cyan='\[\033[0;36m\]'

  local dir="${yellow}\w${reset}"
  local branch=""
  if git rev-parse --is-inside-work-tree &>/dev/null; then
    local b
    b=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    if [[ -n "$b" ]]; then
      branch=" ${cyan}(${b})${reset}"
    fi
  fi
  PS1="[container] ${dir}${branch} \$ "
}
__container_prompt

# --- Aliases ---
alias l='ls --color=auto'
alias la='ls -A --color=auto'
alias ll='ls -alF --color=auto'
alias lg='ls -alF --color=auto | grep -i'
alias lt='ls -ltr --color=auto'
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# --- Environment activation helpers ---
act() {
  local activated=0
  if [[ -n "$PENV_PATH" && -d "$PENV_PATH" ]]; then
    if [[ -f "$PENV_PATH/bin/activate" ]]; then
      source "$PENV_PATH/bin/activate"
      echo "Activated Python environment: $PENV_PATH"
      activated=1
    fi
  fi
  if [[ -n "$RENV_PATH" && -d "$RENV_PATH" ]]; then
    if [[ -f "$RENV_PATH/bin/activate" ]]; then
      source "$RENV_PATH/bin/activate"
      echo "Activated R environment: $RENV_PATH"
      activated=1
    fi
  fi
  if [[ $activated -eq 0 ]]; then
    echo "No environment found. Set PENV_PATH or RENV_PATH in config.json."
  fi
}

deact() {
  if type deactivate &>/dev/null; then
    deactivate
    echo "Environment deactivated."
  else
    echo "No active environment to deactivate."
  fi
}

# Also alias 'quit' to 'deact'
alias quit='deact'

# --- SSH agent forwarding ---
if [[ -n "$SSH_AUTH_SOCK" ]]; then
  export SSH_AUTH_SOCK="$SSH_AUTH_SOCK"
fi

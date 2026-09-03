#!/bin/sh
# Git asks for the username first and the password second. Answering from the
# environment keeps the token out of the remote URL, out of .git/config, and out
# of the process arguments of every git command the app runs.
case "$1" in
  *Username*) printf '%s\n' "${CONTROL_CENTER_GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s\n' "${CONTROL_CENTER_GIT_TOKEN:-}" ;;
esac

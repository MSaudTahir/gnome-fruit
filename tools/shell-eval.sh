#!/usr/bin/env bash
# Evaluates JavaScript in the headless test shell (source DIR/env first).
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell \
    -m org.gnome.Shell.Eval "$1"

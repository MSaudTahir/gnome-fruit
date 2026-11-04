UUID := gnome-fruit@msaudtahir
SRC := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall pack test clean

all: schemas

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

install: schemas
	rm -rf $(DEST)
	mkdir -p $(dir $(DEST))
	cp -r $(SRC) $(DEST)
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(DEST)

pack:
	gnome-extensions pack --force --extra-source=dock.js --extra-source=stageManager.js \
		--extra-source=windowEffects.js --extra-source=launchpad.js --extra-source=spaces.js \
		--extra-source=backdrop.js --extra-source=spotlight.js --extra-source=menubar.js --extra-source=forceQuit.js --extra-source=hotCorners.js --extra-source=launcherEntries.js --extra-source=windowActions.js --extra-source=showDesktop.js --extra-source=appExpose.js --extra-source=missionControl.js --extra-source=tiling.js --extra-source=lockGuard.js --extra-source=folderStack.js --extra-source=icons $(SRC)

# Runs a throwaway headless GNOME Shell with the extension enabled and
# prints any errors it logs. Does not touch your running session.
test: schemas
	./tools/headless-test.sh

clean:
	rm -f $(SRC)/schemas/gschemas.compiled $(UUID).shell-extension.zip

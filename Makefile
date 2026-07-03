ENV86 := ./env86/env86

.PHONY: all tool image www serve boot clean

all: tool image www

# Build the env86 CLI and its assets (v86 wasm, 32-bit kernel, guest agent)
tool:
	$(MAKE) -C env86 all

# Build the minimal guest image from guest/Dockerfile
image:
	rm -rf vm
	$(ENV86) create --from-docker=./guest/Dockerfile ./vm

# Generate static files for running the VM in a browser tab
www:
	rm -rf www
	$(ENV86) prepare ./vm www
	sed -i '' 's|const vm = await env86.boot|const vm = window.vm = await env86.boot|' www/index.html

# Serve the browser build locally
serve:
	cd www && python3 -m http.server 8086

# Boot locally in a terminal (serial console, no window)
boot:
	$(ENV86) boot --ttyS0 --no-console ./vm

clean:
	rm -rf vm www

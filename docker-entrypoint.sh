#!/bin/bash
set -e

# Warn if the RANCHER_METADATA_HOST socket does not exist
if [[ $RANCHER_METADATA_HOST == http://* ]]; then
	host=${DOCKER_HOST#unix://}
	if ! [ -S $socket_file ]; then
		cat >&2 <<-EOT
			ERROR: you need to share your Docker host socket with a volume at $socket_file
			Typically you should run your oorabona/nginx-rancher-rp with: \`-e RANCHER_METADATA_HOST=http://rancher-metadata/`
			See the documentation at http://github.com/agefos-pme/dockerfiles/nginx-rancher-rp
		EOT
		hostMissing=1
	fi
fi

# If the user has run the default command and the socket doesn't exist, fail
if [ "$hostMissing" = 1 ]; then
	exit 1
fi

exec "$@"
